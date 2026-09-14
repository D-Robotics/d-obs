const OPS_EVENT_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const OPS_EVENT_EVIDENCE_PREFIX = 'event:';

/**
 * Accept the database UUID as well as the canonical copy/paste form used by operators and AI.
 * The typed prefix keeps the identifier unambiguous when it is handed off outside the dashboard.
 */
export function normalizeOpsEventId(value: unknown): string | null {
  const raw = String(value ?? '').trim();
  const candidate = raw.toLowerCase().startsWith(OPS_EVENT_EVIDENCE_PREFIX)
    ? raw.slice(OPS_EVENT_EVIDENCE_PREFIX.length).trim()
    : raw;
  return OPS_EVENT_UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

export function opsEventEvidenceId(value: unknown): string | null {
  const eventId = normalizeOpsEventId(value);
  return eventId ? `${OPS_EVENT_EVIDENCE_PREFIX}${eventId}` : null;
}
