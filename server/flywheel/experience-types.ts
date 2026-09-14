/** Low-sensitivity run aggregate accepted by the central flywheel store. */
export interface ExperienceRunSummary {
  runId: string;
  occurredAt: string;
  total: number;
  passCount: number;
  failCount: number;
  unknownCount: number;
  contractHits: number;
  totalDurationMs: number;
  bySignalSource: Array<{ signal: string; count: number }>;
  topReasonCodes: Array<{ code: string; count: number }>;
  failedTools: Array<{ tool: string; total: number; fails: number }>;
}
