"""Unit tests for tools/sprt/sprt.py (stdlib unittest, no network, no engines).

Run:  python3 -m unittest discover -s tools/sprt -p "test_*.py" -v
"""

import io
import json
import math
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sprt  # noqa: E402


def pgn_game(rnd: str, white: str, black: str, result: str, fen: str = "8/8/8/8/8/8/8/K6k w - - 0 1") -> str:
    return (
        f'[Event "t"]\n[Round "{rnd}"]\n[White "{white}"]\n[Black "{black}"]\n'
        f'[Result "{result}"]\n[SetUp "1"]\n[FEN "{fen}"]\n\n1. e4 e5 {result}\n\n'
    )


class EloMath(unittest.TestCase):
    def test_logistic_round_trip(self):
        for elo in (-400, -50, 0, 2, 5, 190.85, 600):
            self.assertAlmostEqual(sprt.score_to_elo(sprt.logistic_score(elo)), elo, places=6)
        self.assertAlmostEqual(sprt.score_to_elo(0.75), 190.849, places=2)
        self.assertEqual(sprt.score_to_elo(1.0), math.inf)

    def test_bounds(self):
        lo, hi = sprt.sprt_bounds(0.05, 0.05)
        self.assertAlmostEqual(lo, -2.944, places=3)
        self.assertAlmostEqual(hi, 2.944, places=3)

    def test_mle_projection_has_target_mean(self):
        p = [0.05, 0.2, 0.4, 0.25, 0.1]
        for target in (0.4, 0.5, 0.5029, 0.6):
            q = sprt.mle_with_mean(p, target)
            self.assertAlmostEqual(sum(q), 1.0, places=9)
            self.assertAlmostEqual(sum(a * b for a, b in zip(q, sprt.PAIR_SCORES)), target, places=7)

    def test_llr_signs(self):
        # With [0, 2] bounds the per-pair LLR is capped (~0.0058), so even a
        # very strong result needs > 500 pairs to reach the H1 bound.
        strong = [0, 20, 200, 500, 280]
        self.assertLess(sprt.llr_logistic([0, 2, 20, 50, 28], 0, 2), 0.6)
        weak = list(reversed(strong))
        self.assertGreater(sprt.llr_logistic(strong, 0, 2), 2.944)
        self.assertLess(sprt.llr_logistic(weak, 0, 2), -2.944)
        # Only even pairs (identical deterministic engines): drifts to H0.
        self.assertLess(sprt.llr_logistic([0, 0, 600, 0, 0], 0, 2), -2.944)
        self.assertEqual(sprt.llr_logistic([0, 0, 0, 0, 0], 0, 2), 0.0)

    def test_llr_matches_fastchess(self):
        # fastchess v1.8.3-alpha model=logistic reported LLR 0.01 for this result.
        self.assertAlmostEqual(sprt.llr_logistic([0, 0, 0, 1, 1], 0, 2), 0.011, places=3)

    def test_verdict(self):
        self.assertEqual(sprt.verdict(3.0, -2.94, 2.94), "H1")
        self.assertEqual(sprt.verdict(-3.0, -2.94, 2.94), "H0")
        self.assertEqual(sprt.verdict(0.5, -2.94, 2.94), "Inconclusive")


class PgnTally(unittest.TestCase):
    PGN = (
        pgn_game("1", "candidate", "baseline", "1-0", "fenA")
        + pgn_game("1", "baseline", "candidate", "1/2-1/2", "fenA")
        + pgn_game("2", "candidate", "baseline", "0-1", "fenB")
        + pgn_game("2", "baseline", "candidate", "0-1", "fenB")
        + pgn_game("3", "candidate", "baseline", "*", "fenC")
    )

    def test_parse_and_tally(self):
        games = sprt.parse_pgn(self.PGN)
        self.assertEqual(len(games), 5)
        t = sprt.tally(games, "candidate")
        self.assertEqual(t["wdl"], [2, 1, 1])
        self.assertEqual(t["games"], 4)
        # round 1: 1 + 0.5 -> 0.75 bucket; round 2: 0 + 1 -> 0.5 bucket
        self.assertEqual(t["pentanomial"], [0, 0, 1, 1, 0])
        self.assertEqual(t["unpaired_games"], 0)

    def test_fen_fallback_when_rounds_are_not_pairs(self):
        pgn = "".join(
            pgn_game("1", w, b, r, f)
            for w, b, r, f in [
                ("candidate", "baseline", "1-0", "x"),
                ("baseline", "candidate", "0-1", "x"),
                ("candidate", "baseline", "0-1", "y"),
            ]
        )
        t = sprt.tally(sprt.parse_pgn(pgn), "candidate")
        self.assertEqual(t["pentanomial"], [0, 0, 0, 0, 1])
        self.assertEqual(t["unpaired_games"], 1)

    def test_unknown_engine_is_an_error(self):
        with self.assertRaises(sprt.SetupError):
            sprt.tally(sprt.parse_pgn(pgn_game("1", "a", "b", "1-0")), "candidate")

    def test_analyze_cli(self):
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "g.pgn"
            path.write_text(self.PGN, encoding="utf-8")
            buf = io.StringIO()
            with redirect_stdout(buf):
                rc = sprt.main(["analyze", str(path)])
            out = json.loads(buf.getvalue())
        self.assertEqual(rc, 3)  # inconclusive
        self.assertFalse(out["accepted"])
        self.assertEqual(out["verdict"], "Inconclusive")
        self.assertEqual(out["llr_bounds"], [-2.944, 2.944])
        self.assertEqual(out["sprt"]["elo1"], 2.0)

    def test_bound_presets(self):
        buf = io.StringIO()
        with tempfile.TemporaryDirectory() as d:
            path = Path(d) / "g.pgn"
            path.write_text(self.PGN, encoding="utf-8")
            with redirect_stdout(buf):
                sprt.main(["analyze", str(path), "--bounds", "architecture"])
        self.assertEqual(json.loads(buf.getvalue())["sprt"]["elo1"], 5.0)


class Manifests(unittest.TestCase):
    def test_manifests_are_pinned(self):
        book = sprt.load_json("book-manifest.json")
        self.assertEqual(book["name"], "UHO_Lichess_4852_v1")
        self.assertRegex(book["source"]["commit"], r"^[0-9a-f]{40}$")
        self.assertIn(book["source"]["commit"], book["source"]["url"])
        for h in (book["archive"]["sha256"], book["book"]["sha256"]):
            self.assertRegex(h, r"^[0-9a-f]{64}$")
        fc = sprt.load_json("fastchess.json")
        for asset in fc["assets"].values():
            self.assertRegex(asset["sha256"], r"^[0-9a-f]{64}$")
        base = sprt.load_json("baseline.json")
        self.assertRegex(base["ref"], r"^[0-9a-f]{40}$")


if __name__ == "__main__":
    unittest.main()
