import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBaselineExperiment } from './benchmark.ts';

const report = runBaselineExperiment({ gamesCount: 8, engineDepth: 3, seed: 20261126 });
const outPath = resolve(import.meta.dirname, './baseline-report.json');
await writeFile(outPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

process.stdout.write(
  `Grandmaster-CI v${report.engineVersion} baseline complete:\n` +
    `  Perft checks passed: ${report.perftChecks.filter((p) => p.passed).length}/${report.perftChecks.length}\n` +
    `  Bench: ${report.benchNodes} nodes in ${report.benchTimeMs}ms (${report.benchNps} nps)\n` +
    `  Match vs ${report.matchSummary.opponent}: ${report.matchSummary.wins}W-${report.matchSummary.draws}D-${report.matchSummary.losses}L ` +
    `(${report.matchSummary.scorePct}%, ${report.matchSummary.eloDiff >= 0 ? '+' : ''}${report.matchSummary.eloDiff} Elo -> ${report.matchSummary.estimatedElo} Elo)\n` +
    `  Saved to ${outPath}\n`
);
