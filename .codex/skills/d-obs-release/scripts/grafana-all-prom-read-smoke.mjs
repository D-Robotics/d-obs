#!/usr/bin/env node
/** Complete real Grafana PromQL GET probe; no assistant chat, confirmation or writes.
 * node grafana-all-prom-read-smoke.mjs --origin https://rdkstudio.d-robotics.cc/dobs
 * Credentials remain private; Linux may read d-obs.service MainPID admin-token.
 * Output contains only case/sequence, status, counts, booleans and safe codes.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const PLATFORM = 'https://rdkstudio.d-robotics.cc/dobs';
const ROOT = '/api/ops/observability';
const GRAFANA = ROOT + '/grafana';
const GETS = ['GET ' + GRAFANA + '/dashboards', 'GET ' + GRAFANA + '/dashboards/:uid', 'GET ' + ROOT + '/prom/query'];
const MAX_BYTES = 2 * 1024 * 1024;
const object = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const validUid = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
function fail(code, status = 0) { const error = new Error(code); error.status = status; throw error; }
function safeError(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return 'smoke_request_timeout';
  return /^[a-z][a-z0-9_]{2,100}$/.test(String(error?.message ?? '')) ? error.message : 'smoke_request_failed';
}
function apiError(data) { return typeof data?.error === 'string' && /^[a-z][a-z0-9_]{2,100}$/.test(data.error) ? data.error : 'smoke_api_rejected'; }
function credential(value) {
  const token = String(value ?? '').trim(); if (token.length > 16384 || /[\x00-\x1f\x7f]/.test(token)) fail('invalid_smoke_credential'); return token;
}
export function validateOrigin(value) { if (value !== PLATFORM && value !== PLATFORM + '/') fail('unsafe_smoke_origin'); return PLATFORM; }
function tokenFromMainPid() {
  if (process.platform !== 'linux') return '';
  try {
    const pid = execFileSync('systemctl', ['show', 'd-obs.service', '--property=MainPID', '--value'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!/^[1-9][0-9]*$/.test(pid)) return '';
    const entry = readFileSync('/proc/' + pid + '/environ', 'utf8').split('\0').find((entry) => entry.startsWith('RDK_CREDITS_ADMIN_TOKEN='));
    return credential(entry?.slice('RDK_CREDITS_ADMIN_TOKEN='.length));
  } catch { return ''; }
}
async function requestJson(origin, path, headers, fetchImpl) {
  if (!path.startsWith(ROOT + '/') || path.includes('/chat') || path.includes('/confirm')) fail('smoke_non_read_endpoint_rejected');
  const response = await fetchImpl(origin + path, { method: 'GET', headers: { ...headers, accept: 'application/json', 'x-rdk-ops-read-only': '1', 'x-rdk-ops-action': 'observability-context' }, redirect: 'error', signal: AbortSignal.timeout(60000) });
  const status = response.status;
  if (!/\bapplication\/json\b/i.test(response.headers.get('content-type') ?? '')) { await response.body?.cancel().catch(() => undefined); fail('invalid_smoke_content_type', status); }
  if (Number(response.headers.get('content-length')) > MAX_BYTES) { await response.body?.cancel().catch(() => undefined); fail('smoke_response_too_large', status); }
  const reader = response.body?.getReader(); if (!reader) fail('empty_smoke_response', status);
  const chunks = []; let size = 0;
  try { for (;;) {
    const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel().catch(() => undefined); fail('smoke_response_too_large', status); } chunks.push(value);
  } } finally { reader.releaseLock(); }
  let data; try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail('invalid_smoke_json', status); }
  if (status !== 200 || data?.ok !== true) fail(apiError(data), status);
  return { status, data };
}
function sourceContract(data) { if (data?.scope !== 'platform' || data?.source !== 'grafana-api' || data?.containsLiveMetrics !== false) fail('invalid_grafana_source_contract'); }
function validPromData(data, expression) {
  if (data.promql !== expression.trim() || !Array.isArray(data.series) || data.series.length > 24) fail('invalid_prometheus_result_shape');
  let points = 0;
  for (const row of data.series) {
    if (!object(row) || typeof row.name !== 'string' || !Array.isArray(row.points) || !row.points.length || row.points.some((point) => !object(point) || !Number.isFinite(point.ts) || !Number.isFinite(point.value))) fail('invalid_prometheus_result_shape');
    points += row.points.length;
  }
  return { seriesCount: data.series.length, pointCount: points, empty: data.series.length === 0 };
}
export async function runAllGrafanaPromReadSmoke({ origin, headers = {}, minutes = 5, fetchImpl = fetch, emit = (item) => process.stdout.write(JSON.stringify(item) + '\n') }) {
  origin = validateOrigin(origin); if (![5, 10].includes(minutes)) fail('invalid_smoke_minutes');
  let failed = false; let partial = false; let dashboardCount = 0; let detailCount = 0; let panelCount = 0; let targetCount = 0; let executableTargetCount = 0;
  let passedQueryCount = 0; let emptyQueryCount = 0; let failedQueryCount = 0; let syntaxFailureCount = 0; const queries = new Set();
  const output = (item) => { emit(item); if (item.ok === false) failed = true; };
  const get = (path) => requestJson(origin, path, headers, fetchImpl);
  try {
    const result = await get(ROOT + '/assistant/capabilities'); const data = result.data;
    if (data.readOnlyExecutionSupported !== true) fail('read_only_execution_not_supported', result.status);
    if (!Array.isArray(data.operations) || !data.operations.length || data.operations.some((item) => !object(item) || item.method !== 'GET' || item.mutating !== false || item.id !== 'GET ' + item.path)) fail('invalid_capability_catalog', result.status);
    for (const id of GETS) if (!data.operations.some((item) => item.id === id)) fail('required_read_capability_missing', result.status);
    output({ case: 'handshake', status: result.status, ok: true, capabilityCount: data.operations.length, errors: [] });
  } catch (error) { output({ case: 'handshake', status: error.status || 0, ok: false, errors: [safeError(error)] }); return false; }
  let dashboards;
  try {
    const result = await get(GRAFANA + '/dashboards?limit=100'); sourceContract(result.data);
    const data = result.data;
    if (!Array.isArray(data.dashboards) || data.dashboards.length > 100 || data.returnedCount !== data.dashboards.length || data.limit !== 100 || typeof data.mayHaveMore !== 'boolean' || data.dashboards.some((item) => !object(item) || !validUid(item.uid))) fail('invalid_grafana_catalog_shape', result.status);
    dashboards = data.dashboards; dashboardCount = dashboards.length; partial = data.mayHaveMore;
    output({ case: 'catalog', status: result.status, ok: true, dashboardCount, partial, errors: [] });
  } catch (error) { output({ case: 'catalog', status: error.status || 0, ok: false, errors: [safeError(error)] }); return false; }
  for (const [index, dashboard] of dashboards.entries()) {
    try {
      const result = await get(GRAFANA + '/dashboards/' + encodeURIComponent(dashboard.uid)); sourceContract(result.data); const detail = result.data.dashboard;
      if (!object(detail) || detail.uid !== dashboard.uid || detail.readOnly !== true || !Array.isArray(detail.panels) || detail.panels.length > 80 || typeof detail.panelsTruncated !== 'boolean' || typeof detail.panelCountIsLowerBound !== 'boolean') fail('invalid_grafana_detail_shape', result.status);
      let dashboardTargets = 0; let dashboardExecutable = 0; let dashboardPartial = detail.panelsTruncated || detail.panelCountIsLowerBound;
      for (const panel of detail.panels) {
        if (!object(panel) || !Array.isArray(panel.targets) || panel.targets.length > 8 || !Number.isInteger(panel.targetCount) || panel.targetCount < panel.targets.length || typeof panel.targetsTruncated !== 'boolean') fail('invalid_grafana_panel_shape', result.status);
        dashboardPartial ||= panel.targetsTruncated; dashboardTargets += panel.targets.length;
        for (const target of panel.targets) {
          if (!object(target) || typeof target.queryExecutableViaPlatform !== 'boolean') fail('invalid_grafana_target_shape', result.status);
          if (!target.queryExecutableViaPlatform) continue;
          if (typeof target.expr !== 'string' || !target.expr.trim() || target.expr.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(target.expr) || target.expr.includes('$') || target.expressionOmitted !== false || target.expressionRedacted !== false || target.hasTemplateVariables !== false || target.datasource?.type !== 'prometheus') fail('invalid_grafana_executable_query', result.status);
          dashboardExecutable++; queries.add(target.expr);
        }
      }
      detailCount++; panelCount += detail.panels.length; targetCount += dashboardTargets; executableTargetCount += dashboardExecutable; partial ||= dashboardPartial;
      output({ case: 'detail', sequence: index + 1, status: result.status, ok: true, panelCount: detail.panels.length, targetCount: dashboardTargets, executableTargetCount: dashboardExecutable, partial: dashboardPartial, errors: [] });
    } catch (error) { output({ case: 'detail', sequence: index + 1, status: error.status || 0, ok: false, errors: [safeError(error)] }); }
  }
  for (const [index, expression] of [...queries].entries()) {
    try {
      const query = new URLSearchParams({ query: expression, minutes: String(minutes) }); const result = await get(ROOT + '/prom/query?' + query); const counts = validPromData(result.data, expression);
      passedQueryCount++; if (counts.empty) emptyQueryCount++;
      output({ case: 'query', sequence: index + 1, status: result.status, ok: true, ...counts, errors: [] });
    } catch (error) {
      failedQueryCount++; const code = safeError(error); if (code === 'invalid_promql') syntaxFailureCount++;
      output({ case: 'query', sequence: index + 1, status: error.status || 0, ok: false, syntaxFailure: code === 'invalid_promql', errors: [code] });
    }
  }
  if (!dashboardCount || !queries.size) { output({ case: 'coverage', status: 0, ok: false, errors: ['no_real_queries_available'] }); }
  output({ case: 'summary', status: 0, ok: !failed, dashboardCount, detailCount, panelCount, targetCount, executableTargetCount, uniqueQueryCount: queries.size, duplicateQueryCount: executableTargetCount - queries.size, passedQueryCount, emptyQueryCount, failedQueryCount, syntaxFailureCount, partial, errors: partial ? ['bounded_catalog_partial'] : [] });
  return !failed;
}
async function main() {
  let origin; let minutes = 5;
  for (let index = 2; index < process.argv.length; index++) {
    if (process.argv[index] === '--origin') origin = process.argv[++index];
    else if (process.argv[index] === '--minutes') minutes = Number(process.argv[++index]);
    else if (['--help', '-h'].includes(process.argv[index])) { process.stdout.write('Usage: node grafana-all-prom-read-smoke.mjs --origin https://rdkstudio.d-robotics.cc/dobs [--minutes 5|10]\n'); return; }
    else fail('invalid_smoke_argument');
  }
  origin = validateOrigin(origin); if (![5, 10].includes(minutes)) fail('invalid_smoke_minutes');
  const token = credential(process.env.ASSISTANT_SMOKE_ADMIN_TOKEN || process.env.RDK_CREDITS_ADMIN_TOKEN) || tokenFromMainPid(); if (!token) fail('smoke_credential_unavailable');
  process.exitCode = await runAllGrafanaPromReadSmoke({ origin, minutes, headers: { 'x-admin-token': token } }) ? 0 : 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stdout.write(JSON.stringify({ case: 'startup', status: error.status || 0, ok: false, errors: [safeError(error)] }) + '\n'); process.exitCode = 1; });
