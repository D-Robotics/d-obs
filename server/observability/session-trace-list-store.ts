/** Session projection of the same scoped, tombstone-filtered Run pages as the workbench. */
import {
  getRunTraceList,
  type RunTraceListOptions,
  type RunTraceListPage,
  type RunTraceListRow,
} from './run-trace-list-store.js';

export interface SessionTraceListRow {
  sessionRef: string;
  startedAt: string | null;
  lastRunAt: string | null;
  runCount: number;
  spanCount: number;
  completeRunCount: number;
  errorCount: number;
  runs: RunTraceListRow[];
}

export function projectSessionTracePage(input: RunTraceListPage): {
  sessions: SessionTraceListRow[];
  page: RunTraceListPage['runTracePage'];
  unassignedRunCount: number;
} {
  const groups = new Map<string, SessionTraceListRow>();
  const seen = new Set<string>();
  let unassignedRunCount = 0;
  for (const run of input.runTraces) {
    if (seen.has(run.runRef)) continue;
    seen.add(run.runRef);
    if (!run.sessionRef) {
      unassignedRunCount += 1;
      continue;
    }
    // sessionRef is already an HMAC of account + environment + session, so
    // identical producer session IDs from different accounts cannot merge.
    let session = groups.get(run.sessionRef);
    if (!session) {
      session = { sessionRef: run.sessionRef, startedAt: null, lastRunAt: null,
        runCount: 0, spanCount: 0, completeRunCount: 0, errorCount: 0, runs: [] };
      groups.set(run.sessionRef, session);
    }
    session.runs.push(run);
    session.runCount += 1;
    session.spanCount += run.coverage.spanCount;
    if (run.coverage.state === 'complete') session.completeRunCount += 1;
    if (['error', 'failed', 'timeout'].includes(run.outcome)) session.errorCount += 1;
    if (run.startedAt) {
      if (!session.startedAt || run.startedAt < session.startedAt) session.startedAt = run.startedAt;
      if (!session.lastRunAt || run.startedAt > session.lastRunAt) session.lastRunAt = run.startedAt;
    }
  }
  return { sessions: [...groups.values()], page: input.runTracePage, unassignedRunCount };
}

export async function getSessionTraceList(options: RunTraceListOptions) {
  return projectSessionTracePage(await getRunTraceList(options));
}
