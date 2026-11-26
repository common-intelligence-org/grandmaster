# SPRT gauntlet (`tools/sprt`)

One command scores a candidate engine against the pinned baseline on the pinned balanced book, using fastchess, and prints a JSON verdict (`TASK-GM-P1-03`).

| File | Purpose |
|---|---|
| `sprt.py` | Runner (stdlib-only Python 3.9+): `fetch-book`, `bench`, `run`, `analyze` |
| `book-manifest.json` | `UHO_Lichess_4852_v1` pinned to `official-stockfish/books@426eca4` with SHA-256 of the archive and EPD (CC0-1.0, 2,632,036 positions) |
| `baseline.json` | Pinned baseline commit and its bench signature (`bench 3` = 14,524 nodes) |
| `fastchess.json` | Pinned fastchess release (v1.8.3-alpha) and asset SHA-256s |
| `test_sprt.py` | Unit tests for the statistics, PGN pairing and manifests |
| `sprt-workflow.template.yml` | GitHub Actions template (inactive; maintainers may copy it into `.github/workflows/`) |

## Quick start

```sh
# needs: node >= 22, python >= 3.9, fastchess (pinned release, see fastchess.json)
export FASTCHESS=/path/to/fastchess
python3 tools/sprt/sprt.py fetch-book     # downloads 43 MB, verifies SHA-256, caches in .sprt-cache/

# Candidate = your working tree, baseline = tools/sprt/baseline.json, non-regression bounds [0, 2]:
python3 tools/sprt/sprt.py run --concurrency 4 --out result.json

# Candidate from a commit, architecture bounds [0, 5]:
python3 tools/sprt/sprt.py run --candidate-ref my-branch --bounds architecture

# Any UCI engine binaries:
python3 tools/sprt/sprt.py run --candidate "./new-engine" --baseline "./old-engine"

# Deterministic bench signature; exits non-zero on mismatch:
python3 tools/sprt/sprt.py bench --expect 14524

# Recompute a verdict from an existing PGN:
python3 tools/sprt/sprt.py analyze games.pgn
```

Output (abridged):

```json
{
  "accepted": true, "verdict": "H1", "score": 0.88298, "elo": 346.84, "elo_ci95": [249.02, 524.46],
  "llr": 3.073, "llr_bounds": [-2.944, 2.944], "fastchess_llr": 3.07,
  "sprt": {"elo0": 0.0, "elo1": 50.0, "alpha": 0.05, "beta": 0.05, "model": "logistic"},
  "wdl": [39, 5, 3], "games": 47, "pentanomial": [0, 0, 3, 5, 15],
  "book": {"sha256": "7a7f6470..."}, "candidate": {...}, "baseline": {...}, "seed": 4852
}
```

Exit code: `0` = H1 accepted, `1` = H0 (rejected), `3` = Inconclusive (game cap reached), `2` = setup error. `accepted` is true **only** for H1. Per the challenge rules, Inconclusive is never a verified gain.

## Protocol

- **Pairs:** each opening is played twice with colours reversed (`-repeat`); openings are drawn from the pinned EPD in random order with a fixed `-srand` seed (default 4852).
- **Limit:** fixed depth (default 3) for both engines makes every game reproducible: the same command replays the same games. With `--concurrency` > 1, the last one or two games in flight when a bound is crossed can differ between runs, so W/D/L at the stopping point may differ by a game. In local checks the verdict and LLR were unchanged. Use `--concurrency 1` for byte-identical output. `--tc` is available, but wall-clock games are not reproducible.
- **Adjudication (fixed):** draw after move 40 if \|score\| ≤ 10 cp for 8 moves; two-sided resign at ≥ 600 cp for 3 moves; draw at 200 moves.
- **Statistic:** GSPRT on game-pair (pentanomial) outcomes with logistic Elo hypotheses. The empirical pair-score distribution is projected by maximum likelihood onto means L(elo0) and L(elo1). LLR = N·Σ pᵢ log(q1ᵢ/q0ᵢ), with empty buckets regularized to 1e-3. This is the statistic fastchess `model=logistic` reports; the runner recomputes it from the PGN and reports both (`llr`, `fastchess_llr`).
- **Bounds:** `nonregression` = [0, 2] and `architecture` = [0, 5], with α = β = 0.05 → LLR bounds ±2.944.

## Limitations

- With [0, 2] bounds the LLR can grow by at most about 0.006 per pair, so even a very strong change needs about 500 pairs (1,000+ games) to conclude. Budget CI time accordingly.
- The book (43 MB zip / 175 MB EPD) is downloaded and verified rather than committed, because it is over the repository's 10 MB file limit.
- Depth-limited matches measure search/eval quality at equal depth, not speed. A pure NPS optimization needs `--tc`, or a nodes-based comparison with a fixed-node limit, to be credited.
- The CI workflow is a template only. Activating it under `.github/` needs maintainer review.
