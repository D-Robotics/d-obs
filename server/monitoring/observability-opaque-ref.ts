import { createHash } from 'node:crypto';

/**
 * Stable, non-reversible references used by the observability UI and action
 * proof boundary.  Keep the prefix in the digest domain so the same raw
 * identifier cannot intentionally produce the same suffix across object
 * kinds, and keep enough bits to make accidental tenant collisions
 * impractical at dashboard scale.
 */
export const OBSERVABILITY_OPAQUE_REF_HEX_LENGTH = 24;

export function opaqueObservabilityRef(value: unknown, prefix: string): string | null {
  const raw = String(value ?? '').trim();
  const normalizedPrefix = String(prefix ?? '').trim().toLowerCase();
  if (!raw || !normalizedPrefix) return null;
  const digest = createHash('sha256')
    .update(`rdk-studio-observability-ref-v2\0${normalizedPrefix}\0${raw}`)
    .digest('hex')
    .slice(0, OBSERVABILITY_OPAQUE_REF_HEX_LENGTH);
  return `${normalizedPrefix}-${digest}`;
}
