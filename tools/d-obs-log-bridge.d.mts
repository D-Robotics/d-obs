export type LogBridgeRecord = {
  MESSAGE?: string;
  PRIORITY?: string | number;
  __REALTIME_TIMESTAMP?: string | number;
  _SYSTEMD_UNIT?: string;
  _PID?: string | number;
};

export type ParsedNginxLine = {
  timeMs: number;
  priority: string;
  message: string;
  level: string;
};

export type ReassembledRecord = {
  unit: string;
  pid: string;
  timeMs: number;
  timeEndMs?: number;
  priority?: string | number;
  body: string;
};

export function pgLinePriority(message: string): string;
export function parseNginxLine(line: string): ParsedNginxLine | null;
export function createReassembler(): {
  push(entry: LogBridgeRecord): ReassembledRecord | null;
  flushed(record: ReassembledRecord): void;
};
export function buildOtlpPayload(records: ReassembledRecord[]): {
  resourceLogs: Array<{
    resource: Record<string, unknown>;
    scopeLogs: Array<{
      scope: Record<string, unknown>;
      logRecords: Array<{ body: { stringValue: string } }>;
    }>;
  }>;
};
export function parseJournalOutput(
  chunk: string,
  onEntry: (entry: LogBridgeRecord) => void,
): void;
export function parseDockerLogLine(line: string): { timeMs: number; message: string } | null;
