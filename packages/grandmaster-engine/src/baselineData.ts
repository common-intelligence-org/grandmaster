import rawReport from './baseline-report.json' with { type: 'json' };
import type { BaselineExperimentReport } from './benchmark.ts';

export const PHASE0_BASELINE_REPORT = rawReport as unknown as BaselineExperimentReport;
