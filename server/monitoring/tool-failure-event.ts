export type RawToolFailureOpsEvent = {
  toolName?: unknown;
  category?: unknown;
  toolCallId?: unknown;
  attempt?: unknown;
  code?: unknown;
  detail?: unknown;
  occurredAt?: unknown;
};

export type NormalizedToolFailureOpsEvent = {
  toolName: string;
  failureCategory: string;
  safeDetail: string;
  safeCode: string;
  safeToolCallId: string;
  attempt: number;
  occurredAt: string | null;
  safeSummary: string;
};

const POLICY_CODES = new Set(['POLICY_DENIED', 'PATH_NOT_ALLOWED']);
const KNOWN_FAILURE_CATEGORIES = new Set([
  'timeout',
  'dependency_unavailable',
  'device_command_failed',
  'policy_denied',
  'permission',
  'not_found',
  'invalid_input',
  'rate_limit',
  'repeat_guard',
  'execution_failed',
  'legacy_unclassified',
]);

/**
 * Normalize the low-sensitivity tool failure contract at the central ingest edge.
 * Transitional clients may still label a structured policy code as permission or
 * execution_failed; the central store repairs that category without reading raw
 * tool output or weakening the underlying permission boundary.
 */
export function normalizeToolFailureOpsEvent(
  rawEvent: RawToolFailureOpsEvent,
): NormalizedToolFailureOpsEvent | null {
  const toolName = String(rawEvent?.toolName ?? '')
    .trim()
    .slice(0, 200);
  if (!toolName) return null;

  let failureCategory =
    String(rawEvent?.category ?? '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '')
      .slice(0, 64) || 'execution_failed';
  // Do not let a stale/new client invent an unbounded category namespace. An
  // unknown value is still useful as an execution failure, but must not create
  // a new alert fingerprint that the worker cannot classify or suppress.
  if (!KNOWN_FAILURE_CATEGORIES.has(failureCategory)) {
    failureCategory = 'execution_failed';
  }
  const safeDetail = String(rawEvent?.detail ?? '')
    .trim()
    .slice(0, 160);
  const safeCode = String(rawEvent?.code ?? '')
    .trim()
    .toUpperCase()
    .slice(0, 32);
  const safeToolCallId = String(rawEvent?.toolCallId ?? '')
    .trim()
    .slice(0, 200);
  const attempt = Math.max(1, Math.floor(Number(rawEvent?.attempt) || 1));
  const occurredAtRaw = String(rawEvent?.occurredAt ?? '').trim();
  const occurredAt = Number.isFinite(Date.parse(occurredAtRaw))
    ? new Date(occurredAtRaw).toISOString()
    : null;

  if (
    POLICY_CODES.has(safeCode) &&
    (failureCategory === 'permission' || failureCategory === 'execution_failed')
  ) {
    failureCategory = 'policy_denied';
  }

  const policySummary =
    safeCode === 'PATH_NOT_ALLOWED'
      ? `工具 ${toolName} 被安全策略拒绝（路径不在允许范围）`
      : `工具 ${toolName} 被安全策略拒绝（policy_denied）`;

  return {
    toolName,
    failureCategory,
    safeDetail,
    safeCode,
    safeToolCallId,
    attempt,
    occurredAt,
    safeSummary:
      failureCategory === 'policy_denied'
        ? policySummary
        : `工具 ${toolName} 调用失败（${failureCategory}）`,
  };
}
