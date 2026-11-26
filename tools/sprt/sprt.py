#!/usr/bin/env python3
"""Reproducible SPRT gauntlet runner for Project Grandmaster.

Standard library only (Python 3.9+). Subcommands:

  fetch-book   download the pinned UHO_Lichess_4852_v1 book and verify SHA-256
  bench        run an engine's deterministic `bench <depth>` and report nodes
  run          play a fixed-book fastchess SPRT, candidate vs. pinned baseline
  analyze      recompute the SPRT verdict from an existing PGN

`run` and `analyze` print one JSON object, e.g.
  {"accepted": true, "verdict": "H1", "score": 0.61, "elo": 77.7, "llr": 2.97, ...}

`accepted` is true only when the test reaches H1 (the candidate is better
than elo0 with the configured error rates). Hitting --max-games before
either bound is reported as "Inconclusive" and is never accepted.

Exit codes: 0 accepted (H1), 1 rejected (H0), 3 inconclusive, 2 usage/setup error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
DEFAULT_CACHE = REPO / ".sprt-cache"
UCI_ENTRY = Path("packages/grandmaster-engine/src/uci-cli.ts")

# Bound presets from the challenge's verification rules (join.txt section 3).
BOUND_PRESETS = {
    "nonregression": (0.0, 2.0),  # non-regression / search pruning
    "architecture": (0.0, 5.0),  # architecture / NNUE upgrade (plus dataset audit)
}

# Fixed adjudication so every run uses the same game rules.
ADJUDICATION = [
    "-draw", "movenumber=40", "movecount=8", "score=10",
    "-resign", "movecount=3", "score=600", "twosided=true",
    "-maxmoves", "200",
]

PAIR_SCORES = (0.0, 0.25, 0.5, 0.75, 1.0)
# Pseudo-count used for empty pentanomial buckets so the likelihoods stay
# finite (e.g. identical deterministic engines produce only one bucket).
PENTA_REGULARIZATION = 1e-3


class SetupError(Exception):
    pass


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------


def logistic_score(elo: float) -> float:
    return 1.0 / (1.0 + 10.0 ** (-elo / 400.0))


def score_to_elo(score: float) -> float:
    if score <= 0.0:
        return -math.inf
    if score >= 1.0:
        return math.inf
    return -400.0 * math.log10(1.0 / score - 1.0)


def sprt_bounds(alpha: float, beta: float) -> tuple[float, float]:
    return math.log(beta / (1.0 - alpha)), math.log((1.0 - beta) / alpha)


def penta_stats(penta: list[float]) -> tuple[float, float, float]:
    """Return (pairs, mean pair score, per-pair variance)."""
    n = sum(penta)
    if n <= 0:
        return 0.0, 0.5, 0.0
    mean = sum(c * x for c, x in zip(penta, PAIR_SCORES)) / n
    var = sum(c * (x - mean) ** 2 for c, x in zip(penta, PAIR_SCORES)) / n
    return n, mean, var


def mle_with_mean(probs: list[float], target: float) -> list[float]:
    """Maximum-likelihood distribution on PAIR_SCORES with expected value
    `target`, relative to the empirical distribution `probs`:
        q_i = p_i / (1 + x * (a_i - target)),  sum_i q_i * (a_i - target) = 0.
    The left side is strictly decreasing in x, so solve by bisection on the
    interval where every denominator stays positive."""
    d = [a - target for a in PAIR_SCORES]
    hi_d, lo_d = max(d), min(d)
    lo = -1.0 / hi_d if hi_d > 0 else -1e12
    hi = -1.0 / lo_d if lo_d < 0 else 1e12
    eps = 1e-12

    def f(x: float) -> float:
        return sum(p * di / (1.0 + x * di) for p, di in zip(probs, d))

    a, b = lo + eps * (hi - lo), hi - eps * (hi - lo)
    for _ in range(200):
        mid = 0.5 * (a + b)
        if f(mid) > 0:
            a = mid
        else:
            b = mid
    x = 0.5 * (a + b)
    q = [p / (1.0 + x * di) for p, di in zip(probs, d)]
    s = sum(q)
    return [v / s for v in q]


def llr_logistic(penta: list[int], elo0: float, elo1: float) -> float:
    """Generalized SPRT log-likelihood ratio on game-pair (pentanomial)
    outcomes with logistic Elo hypotheses (the same statistic as fastchess
    `model=logistic`): the empirical pair-score distribution is projected by
    maximum likelihood onto mean L(elo0) and mean L(elo1), and
        LLR = N * sum_i p_i * log(q1_i / q0_i).
    Empty buckets are regularized to PENTA_REGULARIZATION."""
    if sum(penta) == 0:
        return 0.0
    reg = [c if c > 0 else PENTA_REGULARIZATION for c in penta]
    n = sum(reg)
    p = [c / n for c in reg]
    q0 = mle_with_mean(p, logistic_score(elo0))
    q1 = mle_with_mean(p, logistic_score(elo1))
    return n * sum(pi * math.log(b / a) for pi, a, b in zip(p, q0, q1))


def elo_estimate(penta: list[int]) -> dict:
    n, mean, var = penta_stats([float(c) for c in penta])
    if n == 0:
        return {"elo": 0.0, "elo_ci95": [None, None]}
    se = math.sqrt(var / n) if n > 1 else 0.0
    lo, hi = mean - 1.959964 * se, mean + 1.959964 * se

    def fin(x: float):
        return None if math.isinf(x) else round(x, 2)

    return {"elo": fin(score_to_elo(mean)), "elo_ci95": [fin(score_to_elo(lo)), fin(score_to_elo(hi))]}


def verdict(llr: float, lower: float, upper: float) -> str:
    if llr >= upper:
        return "H1"
    if llr <= lower:
        return "H0"
    return "Inconclusive"


# ---------------------------------------------------------------------------
# PGN parsing
# ---------------------------------------------------------------------------

TAG_RE = re.compile(r'^\[(\w+)\s+"((?:[^"\\]|\\.)*)"\]\s*$')


@dataclass
class Game:
    tags: dict = field(default_factory=dict)

    @property
    def result(self) -> str:
        return self.tags.get("Result", "*")


def parse_pgn(text: str) -> list[Game]:
    games: list[Game] = []
    cur: Game | None = None
    in_moves = False
    for raw in text.splitlines():
        line = raw.strip()
        m = TAG_RE.match(line)
        if m:
            if cur is None or in_moves:
                cur = Game()
                games.append(cur)
                in_moves = False
            cur.tags[m.group(1)] = m.group(2)
        elif line and cur is not None:
            in_moves = True
    return games


def candidate_points(game: Game, candidate: str) -> float | None:
    """Points scored by `candidate` in this game, or None if unfinished."""
    r = game.result
    if r not in ("1-0", "0-1", "1/2-1/2"):
        return None
    white = game.tags.get("White") == candidate
    black = game.tags.get("Black") == candidate
    if not (white or black):
        raise SetupError(f"engine {candidate!r} did not play game {game.tags}")
    if r == "1/2-1/2":
        return 0.5
    return 1.0 if (r == "1-0") == white else 0.0


def tally(games: list[Game], candidate: str) -> dict:
    """W/D/L and pentanomial counts from the candidate's point of view.
    Games are paired by Round tag (fastchess -repeat plays both colours of
    an opening in one round); falls back to consecutive pairs by FEN."""
    finished = [(g, candidate_points(g, candidate)) for g in games]
    finished = [(g, p) for g, p in finished if p is not None]
    w = sum(1 for _, p in finished if p == 1.0)
    d = sum(1 for _, p in finished if p == 0.5)
    l = sum(1 for _, p in finished if p == 0.0)

    groups: dict[str, list[float]] = {}
    for g, p in finished:
        key = g.tags.get("Round") or ("fen:" + g.tags.get("FEN", ""))
        groups.setdefault(key, []).append(p)
    if any(len(v) > 2 for v in groups.values()):  # Round tags not per-pair: use FEN
        groups = {}
        for g, p in finished:
            groups.setdefault("fen:" + g.tags.get("FEN", ""), []).append(p)

    penta = [0, 0, 0, 0, 0]
    unpaired = 0
    for pts in groups.values():
        while len(pts) >= 2:
            a, b = pts.pop(0), pts.pop(0)
            penta[int(round((a + b) * 2))] += 1
        unpaired += len(pts)
    return {"wdl": [w, d, l], "games": w + d + l, "pentanomial": penta, "unpaired_games": unpaired}


def summarize(games: list[Game], candidate: str, elo0: float, elo1: float, alpha: float, beta: float) -> dict:
    t = tally(games, candidate)
    w, d, l = t["wdl"]
    lower, upper = sprt_bounds(alpha, beta)
    llr = llr_logistic(t["pentanomial"], elo0, elo1)
    v = verdict(llr, lower, upper)
    score = (w + 0.5 * d) / t["games"] if t["games"] else 0.5
    return {
        "accepted": v == "H1",
        "verdict": v,
        "score": round(score, 5),
        **elo_estimate(t["pentanomial"]),
        "llr": round(llr, 3),
        "llr_bounds": [round(lower, 3), round(upper, 3)],
        "sprt": {"elo0": elo0, "elo1": elo1, "alpha": alpha, "beta": beta, "model": "logistic", "statistic": "pentanomial-gsprt-mle"},
        **t,
    }


# ---------------------------------------------------------------------------
# Files, book, engines
# ---------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_json(name: str) -> dict:
    return json.loads((HERE / name).read_text(encoding="utf-8"))


def fetch_book(cache: Path, quiet: bool = False) -> Path:
    manifest = load_json("book-manifest.json")
    cache.mkdir(parents=True, exist_ok=True)
    epd = cache / manifest["book"]["file"]
    if epd.exists() and sha256_file(epd) == manifest["book"]["sha256"]:
        return epd
    archive = cache / Path(manifest["source"]["path"]).name
    if not (archive.exists() and sha256_file(archive) == manifest["archive"]["sha256"]):
        if not quiet:
            print(f"downloading {manifest['source']['url']}", file=sys.stderr)
        tmp = archive.with_suffix(".part")
        with urllib.request.urlopen(manifest["source"]["url"], timeout=600) as r, open(tmp, "wb") as f:
            shutil.copyfileobj(r, f)
        got = sha256_file(tmp)
        if got != manifest["archive"]["sha256"]:
            tmp.unlink(missing_ok=True)
            raise SetupError(f"book archive SHA-256 mismatch: {got}")
        tmp.replace(archive)
    with zipfile.ZipFile(archive) as z:
        z.extract(manifest["book"]["file"], cache)
    got = sha256_file(epd)
    if got != manifest["book"]["sha256"]:
        raise SetupError(f"book SHA-256 mismatch: {got}")
    return epd


def git(*args: str) -> str:
    return subprocess.run(["git", "-C", str(REPO), *args], check=True, capture_output=True, text=True).stdout.strip()


def worktree_for(ref: str, cache: Path) -> Path:
    sha = git("rev-parse", "--verify", ref + "^{commit}")
    wt = cache / "worktrees" / sha
    if not (wt / UCI_ENTRY).exists():
        wt.parent.mkdir(parents=True, exist_ok=True)
        if wt.exists():
            shutil.rmtree(wt)
        git("worktree", "add", "--detach", "--force", str(wt), sha)
    return wt


def node_engine(root: Path) -> list[str]:
    node = shutil.which("node")
    if not node:
        raise SetupError("node (>= 22) not found on PATH")
    return [node, "--experimental-strip-types", str(root / UCI_ENTRY)]


def split_cmd(cmd: str) -> list[str]:
    parts = shlex.split(cmd, posix=os.name != "nt")
    parts = [p.strip('"') for p in parts]
    exe = shutil.which(parts[0]) or parts[0]
    return [exe, *parts[1:]]


@dataclass
class EngineSpec:
    name: str
    argv: list[str]
    source: str
    commit: str | None = None


def resolve_engine(name: str, cmd: str | None, ref: str | None, cache: Path, default_ref: str | None) -> EngineSpec:
    if cmd:
        return EngineSpec(name, split_cmd(cmd), "command")
    if ref is None and default_ref is None:
        try:
            commit = git("rev-parse", "HEAD")
            dirty = bool(git("status", "--porcelain", "--", "packages"))
        except subprocess.CalledProcessError:
            commit, dirty = None, False
        return EngineSpec(name, node_engine(REPO), "working-tree" + ("+uncommitted" if dirty else ""), commit)
    ref = ref or default_ref
    wt = worktree_for(ref, cache)
    return EngineSpec(name, node_engine(wt), f"git:{ref}", git("rev-parse", ref + "^{commit}"))


def fastchess_path(explicit: str | None) -> str:
    cand = explicit or os.environ.get("FASTCHESS") or shutil.which("fastchess")
    if not cand:
        raise SetupError("fastchess not found: pass --fastchess PATH or set FASTCHESS (pinned release in tools/sprt/fastchess.json)")
    return cand


def run_bench(engine: EngineSpec, depth: int) -> dict:
    out = subprocess.run(engine.argv, input=f"bench {depth}\nquit\n", capture_output=True, text=True, timeout=600).stdout
    m = re.search(r"bench depth (\d+): (\d+) nodes in (\d+)ms", out)
    if not m:
        raise SetupError(f"engine did not answer bench: {out[-300:]!r}")
    return {"depth": int(m.group(1)), "nodes": int(m.group(2)), "ms": int(m.group(3))}


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def add_sprt_args(p: argparse.ArgumentParser) -> None:
    p.add_argument("--bounds", choices=sorted(BOUND_PRESETS), default="nonregression",
                   help="elo0/elo1 preset from the challenge rules (default: nonregression = [0, 2])")
    p.add_argument("--elo0", type=float, help="override H0 Elo")
    p.add_argument("--elo1", type=float, help="override H1 Elo")
    p.add_argument("--alpha", type=float, default=0.05)
    p.add_argument("--beta", type=float, default=0.05)


def sprt_params(a: argparse.Namespace) -> tuple[float, float, float, float]:
    elo0, elo1 = BOUND_PRESETS[a.bounds]
    elo0 = a.elo0 if a.elo0 is not None else elo0
    elo1 = a.elo1 if a.elo1 is not None else elo1
    if not elo1 > elo0:
        raise SetupError("elo1 must be greater than elo0")
    return elo0, elo1, a.alpha, a.beta


def emit(result: dict, out: str | None) -> int:
    text = json.dumps(result, indent=2)
    print(text)
    if out:
        Path(out).write_text(text + "\n", encoding="utf-8")
    return {"H1": 0, "H0": 1}.get(result.get("verdict"), 3)


def cmd_fetch_book(a: argparse.Namespace) -> int:
    epd = fetch_book(Path(a.cache))
    print(json.dumps({"book": str(epd), "sha256": sha256_file(epd)}, indent=2))
    return 0


def cmd_bench(a: argparse.Namespace) -> int:
    eng = resolve_engine("engine", a.engine, a.ref, Path(a.cache), None)
    res = run_bench(eng, a.depth)
    if a.expect is not None and res["nodes"] != a.expect:
        print(json.dumps({**res, "ok": False, "expected": a.expect}, indent=2))
        return 1
    print(json.dumps({**res, "ok": True, "source": eng.source, "commit": eng.commit}, indent=2))
    return 0


def cmd_analyze(a: argparse.Namespace) -> int:
    elo0, elo1, alpha, beta = sprt_params(a)
    games = parse_pgn(Path(a.pgn).read_text(encoding="utf-8", errors="replace"))
    return emit({**summarize(games, a.candidate_name, elo0, elo1, alpha, beta), "pgn": a.pgn}, a.out)


def cmd_run(a: argparse.Namespace) -> int:
    elo0, elo1, alpha, beta = sprt_params(a)
    cache = Path(a.cache)
    fc = fastchess_path(a.fastchess)
    book = (Path(a.book) if a.book else fetch_book(cache)).resolve()
    baseline_default = load_json("baseline.json")["ref"]
    cand = resolve_engine("candidate", a.candidate, a.candidate_ref, cache, None)
    base = resolve_engine("baseline", a.baseline, a.baseline_ref, cache, baseline_default)

    if a.max_games < 2 or a.max_games % 2:
        raise SetupError("--max-games must be an even number >= 2")
    pgn = (Path(a.pgn) if a.pgn else Path(tempfile.mkdtemp(prefix="sprt-")) / "games.pgn").resolve()
    pgn.parent.mkdir(parents=True, exist_ok=True)
    pgn.unlink(missing_ok=True)

    limit = [f"tc={a.tc}"] if a.tc else [f"depth={a.depth}"]

    def engine_args(e: EngineSpec, depth_override: int | None) -> list[str]:
        opts = [f"cmd={e.argv[0]}", f"name={e.name}"]
        if len(e.argv) > 1:
            opts.append("args=" + " ".join(e.argv[1:]))
        if depth_override is not None:
            opts.append(f"depth={depth_override}")
        return ["-engine", *opts]

    argv = [
        fc,
        *engine_args(cand, a.candidate_depth),
        *engine_args(base, a.baseline_depth),
        "-each", "proto=uci", *([] if (a.candidate_depth and a.baseline_depth and not a.tc) else limit),
        "-openings", f"file={book}", "format=epd", "order=random",
        "-srand", str(a.seed),
        "-rounds", str(a.max_games // 2), "-repeat",
        "-concurrency", str(a.concurrency),
        "-sprt", f"elo0={elo0}", f"elo1={elo1}", f"alpha={alpha}", f"beta={beta}", "model=logistic",
        "-report", "penta=true",
        "-pgnout", f"file={pgn}", "notation=san",
        *ADJUDICATION,
    ]
    print("+ " + " ".join(shlex.quote(x) for x in argv), file=sys.stderr)
    # fastchess autosaves its state to ./config.json; keep that out of the repo.
    workdir = pgn.parent
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace", cwd=workdir)
    fc_llr = None
    tail: list[str] = []
    assert proc.stdout is not None
    for line in proc.stdout:
        if not a.quiet:
            sys.stderr.write(line)
        tail = (tail + [line.rstrip()])[-20:]
        m = re.search(r"LLR:\s*(-?\d+(?:\.\d+)?)", line)
        if m:
            fc_llr = float(m.group(1))
    rc = proc.wait()
    if not pgn.exists():
        raise SetupError(f"fastchess exited {rc} without writing a PGN:\n" + "\n".join(tail))

    games = parse_pgn(pgn.read_text(encoding="utf-8", errors="replace"))
    result = summarize(games, "candidate", elo0, elo1, alpha, beta)
    result.update({
        "fastchess_llr": fc_llr,
        "fastchess_exit_code": rc,
        "limit": {"tc": a.tc} if a.tc else {"depth": a.depth, "candidate_depth": a.candidate_depth, "baseline_depth": a.baseline_depth},
        "max_games": a.max_games,
        "seed": a.seed,
        "concurrency": a.concurrency,
        "adjudication": " ".join(ADJUDICATION),
        "book": {"file": str(book), "sha256": sha256_file(book) if a.verify_book else load_json("book-manifest.json")["book"]["sha256"]},
        "candidate": {"source": cand.source, "commit": cand.commit, "cmd": cand.argv},
        "baseline": {"source": base.source, "commit": base.commit, "cmd": base.argv},
        "fastchess": {"path": fc, "pinned_release": load_json("fastchess.json")["release"]},
        "platform": f"{platform.system()} {platform.machine()} python {platform.python_version()}",
        "pgn": str(pgn),
    })
    return emit(result, a.out)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cache", default=str(DEFAULT_CACHE), help="cache dir for the book and baseline worktrees")
    sub = ap.add_subparsers(dest="command", required=True)

    p = sub.add_parser("fetch-book", help="download + verify the pinned opening book")
    p.set_defaults(func=cmd_fetch_book)

    p = sub.add_parser("bench", help="deterministic engine bench (node count)")
    p.add_argument("--engine", help="engine command line (default: working tree)")
    p.add_argument("--ref", help="git ref of the engine to bench")
    p.add_argument("--depth", type=int, default=3)
    p.add_argument("--expect", type=int, help="fail unless the node count equals this")
    p.set_defaults(func=cmd_bench)

    p = sub.add_parser("run", help="play a fixed-book SPRT with fastchess")
    p.add_argument("--fastchess", help="path to fastchess (or set FASTCHESS)")
    p.add_argument("--candidate", help="candidate engine command line (default: working tree)")
    p.add_argument("--candidate-ref", help="git ref to build the candidate from")
    p.add_argument("--baseline", help="baseline engine command line (default: tools/sprt/baseline.json ref)")
    p.add_argument("--baseline-ref", help="git ref to build the baseline from")
    p.add_argument("--depth", type=int, default=3, help="fixed search depth per move (default 3; deterministic)")
    p.add_argument("--candidate-depth", type=int, help="depth override for the candidate only")
    p.add_argument("--baseline-depth", type=int, help="depth override for the baseline only")
    p.add_argument("--tc", help="time control instead of fixed depth, e.g. 10+0.1 (not deterministic)")
    p.add_argument("--max-games", type=int, default=10000)
    p.add_argument("--concurrency", type=int, default=1)
    p.add_argument("--seed", type=int, default=4852)
    p.add_argument("--book", help="opening book EPD (default: fetch + verify the pinned book)")
    p.add_argument("--verify-book", action="store_true", help="re-hash the book file for the report")
    p.add_argument("--pgn", help="PGN output path")
    p.add_argument("--out", help="also write the JSON result here")
    p.add_argument("--quiet", action="store_true", help="do not echo fastchess output")
    add_sprt_args(p)
    p.set_defaults(func=cmd_run)

    p = sub.add_parser("analyze", help="recompute the SPRT verdict from a PGN")
    p.add_argument("pgn")
    p.add_argument("--candidate-name", default="candidate")
    p.add_argument("--out")
    add_sprt_args(p)
    p.set_defaults(func=cmd_analyze)

    a = ap.parse_args(argv)
    try:
        return a.func(a)
    except SetupError as e:
        print(json.dumps({"accepted": False, "verdict": "Error", "error": str(e)}, indent=2))
        return 2


if __name__ == "__main__":
    sys.exit(main())
