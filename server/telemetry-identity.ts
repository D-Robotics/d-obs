import { createHash } from 'node:crypto';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/**
 * Resolve the version of the Studio process that produced a telemetry row.
 * The packaged desktop server receives RDK_STUDIO_VERSION from Electron; web
 * deployments can provide the same value explicitly. Never trust arbitrary
 * user input as a version fallback.
 */
export function resolveStudioTelemetryVersion(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const candidates = [
    env.RDK_STUDIO_VERSION,
    env.RDK_STUDIO_APP_VERSION,
    env.VITE_APP_VERSION,
    env.npm_package_version,
  ];
  for (const candidate of candidates) {
    const value = String(candidate ?? '').trim();
    if (VERSION_PATTERN.test(value)) return value.slice(0, 64);
  }
  return null;
}

/** 仅接受客户端自报的合法 semver；不接受服务端环境兜底。 */
export function clientReportedStudioVersion(value: unknown): string | null {
  const candidate = String(value ?? '').trim();
  return VERSION_PATTERN.test(candidate) ? candidate.slice(0, 64) : null;
}

/** Keep client-provided version dimensions constrained to the same semver contract. */
export function normalizeStudioTelemetryVersion(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return clientReportedStudioVersion(value) ?? resolveStudioTelemetryVersion(env);
}

/**
 * Stable, opaque source key for append-only telemetry. The payload is hashed
 * only to make retries/replays idempotent; the digest is not a user-facing ID.
 */
export function buildTelemetrySourceId(kind: string, parts: unknown[]): string {
  const normalizedKind = String(kind ?? '').trim().slice(0, 64) || 'telemetry';
  return `${normalizedKind}:${createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')}`;
}
