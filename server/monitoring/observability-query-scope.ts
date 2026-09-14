import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';

const ENVIRONMENTS = new Set<StudioDeploymentEnvironment>([
  'production',
  'staging',
  'development',
  'test',
]);

export function normalizeEventEnvironment(value: unknown): StudioDeploymentEnvironment | null {
  const candidate = String(value ?? '').trim().toLowerCase() as StudioDeploymentEnvironment;
  return ENVIRONMENTS.has(candidate) ? candidate : null;
}

/** Shared fail-closed user + deployment tuple for event-to-run evidence joins. */
export const OBSERVABILITY_SCOPED_RUN_JOIN_SQL = `
         and nullif(trim(e.correlation->>'user_id'), '') is not null
         and r.sso_user_id = nullif(trim(e.correlation->>'user_id'), '')
         and (case
           when nullif(lower(trim(to_jsonb(r)->>'environment')), '') is null
             then case when coalesce(r.client_type, '') = 'local-dev' then 'development' else 'production' end
           when lower(trim(to_jsonb(r)->>'environment')) in ('production', 'staging', 'development', 'test')
             then lower(trim(to_jsonb(r)->>'environment'))
           else null
         end) = case
           when nullif(lower(trim(e.correlation->>'environment')), '')
             in ('production', 'staging', 'development', 'test')
             then nullif(lower(trim(e.correlation->>'environment')), '')
           else null
         end`;
