/** 独立告警 worker：由 systemd 每分钟巡检，状态落盘并同步中心 incident。 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';
import { CLIENT_ERROR_NON_ACTIONABLE_API_CODES } from '../../shared/client-error-telemetry.js';
import {
  ALERT_RULE_DEFINITIONS,
  loadAlertConfig,
  type AlertConfig,
  type AlertRuleKey,
} from './alert-config.js';
import { ensureOpsEventSchema, sanitizeOpsSummary } from './ops-event-store.js';
import { remediationPlaybooksForRule, requestRemediation } from './alert-remediation.js';
import {
  ensureObservabilityActionSchema,
  verifyExecutingObservabilityActions,
  type ActionStorePool,
} from './observability-action-loop.js';
import {
  runSyntheticProbeCycle,
  syntheticCredentialsConfigured,
  type SyntheticProbeResult,
} from './synthetic-probes.js';
import { collectServiceLevelBurnObservation } from './studio-alert-slo.js';
import { scanRecentMetricAnomalies } from '../observability/metric-anomalies.js';
import { evaluateStrategies } from './alert-strategy-engine.js';
import { flushSelfLogs, installSelfProcessGuards, recordSelfLog } from '../observability/self-log-reporter.js';
import { installNodeConsoleErrorTelemetry } from './node-console-error-telemetry.js';
import {
  ensureServiceLevelSchema,
  recordServiceLevelSamples,
  aiTtftBudgetMs,
} from './service-level-objectives.js';
import {
  gatewayProbeWithinLatencyBudget,
  probeManagedAgentGateway,
  type GatewayHealthProbeResult,
  probeManagedAgentGatewayTtft,
  type GatewayTtftProbeResult,
} from './gateway-health-probe.js';
import { AI_RUN_OBSERVATION_QUERY } from './ai-run-observation-query.js';
import {
  summarizeGatewayTargetHealth,
  type GatewayTargetHealthSnapshot,
} from './gateway-target-health.js';
import {
  deliverTransition,
  ensureAlertHistorySchema,
  recordCheckSnapshots,
  recordIncident,
  recordIncidentSnapshots,
  recordWorkerStatus,
  resolveInactiveIncidentSnapshots,
} from './studio-alert-delivery.js';
import {
  deliverAndRecordTransition,
} from './studio-alert-notification-policy.js';
import {
  collectActiveMaintenanceKeys,
  maintenanceSuppression,
} from './alert-maintenance-windows.js';
import {
  collectEscalationCandidates,
  ensureEscalationColumns,
} from './alert-escalation.js';
export { sendAlertTestNotification } from './studio-alert-delivery.js';
export { shouldCoalesceSyntheticTransition } from './studio-alert-notification-policy.js';

const execFileAsync = promisify(execFile);
const STATE_VERSION = 1;
const DEFAULT_STATE_PATH = '/var/lib/rdstudio-alert-worker/state.json';
const DEFAULT_INTERNAL_HEALTH_URL = 'http://127.0.0.1:18090/api/health';
const DEFAULT_PUBLIC_HEALTH_URL = 'https://rdkstudio.d-robotics.cc/rdkstudio/api/health';
const DEFAULT_SERVICE = 'rdstudio-web-opt';
const DEFAULT_GATEWAY_TARGET_HEALTH_FILES = [
  { port: 3100, path: '/opt/rdk-gateway/state/target-health-3100.json' },
  { port: 3101, path: '/opt/rdk-gateway/state/target-health-3101.json' },
] as const;

function ttftProbeDue(now = Date.now()): boolean {
  if (String(process.env.RDK_STUDIO_AGENT_TTFT_PROBE_ENABLED ?? '').trim() !== '1') return false;
  const configured = Number.parseInt(
    String(process.env.RDK_STUDIO_AGENT_TTFT_PROBE_INTERVAL_MINUTES ?? '5'),
    10,
  );
  const interval = Number.isFinite(configured) ? Math.max(1, Math.min(60, configured)) : 5;
  return Math.floor(now / 60_000) % interval === 0;
}

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  end: () => Promise<void>;
};

import { collectNorthStarObservations } from './north-star-metrics.js';
import {
  reconcileAlertState,
  type AlertObservation,
  type AlertSeverity,
  type AlertTransition,
  type AlertWorkerState,
} from './studio-alert-state.js';
export {
  reconcileAlertState,
  type AlertObservation,
  type AlertTransition,
  type AlertWorkerState,
} from './studio-alert-state.js';

/** 北极星告警规则（天级指标，越低越糟；阈值见 alert-config.ts 的生产基线注释）。 */
const NORTH_STAR_RULE_KEYS = [
  'north-star-skill-hit-rate',
  'north-star-ai-human-consistency',
  'north-star-retention-d1',
  'north-star-first-success-rate',
] as const;

/**
 * 小时级通知预算有限时，critical 的新开/升级必须排在提醒和恢复之前，
 * 否则一串 warning 提醒会把预算耗尽、真正的 critical 事故反而发不出去。
 * 同级内保持 reconcile 的产出顺序（稳定排序）。
 */
export function prioritizeAlertTransitions(
  transitions: readonly AlertTransition[],
): AlertTransition[] {
  const kindRank: Record<AlertTransition['kind'], number> = {
    escalated: 0,
    opened: 1,
    reminder: 2,
    resolved: 3,
  };
  const severityRank: Record<AlertTransition['severity'], number> = { critical: 0, warning: 1 };
  return transitions
    .map((transition, index) => ({ transition, index }))
    .sort(
      (left, right) =>
        kindRank[left.transition.kind] - kindRank[right.transition.kind] ||
        severityRank[left.transition.severity] - severityRank[right.transition.severity] ||
        left.index - right.index,
    )
    .map((entry) => entry.transition);
}

function statePath(): string {
  return String(process.env.RDK_ALERT_STATE_PATH ?? '').trim() || DEFAULT_STATE_PATH;
}

async function loadState(): Promise<AlertWorkerState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<AlertWorkerState>;
    if (parsed.version === STATE_VERSION && parsed.keys && typeof parsed.keys === 'object') {
      return parsed as AlertWorkerState;
    }
  } catch {
    // 首次启动或损坏时从空状态恢复；告警规则自身有连续失败闸门，不会因此制造洪水。
  }
  return { version: STATE_VERSION, keys: {} };
}

async function saveState(state: AlertWorkerState): Promise<void> {
  const target = statePath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
}

/** 状态持久化必须先于任何评估/投递验证：保存若在投递之后才失败，下一轮会以空白
 *  状态把同一批告警当“首次失败”重发（2026-09-24 生产通知风暴的根因）。探测与
 *  saveState 同路径同语义（mkdir + 写临时文件），在 systemd 沙箱/只读挂载下提前暴露。 */
export async function assertStatePathWritable(): Promise<void> {
  const target = statePath();
  const probe = `${target}.probe-${process.pid}.tmp`;
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(probe, '', { encoding: 'utf8', mode: 0o600 });
  await rm(probe, { force: true });
}

async function createPool(): Promise<Pool> {
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
  const pgMod = (await import('pg' as string)) as {
    default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
  };
  return new pgMod.default.Pool({ connectionString, max: 2 });
}

async function probeHttp(
  url: string,
  expectedApiHealth: boolean,
): Promise<{
  ok: boolean;
  summary: string;
  elapsedMs: number;
}> {
  const startedAt = Date.now();
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { 'user-agent': 'rdstudio-alert-worker/1' },
      signal: AbortSignal.timeout(8_000),
    });
    const elapsedMs = Date.now() - startedAt;
    if (!response.ok) {
      return { ok: false, summary: `HTTP ${response.status}，${elapsedMs}ms`, elapsedMs };
    }
    if (expectedApiHealth) {
      const body = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (body?.ok !== true) {
        return { ok: false, summary: `健康响应无 ok=true，${elapsedMs}ms`, elapsedMs };
      }
    }
    return { ok: true, summary: `HTTP ${response.status}，${elapsedMs}ms`, elapsedMs };
  } catch (error) {
    return {
      ok: false,
      summary: sanitizeOpsSummary(error, 240) || '请求失败',
      elapsedMs: Date.now() - startedAt,
    };
  }
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function ruleSeverity(config: AlertConfig, key: AlertRuleKey, value: number): AlertSeverity {
  return value >= config.rules[key].criticalThreshold ? 'critical' : 'warning';
}

function ruleObservation(
  config: AlertConfig,
  input: Omit<AlertObservation, 'openAfter' | 'resolveAfter' | 'enabled'>,
): AlertObservation {
  const rule = config.rules[input.key];
  return {
    ...input,
    enabled: rule.enabled,
    openAfter: rule.openAfter,
    resolveAfter: rule.resolveAfter,
  };
}

function disabledObservation(config: AlertConfig, key: AlertRuleKey): AlertObservation {
  const definition = ALERT_RULE_DEFINITIONS.find((item) => item.key === key);
  return ruleObservation(config, {
    key,
    title: definition?.title ?? key,
    severity: 'warning',
    unhealthy: false,
    summary: '规则已停用',
  });
}

function gatewayTargetHealthFiles(): Array<{ port: number; path: string }> {
  const configured = String(process.env.RDK_ALERT_GATEWAY_TARGET_HEALTH_FILES ?? '').trim();
  if (!configured) return [...DEFAULT_GATEWAY_TARGET_HEALTH_FILES];
  return configured.split(',').flatMap((item) => {
    const [portRaw, pathRaw] = item.split('=', 2);
    const port = Number(portRaw);
    const filePath = String(pathRaw ?? '').trim();
    return Number.isInteger(port) && filePath ? [{ port, path: filePath }] : [];
  });
}

async function collectGatewayTargetObservation(config: AlertConfig): Promise<AlertObservation> {
  const key = 'agent-model-target-degraded' as const;
  if (!config.rules[key].enabled) return disabledObservation(config, key);
  const files = gatewayTargetHealthFiles();
  try {
    const snapshots: GatewayTargetHealthSnapshot[] = [];
    for (const file of files) {
      try {
        const parsed = JSON.parse(await readFile(file.path, 'utf8')) as {
          savedAt?: string;
          targetHealth?: GatewayTargetHealthSnapshot['targetHealth'];
          targetMetrics?: GatewayTargetHealthSnapshot['targetMetrics'];
        };
        snapshots.push({
          source: file.path,
          port: file.port,
          savedAt: parsed.savedAt ?? null,
          targetHealth: parsed.targetHealth ?? {},
          targetMetrics: parsed.targetMetrics ?? {},
        });
      } catch (error) {
        if ((error as { code?: string }).code !== 'ENOENT') throw error;
      }
    }
    if (!snapshots.length) {
      return ruleObservation(config, {
        key,
        title: '受管 Agent 模型 Target 退化',
        severity: 'warning',
        unhealthy: false,
        unknown: true,
        summary: '未找到 gateway target-health 状态文件，暂无法评估模型 target',
      });
    }
    const summary = summarizeGatewayTargetHealth(snapshots, {
      windowMinutes: config.rules[key].windowMinutes,
    });
    const routeNote =
      summary.primaryDegraded && !summary.standbyDegraded
        ? '，standby 当前未见同类退化'
        : summary.primaryDegraded && summary.standbyDegraded
          ? '，主备均退化'
          : '';
    const staleNote = summary.staleSources > 0 ? `，${summary.staleSources} 个状态源过期` : '';
    return ruleObservation(config, {
      key,
      title: '受管 Agent 模型 Target 退化',
      severity: ruleSeverity(config, key, summary.degradedTargets),
      unhealthy: summary.degradedTargets >= config.rules[key].threshold,
      summary: `${config.rules[key].windowMinutes} 分钟内匹配 target ${summary.matchedTargets} 个，退化 ${summary.degradedTargets} 个（并发耗尽 ${summary.concurrencyTargets} 个）${routeNote}${staleNote}${summary.details.length ? `；${summary.details.join('；')}` : ''}`,
    });
  } catch (error) {
    return ruleObservation(config, {
      key,
      title: '受管 Agent 模型 Target 退化巡检失败',
      severity: 'warning',
      unhealthy: false,
      unknown: true,
      summary: sanitizeOpsSummary(error, 240) || '无法读取 gateway target-health 状态',
    });
  }
}

async function recordGatewayProbeSample(
  p: Pool,
  result: GatewayHealthProbeResult,
  ttft: GatewayTtftProbeResult,
): Promise<void> {
  if (!result.configured && !ttft.configured) return;
  await ensureServiceLevelSchema(p);
  const observations = [];
  if (result.configured) {
    observations.push(
      {
        sli: {
          key: 'gateway-availability' as const,
          good: result.ok ? 1 : 0,
          total: 1,
          source: 'managed-agent-gateway-probe',
        },
      },
      {
        sli: {
          key: 'gateway-latency' as const,
          good: gatewayProbeWithinLatencyBudget(result) ? 1 : 0,
          total: 1,
          source: 'managed-agent-gateway-probe',
        },
      },
    );
  }
  if (ttft.configured) {
    observations.push({
      sli: {
        key: 'ai-ttft' as const,
        good: ttft.ok && (ttft.firstTextMs ?? Number.POSITIVE_INFINITY) <= aiTtftBudgetMs() ? 1 : 0,
        total: 1,
        source: 'managed-agent-gateway-ttft-probe',
      },
    });
  }
  await recordServiceLevelSamples(p, observations, new Date().toISOString());
}

async function collectDatabaseObservations(
  p: Pool,
  config: AlertConfig,
): Promise<AlertObservation[]> {
  await ensureOpsEventSchema();
  const observations: AlertObservation[] = [];
  const aiRule = config.rules['ai-run-degraded-rate'];
  const authRule = config.rules['ai-auth-or-quota'];
  const toolRule = config.rules['tool-failure-repeat'];
  const loginRule = config.rules['sso-infrastructure-failure'];
  const apiRule = config.rules['api-5xx-spike'];
  const processRule = config.rules['process-unhandled-error'];
  const evoRule = config.rules['evolution-worker-health'];
  const budgetRule = config.rules['llm-token-budget'];
  const traceRule = config.rules['otlp-trace-freshness'];

  const [
    runResult,
    authResult,
    toolResult,
    eventResult,
    clientSampleResult,
    evolutionResult,
    budgetResult,
    traceFreshnessResult,
  ] = await Promise.all([
    p.query(AI_RUN_OBSERVATION_QUERY, [aiRule.windowMinutes]),
    p.query(
      `with latest as (
         select distinct on (run_id) run_id, error_category, error_detail
         from public.agent_run_records
         where started_at >= now() - make_interval(mins => $1::int)
           and started_at <= now() + interval '5 minutes'
           and coalesce(client_type, '') <> 'local-dev'
         order by run_id, created_at desc
       )
       select count(*) filter (
         where lower(coalesce(error_category, '')) in ('auth', 'quota_exceeded', 'rate_limit')
            or lower(coalesce(error_detail, '')) ~ '(no_api_key|unauthori[sz]ed|api.?key|token.*limit|quota|余额不足|用量上限)'
       )::int auth_or_quota
       from latest`,
      [authRule.windowMinutes],
    ),
    p
      .query(
        `with tool_errors as (
           select
             coalesce(metadata->>'tool_name', 'unknown') tool_name,
             case
               when coalesce(metadata->>'failure_category', '') = 'legacy_unclassified' then
                 coalesce(nullif(metadata->>'run_id', ''), nullif(correlation->>'run_id', ''), id::text)
               else
                 concat_ws(':',
                   coalesce(nullif(metadata->>'run_id', ''), nullif(correlation->>'run_id', ''), 'runless'),
                   coalesce(nullif(metadata->>'tool_call_id', ''), nullif(metadata->>'attempt', ''), id::text)
                 )
             end failure_unit
           from public.studio_ops_events
           where occurred_at >= now() - make_interval(mins => $1::int)
             and occurred_at <= now() + interval '5 minutes'
             and event_code = 'tool_call' and outcome = 'error'
             and coalesce(metadata->>'client_type', '') <> 'local-dev'
             -- 平台规则只看平台自身埋点：租户上报的事件不能打开平台事故。
             and tenant_id = 'platform'
         )
         select tool_name, count(distinct failure_unit)::int n, count(*)::int event_count
         from tool_errors
         group by 1 order by 2 desc, 3 desc limit 1`,
        [toolRule.windowMinutes],
      )
      .catch((error) => {
        if ((error as { code?: string }).code === '42P01') return { rows: [] };
        throw error;
      }),
    p
      .query(
        `select
           count(*) filter (
             where occurred_at >= now() - make_interval(mins => $1::int)
               and event_code = 'sso_login_attempt' and outcome = 'error'
           )::int login_errors,
           count(*) filter (
             where occurred_at >= now() - make_interval(mins => $2::int)
               and event_code = 'http_5xx' and outcome = 'error'
               and not (
                 coalesce(metadata->>'route', '') ~ '^/api/devices/:id/openclaw/(health|skills)$'
                 and coalesce(metadata->>'status', '') in ('503', '504')
               )
           )::int api_errors,
           coalesce(sum(
             case when occurred_at >= now() - make_interval(mins => $2::int)
                        and event_code = 'client_error' and outcome = 'error'
                        and metadata->>'operational' = 'true'
                        and coalesce(metadata->>'environment', 'production') not in ('development', 'test')
                        and not (coalesce(metadata->>'code', '') = any($4::text[]))
                        and coalesce(metadata->>'route', '') not like '%://localhost:5173/%'
                        and safe_summary !~* '(vite.*(failed to reload|failed to connect)|localhost:5173|requested module [''"]/src/|resource failed to load: /src/)'
                        and not (
                          coalesce(metadata->>'source', '') = 'resource_error'
                          and coalesce(metadata->>'route', '') !~* '(^|/)assets/|[.](m?js|css|wasm)([?#]|$)'
                        )
                        and not (
                          coalesce(metadata->>'source', '') = 'api_error'
                          and coalesce(metadata->>'status', '') ~ '^5[0-9]{2}$'
                        )
                        and not (
                          coalesce(metadata->>'source', '') = 'electron_child_gone'
                          and (
                            lower(coalesce(metadata->>'code', '')) in ('15', 'sigterm')
                            or safe_summary ~* 'signal=SIGTERM'
                          )
                        )
                        and not (
                          coalesce(metadata->>'source', '') in ('electron_child_gone', 'electron_renderer_gone')
                          and coalesce(metadata->>'code', '') = '1073807364'
                          and safe_summary ~* '(killed|embedded server exited)'
                        )
                        and safe_summary !~* 'No handler registered for .rdk:(client-errors-drain|get-pending-desktop-update)'
                        and coalesce(metadata->>'top_frame', '') not like '%://localhost:5173/%'
                        and safe_summary not like '%http://localhost:5173/%'
                  then greatest(
                    1,
                    case when metadata->>'occurrence_count' ~ '^[0-9]+$'
                         then (metadata->>'occurrence_count')::int else 1 end
                  )
                  else 0 end
           ), 0)::int client_errors,
           count(*) filter (
             where occurred_at >= now() - make_interval(mins => $3::int)
               and event_code = 'process_unhandled_error' and outcome = 'error'
           )::int process_errors
         from public.studio_ops_events
         where occurred_at <= now() + interval '5 minutes'
           and coalesce(metadata->>'client_type', '') <> 'local-dev'
           -- 平台规则只看平台自身埋点（租户事件按 tenant_id 隔离）。
           and tenant_id = 'platform'`,
        [
          loginRule.windowMinutes,
          apiRule.windowMinutes,
          processRule.windowMinutes,
          [...CLIENT_ERROR_NON_ACTIONABLE_API_CODES],
        ],
      )
      .catch((error) => {
        if ((error as { code?: string }).code === '42P01') return { rows: [{}] };
        throw error;
      }),
    p
      .query(
        `select count(distinct concat_ws(
                  '|',
                  coalesce(correlation->>'user_id', 'anonymous'),
                  coalesce(metadata->>'error_name', ''),
                  coalesce(metadata->>'route', ''),
                  coalesce(metadata->>'code', ''),
                  coalesce(metadata->>'top_frame', ''),
                  regexp_replace(
                    coalesce(safe_summary, ''),
                    '^(console_error|react_boundary|window_error):[[:space:]]*',
                    '',
                    'i'
                  )
                ))::int client_error_samples
         from public.studio_ops_events
         where occurred_at >= now() - make_interval(mins => $1::int)
           and occurred_at <= now() + interval '5 minutes'
           and event_code = 'client_error' and outcome = 'error'
           -- 平台规则只看平台自身埋点：租户 token 不能把平台客户端错误率顶爆。
           and tenant_id = 'platform'
           and metadata->>'operational' = 'true'
           and coalesce(metadata->>'environment', 'production') not in ('development', 'test')
           and not (coalesce(metadata->>'code', '') = any($2::text[]))
           and coalesce(metadata->>'route', '') not like '%://localhost:5173/%'
           and safe_summary !~* '(vite.*(failed to reload|failed to connect)|localhost:5173|requested module [''"]/src/|resource failed to load: /src/)'
           and not (
             coalesce(metadata->>'source', '') = 'resource_error'
             and coalesce(metadata->>'route', '') !~* '(^|/)assets/|[.](m?js|css|wasm)([?#]|$)'
           )
           and not (
             coalesce(metadata->>'source', '') = 'api_error'
             and coalesce(metadata->>'status', '') ~ '^5[0-9]{2}$'
           )
           and not (
             coalesce(metadata->>'source', '') = 'electron_child_gone'
             and (
               lower(coalesce(metadata->>'code', '')) in ('15', 'sigterm')
               or safe_summary ~* 'signal=SIGTERM'
             )
           )
           and not (
             coalesce(metadata->>'source', '') in ('electron_child_gone', 'electron_renderer_gone')
             and coalesce(metadata->>'code', '') = '1073807364'
             and safe_summary ~* '(killed|embedded server exited)'
           )
           and safe_summary !~* 'No handler registered for .rdk:(client-errors-drain|get-pending-desktop-update)'
           and coalesce(metadata->>'top_frame', '') not like '%://localhost:5173/%'
           and safe_summary not like '%http://localhost:5173/%'`,
        [apiRule.windowMinutes, [...CLIENT_ERROR_NON_ACTIONABLE_API_CODES]],
      )
      .catch((error) => {
        if ((error as { code?: string }).code === '42P01') return { rows: [{}] };
        throw error;
      }),
    p
      .query(
        `select enabled, last_status, last_run_at
         from public.studio_evolution_worker_status
         order by updated_at desc nulls last
         limit 1`,
      )
      .catch((error) => {
        if ((error as { code?: string }).code === '42P01') return { rows: [] };
        throw error;
      }),
    p
      .query(
        `with latest as (
           select distinct on (run_id) run_id, prompt_tokens, completion_tokens
           from public.agent_run_records
           where started_at >= now() - make_interval(mins => $1::int)
             and started_at <= now() + interval '5 minutes'
             and coalesce(client_type, '') <> 'local-dev'
           order by run_id, created_at desc
         )
         select coalesce(sum(coalesce(prompt_tokens, 0) + coalesce(completion_tokens, 0)), 0)::bigint token_total,
                count(*)::int run_count
         from latest`,
        [budgetRule.windowMinutes],
      )
      .catch((error) => {
        // 42P01：agent_run_records 表不存在（未接中心库）→ 降级为空行，下方 DB 降级清单会接管提示。
        if ((error as { code?: string }).code === '42P01')
          return { rows: [{} as Record<string, unknown>] };
        throw error;
      }),
    p
      .query(
        `select coalesce(max(end_time_ms), 0)::bigint as latest_ms
         from public.studio_trace_spans`,
      )
      .catch((error) => {
        // 42P01：studio_trace_spans 表不存在（未接中心库）→ 无观测，跳过该信号。
        if ((error as { code?: string }).code === '42P01')
          return { rows: [{} as Record<string, unknown>] };
        throw error;
      }),
  ]);
  const run = runResult.rows[0] ?? {};
  const total = number(run.total);
  const errors = number(run.errors);
  const partials = number(run.partials);
  const degraded = errors + partials;
  const degradedRate = total > 0 ? degraded / total : 0;
  observations.push(
    ruleObservation(config, {
      key: 'ai-run-degraded-rate',
      title: 'AI 对话失败率异常',
      severity: ruleSeverity(config, 'ai-run-degraded-rate', degraded),
      unhealthy:
        total >= aiRule.minSamples &&
        degraded >= aiRule.threshold &&
        degradedRate * 100 >= aiRule.ratePercent,
      summary: `${aiRule.windowMinutes} 分钟内失败 ${errors}、部分完成 ${partials}、总 run ${total}（退化率 ${Math.round(degradedRate * 100)}%，触发条件：样本 ≥${aiRule.minSamples}、异常 ≥${aiRule.threshold} 且退化率 ≥${aiRule.ratePercent}%）`,
    }),
  );
  const authOrQuota = number(authResult.rows[0]?.auth_or_quota);
  const tokenTotal = Number(budgetResult.rows[0]?.token_total ?? 0);
  const budgetRunCount = number(budgetResult.rows[0]?.run_count);
  // OTLP 链路断报：只对"有过历史数据"的库告警，全新部署（0 条 span）不触发。
  const traceLatestMs = Number(traceFreshnessResult.rows[0]?.latest_ms ?? 0);
  const staleMinutes =
    traceLatestMs > 0 ? Math.max(0, Math.trunc((Date.now() - traceLatestMs) / 60_000)) : 0;
  const traceEverReceived = traceLatestMs > 0;
  if (traceEverReceived && traceRule) {
    observations.push(
      ruleObservation(config, {
        key: 'otlp-trace-freshness',
        title: 'OTLP 链路断报',
        severity: ruleSeverity(config, 'otlp-trace-freshness', staleMinutes),
        unhealthy: staleMinutes >= traceRule.threshold,
        summary: `最近一次 trace span 落库距今 ${staleMinutes.toLocaleString()} 分钟（${new Date(traceLatestMs).toISOString()}）；预警 ≥${traceRule.threshold.toLocaleString()} 分钟，严重 ≥${traceRule.criticalThreshold.toLocaleString()} 分钟`,
      }),
    );
  }
  // 指标统计异常：z-score 粗筛升级为主动告警信号；指标库不可用时不阻断其它评估。
  const anomalyRule = config.rules['metric-anomaly'];
  if (anomalyRule) {
    try {
      const anomalies = await scanRecentMetricAnomalies({
        windowMinutes: anomalyRule.windowMinutes ?? 240,
        threshold: 3.5,
      });
      const top = anomalies[0];
      if (top && top.score >= anomalyRule.threshold) {
        observations.push(
          ruleObservation(config, {
            key: 'metric-anomaly',
            title: '指标统计异常',
            severity: ruleSeverity(config, 'metric-anomaly', top.score),
            unhealthy: top.score >= anomalyRule.threshold,
            summary: `窗口内 ${anomalies.length} 条序列偏离基线，最高 z=${top.score}：${top.metric} 最新 ${top.value} vs 基线 ${top.baseline}±${top.deviation}（预警 z≥${anomalyRule.threshold}，严重 z≥${anomalyRule.criticalThreshold}）`,
          }),
        );
      }
    } catch {
      // 指标存储不可用：跳过本信号，其它告警照常评估
    }
  }
  observations.push(
    ruleObservation(config, {
      key: 'llm-token-budget',
      title: 'LLM token 消耗超预算',
      severity: ruleSeverity(config, 'llm-token-budget', tokenTotal),
      unhealthy: tokenTotal >= budgetRule.threshold,
      summary: `${budgetRule.windowMinutes} 分钟内 ${budgetRunCount} 个 run 共消耗 ${tokenTotal.toLocaleString()} tokens（预警 ≥${budgetRule.threshold.toLocaleString()}，严重 ≥${budgetRule.criticalThreshold.toLocaleString()}）`,
    }),
  );
  observations.push(
    ruleObservation(config, {
      key: 'ai-auth-or-quota',
      title: 'AI 鉴权或额度错误',
      severity: ruleSeverity(config, 'ai-auth-or-quota', authOrQuota),
      unhealthy: authOrQuota >= authRule.threshold,
      summary: `${authRule.windowMinutes} 分钟内出现 ${authOrQuota} 次鉴权、密钥、限额或额度错误`,
    }),
  );

  const topToolRow = toolResult.rows[0];
  const topTool = topToolRow
    ? ([
        sanitizeOpsSummary(topToolRow.tool_name, 120) || 'unknown',
        number(topToolRow.n),
        number(topToolRow.event_count),
      ] as const)
    : undefined;
  observations.push(
    ruleObservation(config, {
      key: 'tool-failure-repeat',
      title: '工具调用连续失败',
      severity: ruleSeverity(config, 'tool-failure-repeat', topTool?.[1] ?? 0),
      unhealthy: Boolean(topTool && topTool[1] >= toolRule.threshold),
      summary: topTool
        ? `${toolRule.windowMinutes} 分钟内工具 ${topTool[0]} 影响 ${topTool[1]} 个 run（${topTool[2]} 次失败）`
        : `${toolRule.windowMinutes} 分钟内未发现重复工具失败`,
    }),
  );
  const eventCounts = (eventResult.rows[0] ?? {}) as Record<string, unknown>;
  const loginInfraFailures = number(eventCounts.login_errors);
  const apiErrors = number(eventCounts.api_errors);
  const clientErrors = number(eventCounts.client_errors);
  const clientSampleCounts = (clientSampleResult.rows[0] ?? {}) as Record<string, unknown>;
  const clientErrorSamples = number(clientSampleCounts.client_error_samples);
  const processErrors = number(eventCounts.process_errors);
  observations.push(
    ruleObservation(config, {
      key: 'sso-infrastructure-failure',
      title: '登录基础设施异常',
      severity: ruleSeverity(config, 'sso-infrastructure-failure', loginInfraFailures),
      unhealthy: loginInfraFailures >= loginRule.threshold,
      summary: `${loginRule.windowMinutes} 分钟内 SSO 上游/服务端失败 ${loginInfraFailures} 次（不含密码或验证码输错）`,
    }),
  );
  observations.push(
    ruleObservation(config, {
      key: 'api-5xx-spike',
      title: '应用错误激增',
      severity: ruleSeverity(config, 'api-5xx-spike', Math.max(apiErrors, clientErrors)),
      unhealthy:
        apiErrors >= apiRule.threshold ||
        (clientErrors >= apiRule.threshold && clientErrorSamples >= apiRule.minSamples),
      summary: `${apiRule.windowMinutes} 分钟内服务端 5xx ${apiErrors} 次、客户端运行错误 ${clientErrors} 次（独立样本 ${clientErrorSamples}，触发至少 ${apiRule.minSamples} 个）`,
    }),
  );
  observations.push(
    ruleObservation(config, {
      key: 'process-unhandled-error',
      title: 'Node 进程未捕获异常',
      severity: ruleSeverity(config, 'process-unhandled-error', processErrors),
      unhealthy: processErrors >= processRule.threshold,
      summary: `${processRule.windowMinutes} 分钟内捕获 ${processErrors} 次 uncaughtException/unhandledRejection`,
    }),
  );
  // 进化 worker 健康：生产曾连坏 7 天（ENOENT 依赖缺失）而零告警（2026-07-30~08-05）。
  // 失败运行与超期未运行各计 1 分；同时命中为 critical。每日排期，超 36h 无运行即视为静默故障。
  // 运维有意停用（enabled=false）时不计分，避免永久告警。
  const EVOLUTION_STALE_HOURS = 36;
  const evoRow = (evolutionResult.rows[0] ?? {}) as Record<string, unknown>;
  const evoEnabled = evoRow.enabled !== false;
  const evoStatus = String(evoRow.last_status ?? 'never');
  const evoFailed = evoEnabled && ['error', 'failed', 'blocked'].includes(evoStatus);
  const evoLastRunAt = evoRow.last_run_at ? new Date(String(evoRow.last_run_at)) : null;
  const evoStaleHours =
    evoLastRunAt && Number.isFinite(evoLastRunAt.getTime())
      ? Math.max(0, (Date.now() - evoLastRunAt.getTime()) / 3_600_000)
      : Number.POSITIVE_INFINITY;
  const evoStale = evoEnabled && evoStaleHours > EVOLUTION_STALE_HOURS;
  const evoScore = (evoFailed ? 1 : 0) + (evoStale ? 1 : 0);
  observations.push(
    ruleObservation(config, {
      key: 'evolution-worker-health',
      title: '进化 Worker 健康异常',
      severity: ruleSeverity(config, 'evolution-worker-health', evoScore),
      unhealthy: evoScore >= evoRule.threshold,
      summary: !evoEnabled
        ? '进化 worker 已停用（enabled=false），跳过健康计分'
        : evoScore === 0
          ? `进化 worker 最近状态 ${evoStatus}，距上次运行 ${Math.round(evoStaleHours)} 小时`
          : [
              evoFailed ? `最近一次运行状态 ${evoStatus}` : '',
              evoStale
                ? Number.isFinite(evoStaleHours)
                  ? `距上次运行已 ${Math.round(evoStaleHours)} 小时（排期阈值 ${EVOLUTION_STALE_HOURS}h）`
                  : '无运行记录'
                : '',
            ]
              .filter(Boolean)
              .join('；'),
    }),
  );
  return observations;
}

/** PromQL 即时查询：返回首个序列的数值；未配置/失败返回 null（调用方自行兜底）。 */
async function promInstantQuery(query: string): Promise<number | null> {
  const base = String(process.env.RDK_PROMETHEUS_QUERY_URL ?? '').trim();
  if (!base) return null;
  try {
    const response = await fetch(`${base}/api/v1/query?query=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as {
      data?: { result?: Array<{ value?: [unknown, string] }> };
    };
    const parsed = Number(payload.data?.result?.[0]?.value?.[1]);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function collectDiskObservation(config: AlertConfig): Promise<AlertObservation> {
  const key = 'disk-space' as const;
  if (!config.rules[key].enabled) return disabledObservation(config, key);
  // 数据源优先级：Prometheus node_exporter（统一采集主路径）→ 本机 statfs 兜底。
  const promPercent = await promInstantQuery(
    'max(100*(1 - node_filesystem_avail_bytes{fstype!~"tmpfs|overlay|squashfs",mountpoint="/"} / node_filesystem_size_bytes{fstype!~"tmpfs|overlay|squashfs",mountpoint="/"}))',
  );
  const target = String(process.env.RDK_ALERT_DISK_PATH ?? '').trim() || '/opt/rdstudio-web-opt';
  if (promPercent != null) {
    const usedPercent = Math.round(promPercent);
    return ruleObservation(config, {
      key,
      title: '生产服务器磁盘空间不足',
      severity: ruleSeverity(config, key, usedPercent),
      unhealthy: usedPercent >= config.rules[key].threshold,
      summary: `${usedPercent}%（阈值 ${config.rules[key].threshold}% / 严重 ${config.rules[key].criticalThreshold}%）· node_exporter`,
    });
  }
  try {
    const stats = await statfs(target);
    const total = Number(stats.blocks) * Number(stats.bsize);
    const free = Number(stats.bavail) * Number(stats.bsize);
    const usedPercent = total > 0 ? Math.round(((total - free) / total) * 100) : 0;
    return ruleObservation(config, {
      key,
      title: '生产服务器磁盘空间不足',
      severity: ruleSeverity(config, key, usedPercent),
      unhealthy: usedPercent >= config.rules[key].threshold,
      summary: `${target} 已使用 ${usedPercent}%（阈值 ${config.rules[key].threshold}% / 严重 ${config.rules[key].criticalThreshold}%）`,
    });
  } catch (error) {
    return ruleObservation(config, {
      key,
      title: '生产服务器磁盘检查失败',
      severity: 'warning',
      unhealthy: true,
      summary: sanitizeOpsSummary(error, 240),
    });
  }
}

function countSignatures(text: string, signatures: string[]): number {
  const lowered = text.toLowerCase();
  return signatures.reduce((total, signature) => {
    const needle = signature.toLowerCase();
    if (!needle) return total;
    let from = 0;
    let count = 0;
    while (count < 10_000) {
      const index = lowered.indexOf(needle, from);
      if (index < 0) break;
      count += 1;
      from = index + Math.max(1, needle.length);
    }
    return total + count;
  }, 0);
}

/** 本机内存压力：MemAvailable/MemTotal（node_exporter，经 Prometheus）。 */
async function collectNodeMemoryObservation(config: AlertConfig): Promise<AlertObservation> {
  const key = 'node-memory-pressure' as const;
  if (!config.rules[key].enabled) return disabledObservation(config, key);
  const percentRaw = await promInstantQuery(
    'max(100*(1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes))',
  );
  if (percentRaw == null) {
    return ruleObservation(config, {
      key,
      title: '本机内存压力',
      severity: 'warning',
      unhealthy: false,
      summary: 'node_exporter 指标不可用（Prometheus 未配置或目标离线）',
    });
  }
  const percent = Math.round(percentRaw);
  return ruleObservation(config, {
    key,
    title: '本机内存压力',
    severity: ruleSeverity(config, key, percent),
    unhealthy: percent >= config.rules[key].threshold,
    summary: `内存已用 ${percent}%（阈值 ${config.rules[key].threshold}% / 严重 ${config.rules[key].criticalThreshold}%）`,
  });
}

/** 本机 CPU 负载：load1 / 核数，100% = 满载一核（node_exporter，经 Prometheus）。 */
async function collectNodeLoadObservation(config: AlertConfig): Promise<AlertObservation> {
  const key = 'node-cpu-load' as const;
  if (!config.rules[key].enabled) return disabledObservation(config, key);
  const percentRaw = await promInstantQuery(
    '100 * node_load1 / scalar(count(node_cpu_seconds_total{mode="idle"}))',
  );
  if (percentRaw == null) {
    return ruleObservation(config, {
      key,
      title: '本机 CPU 负载',
      severity: 'warning',
      unhealthy: false,
      summary: 'node_exporter 指标不可用（Prometheus 未配置或目标离线）',
    });
  }
  const percent = Math.round(percentRaw);
  return ruleObservation(config, {
    key,
    title: '本机 CPU 负载',
    severity: ruleSeverity(config, key, percent),
    unhealthy: percent >= config.rules[key].threshold,
    summary: `每核负载 ${percent}%（阈值 ${config.rules[key].threshold}% / 严重 ${config.rules[key].criticalThreshold}%）`,
  });
}

async function collectJournalObservation(config: AlertConfig): Promise<AlertObservation> {
  const key = 'service-crash-signature' as const;
  if (!config.rules[key].enabled) return disabledObservation(config, key);
  const service = String(process.env.RDK_ALERT_SYSTEMD_SERVICE ?? '').trim() || DEFAULT_SERVICE;
  try {
    const windowMinutes = config.rules[key].windowMinutes;
    const { stdout } = await execFileAsync(
      'journalctl',
      ['-u', service, '--since', `${windowMinutes} minutes ago`, '--no-pager', '-o', 'cat'],
      { timeout: 8_000, maxBuffer: 2_000_000 },
    );
    const signatureCount = countSignatures(String(stdout), config.logSignatures.application);
    return ruleObservation(config, {
      key,
      title: '服务崩溃或启动失败',
      severity: ruleSeverity(config, key, signatureCount),
      unhealthy: signatureCount >= config.rules[key].threshold,
      summary: `最近 ${windowMinutes} 分钟命中 ${signatureCount} 条崩溃/模块/语法错误签名`,
    });
  } catch (error) {
    return ruleObservation(config, {
      key,
      title: '服务日志巡检失败',
      severity: 'warning',
      unhealthy: true,
      summary: sanitizeOpsSummary(error, 240),
    });
  }
}

const NGINX_MONTHS = new Map(
  ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map(
    (name, index) => [name, index],
  ),
);

function parseNginxTimestamp(raw: string): number {
  const match =
    /(\d{1,2})\/([A-Z][a-z]{2})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})/.exec(raw);
  if (!match) return Number.NaN;
  const month = NGINX_MONTHS.get(match[2]!);
  if (month == null) return Number.NaN;
  const localUtc = Date.UTC(
    Number(match[3]),
    month,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  );
  const offsetMs = (Number(match[8]) * 60 + Number(match[9])) * 60_000;
  return match[7] === '+' ? localUtc - offsetMs : localUtc + offsetMs;
}

/**
 * 设备可视状态轮询路径（diagnostics / state-snapshot / openclaw 状态族）。设备离线时应用层按设计
 * 返回 503（DEVICE_OFFLINE_CACHED / LOCAL_BRIDGE_OFFLINE 等，见 run-on-device.ts），前端会以十几秒
 * 间隔持续轮询 → 几分钟内即可攒出多次 503。这些 503 是「应用活着、设备离线」的预期语义，
 * 不是反代/服务故障（上游真挂了同路径会表现为 502，仍会计数），因此从本规则里降噪排除。
 */
const NGINX_DEVICE_VISIBILITY_503 =
  /\/api\/devices\/[^\/\s]+\/(diagnostics|state-snapshot|openclaw\/(status|health|config|skills|version))(\s|\?|$)/;

async function collectNginxObservation(config: AlertConfig): Promise<AlertObservation> {
  const key = 'nginx-5xx-log' as const;
  if (!config.rules[key].enabled) return disabledObservation(config, key);
  const accessPath =
    String(process.env.RDK_ALERT_NGINX_ACCESS_LOG ?? '').trim() || '/var/log/nginx/access.log';
  try {
    const { stdout } = await execFileAsync('tail', ['-n', '10000', accessPath], {
      timeout: 8_000,
      maxBuffer: 4_000_000,
    });
    const cutoff = Date.now() - config.rules[key].windowMinutes * 60_000;
    let count = 0;
    let badGateway = 0;
    let deviceOfflineSkipped = 0;
    for (const line of String(stdout).split(/\r?\n/)) {
      const timestamp = line.match(/\[([^\]]+)\]/)?.[1];
      const status = Number(line.match(/"\s+(\d{3})\s+/)?.[1]);
      if (!timestamp || !Number.isFinite(status) || parseNginxTimestamp(timestamp) < cutoff)
        continue;
      if (status >= 500 && status <= 599) {
        const requestLine = line.match(/"([^"]*)"/)?.[1] ?? '';
        if (status === 503 && NGINX_DEVICE_VISIBILITY_503.test(requestLine)) {
          deviceOfflineSkipped += 1;
          continue;
        }
        count += 1;
        if (status === 502 || status === 503 || status === 504) badGateway += 1;
      }
    }
    const skippedNote =
      deviceOfflineSkipped > 0 ? `，另排除设备离线 503 ${deviceOfflineSkipped} 次` : '';
    return ruleObservation(config, {
      key,
      title: 'Nginx 5xx 日志异常',
      severity: ruleSeverity(config, key, count),
      unhealthy: count >= config.rules[key].threshold,
      summary: `${config.rules[key].windowMinutes} 分钟内 Nginx 5xx ${count} 次（502/503/504 共 ${badGateway} 次${skippedNote}）`,
    });
  } catch (error) {
    return ruleObservation(config, {
      key,
      title: 'Nginx 日志巡检失败',
      severity: 'warning',
      unhealthy: true,
      summary: sanitizeOpsSummary(error, 240),
    });
  }
}

async function collectPostgresLogObservation(config: AlertConfig): Promise<AlertObservation> {
  const key = 'postgres-error-log' as const;
  if (!config.rules[key].enabled) return disabledObservation(config, key);
  const container =
    String(process.env.RDK_ALERT_POSTGRES_CONTAINER ?? '').trim() || 'rdk-credits-pg';
  try {
    const windowMinutes = config.rules[key].windowMinutes;
    const { stdout, stderr } = await execFileAsync(
      'docker',
      ['logs', '--since', `${windowMinutes}m`, container],
      { timeout: 10_000, maxBuffer: 4_000_000 },
    );
    const count = countSignatures(
      `${String(stdout)}\n${String(stderr)}`,
      config.logSignatures.postgres,
    );
    return ruleObservation(config, {
      key,
      title: 'PostgreSQL 错误日志',
      severity: ruleSeverity(config, key, count),
      unhealthy: count >= config.rules[key].threshold,
      summary: `${windowMinutes} 分钟内命中 ${count} 条 FATAL/PANIC/死锁/连接耗尽等错误签名`,
    });
  } catch (error) {
    return ruleObservation(config, {
      key,
      title: 'PostgreSQL 日志巡检失败',
      severity: 'warning',
      unhealthy: true,
      summary: sanitizeOpsSummary(error, 240),
    });
  }
}

const SYNTHETIC_RULE_KEYS = [
  'synthetic-login',
  'synthetic-ai-chat',
  'synthetic-tool-call',
] as const;

function syntheticObservation(
  config: AlertConfig,
  key: (typeof SYNTHETIC_RULE_KEYS)[number],
  result: SyntheticProbeResult,
): AlertObservation {
  const rule = config.rules[key];
  const slow = result.elapsedMs >= rule.threshold;
  return ruleObservation(config, {
    key,
    title: ALERT_RULE_DEFINITIONS.find((definition) => definition.key === key)?.title ?? key,
    severity: !result.ok ? 'critical' : ruleSeverity(config, key, result.elapsedMs),
    unhealthy: !result.ok || slow,
    summary:
      slow && result.ok ? `${result.summary}（超过 ${rule.threshold}ms 延迟阈值）` : result.summary,
  });
}

async function collectSyntheticObservations(
  config: AlertConfig,
  state: AlertWorkerState,
  now: Date,
): Promise<AlertObservation[]> {
  const enabledKeys = SYNTHETIC_RULE_KEYS.filter((key) => config.rules[key].enabled);
  const disabled = SYNTHETIC_RULE_KEYS.filter((key) => !config.rules[key].enabled).map((key) =>
    disabledObservation(config, key),
  );
  if (enabledKeys.length === 0) return disabled;
  if (!syntheticCredentialsConfigured(config)) {
    return [
      ...disabled,
      ...enabledKeys.map((key) =>
        ruleObservation(config, {
          key,
          title: ALERT_RULE_DEFINITIONS.find((definition) => definition.key === key)?.title ?? key,
          severity: 'warning',
          unhealthy: true,
          summary: '规则已启用，但尚未配置专用 canary 账号和密码',
        }),
      ),
    ];
  }

  const lastAt = state.lastSyntheticAt ? Date.parse(state.lastSyntheticAt) : 0;
  const intervalMs = config.synthetic.intervalMinutes * 60_000;
  const hasAllCached = enabledKeys.every((key) => state.syntheticResults?.[key]);
  const due = !Number.isFinite(lastAt) || now.getTime() - lastAt >= intervalMs || !hasAllCached;
  if (due) {
    const results = await runSyntheticProbeCycle(config);
    state.syntheticResults = { ...(state.syntheticResults ?? {}) };
    for (const result of results) state.syntheticResults[result.key] = result;
    // Schedule from the completed attempt, not only from a successful attempt.
    // Failure results are valid cached observations; retrying them on the
    // worker's one-minute systemd cadence would ignore intervalMinutes and
    // repeatedly consume canary quota during an outage.
    state.lastSyntheticAt = now.toISOString();
  }

  return [
    ...disabled,
    ...enabledKeys.map((key) => {
      const cached = state.syntheticResults?.[key];
      if (cached) return syntheticObservation(config, key, cached);
      return ruleObservation(config, {
        key,
        title: ALERT_RULE_DEFINITIONS.find((definition) => definition.key === key)?.title ?? key,
        severity: 'warning',
        unhealthy: true,
        summary: '拨测尚未产生结果',
      });
    }),
  ];
}

async function runWorker(): Promise<void> {
  void registerPlatformObjects().catch(() => undefined);
  const config = await loadAlertConfig();
  if (!config.global.enabled) {
    console.log('[alert-worker] disabled');
    return;
  }
  const previous = await loadState();
  try {
    await assertStatePathWritable();
  } catch (error) {
    throw new Error(
      `状态文件路径不可写（${statePath()}）：${sanitizeOpsSummary(error, 200)} — 已阻止本轮评估与投递，避免状态无法持久化导致的通知重发`,
    );
  }
  let state = previous;
  let p: Pool | null = null;
  // 维护窗口键集合与升级候选：try 块内收集（DB 不可用时为空/空集，投递不受影响）。
  let maintenanceKeys = new Set<string>();
  let pendingEscalations: import('./alert-escalation.js').EscalationCandidate[] = [];
  const observations: AlertObservation[] = [];

  const internalUrl =
    String(process.env.RDK_ALERT_INTERNAL_HEALTH_URL ?? '').trim() || DEFAULT_INTERNAL_HEALTH_URL;
  const publicUrl =
    String(process.env.RDK_ALERT_PUBLIC_HEALTH_URL ?? '').trim() || DEFAULT_PUBLIC_HEALTH_URL;
  const [
    internalHealth,
    publicHealth,
    gatewayHealth,
    gatewayTtft,
    disk,
    journal,
    nginx,
    postgresLog,
    gatewayTarget,
  ] = await Promise.all([
    probeHttp(internalUrl, true),
    probeHttp(publicUrl, true),
    probeManagedAgentGateway(),
    ttftProbeDue()
      ? probeManagedAgentGatewayTtft()
      : Promise.resolve({
          configured: false,
          ok: false,
          elapsedMs: 0,
          firstTextMs: null,
          status: null,
          errorCategory: 'disabled' as const,
        }),
    collectDiskObservation(config),
    collectNodeMemoryObservation(config),
    collectNodeLoadObservation(config),
    collectJournalObservation(config),
    collectNginxObservation(config),
    collectPostgresLogObservation(config),
    collectGatewayTargetObservation(config),
  ]);
  observations.push(
    ruleObservation(config, {
      key: 'internal-health',
      title: '主服务健康检查不可用',
      severity: !internalHealth.ok
        ? 'critical'
        : ruleSeverity(config, 'internal-health', internalHealth.elapsedMs),
      unhealthy:
        !internalHealth.ok || internalHealth.elapsedMs >= config.rules['internal-health'].threshold,
      summary: `本机健康检查：${internalHealth.summary}`,
    }),
    ruleObservation(config, {
      key: 'public-health',
      title: '公网入口不可用',
      severity: !publicHealth.ok
        ? 'critical'
        : ruleSeverity(config, 'public-health', publicHealth.elapsedMs),
      unhealthy:
        !publicHealth.ok || publicHealth.elapsedMs >= config.rules['public-health'].threshold,
      summary: `公网健康检查：${publicHealth.summary}`,
      sli: {
        key: 'public-availability',
        good: publicHealth.ok ? 1 : 0,
        total: 1,
        source: 'alert-worker-public-health',
      },
    }),
    disk,
    journal,
    nginx,
    postgresLog,
    gatewayTarget,
  );

  try {
    p = await createPool();
    const started = Date.now();
    await p.query('select 1');
    await ensureAlertHistorySchema(p);
    // 升级链列（幂等）+ 维护窗口抑制 + ack 超时升级，见投递编排注释。
    await ensureEscalationColumns(p).catch((error) => {
      console.warn(
        '[alert-worker] escalation columns setup failed:',
        sanitizeOpsSummary(error, 240),
      );
    });
    maintenanceKeys = await collectActiveMaintenanceKeys(p).catch((error) => {
      console.warn(
        '[alert-worker] maintenance windows unavailable:',
        sanitizeOpsSummary(error, 240),
      );
      return new Set<string>();
    });
    pendingEscalations = await collectEscalationCandidates(p).catch(
      (error): import('./alert-escalation.js').EscalationCandidate[] => {
        console.warn(
          '[alert-worker] escalation pass failed:',
          sanitizeOpsSummary(error, 240),
        );
        return [];
      },
    );
    // 行动环后置验证：executing 状态的行动不依赖操作者保持页面打开，
    // worker 每轮巡检都会按精确 remediation run 复核并推进终态。
    await ensureObservabilityActionSchema(p)
      .then(() => verifyExecutingObservabilityActions(p as ActionStorePool))
      .then((updated) => {
        for (const item of updated) {
          console.log(
            `[alert-worker] action post-check advanced: ${item.id} -> ${item.status}`,
          );
        }
      })
      .catch((error) => {
        console.warn(
          '[alert-worker] action post-check pass failed:',
          sanitizeOpsSummary(error, 240),
        );
      });
    await recordGatewayProbeSample(p, gatewayHealth, gatewayTtft).catch((error) => {
      // A telemetry migration/permission problem must not hide the rest of
      // the database-backed alert checks or turn a healthy worker into a crash.
      console.warn('[alert-worker] gateway SLO sample failed:', sanitizeOpsSummary(error, 180));
    });
    const databaseObservations = await collectDatabaseObservations(p, config);
    // 北极星观测自带快照节流与单路降级；整体失败时降级为 unknown，不拖垮中心库巡检。
    const northStarObservations = await collectNorthStarObservations(p, config).catch(
      (error): AlertObservation[] => {
        console.warn('[alert-worker] north-star evaluation failed:', sanitizeOpsSummary(error, 180));
        return NORTH_STAR_RULE_KEYS.map((key) =>
          ruleObservation(config, {
            key,
            title:
              ALERT_RULE_DEFINITIONS.find((definition) => definition.key === key)?.title ?? key,
            severity: 'warning',
            unhealthy: false,
            unknown: true,
            summary: '北极星指标评估失败，当前无法评估',
          }),
        );
      },
    );
    observations.push(
      ruleObservation(config, {
        key: 'central-database',
        title: '中心 PostgreSQL 不可用',
        severity: ruleSeverity(config, 'central-database', Date.now() - started),
        unhealthy: Date.now() - started >= config.rules['central-database'].threshold,
        summary: `数据库连通，${Date.now() - started}ms`,
      }),
    );
    observations.push(...databaseObservations);
    observations.push(...northStarObservations);
    observations.push(await collectServiceLevelBurnObservation(p, config, observations));
  } catch (error) {
    observations.push(
      ruleObservation(config, {
        key: 'central-database',
        title: '中心 PostgreSQL 不可用',
        severity: 'critical',
        unhealthy: true,
        summary: sanitizeOpsSummary(error, 240) || '数据库连接失败',
      }),
    );
    for (const key of [
      'ai-run-degraded-rate',
      'ai-auth-or-quota',
      'llm-token-budget',
      'tool-failure-repeat',
      'sso-infrastructure-failure',
      'api-5xx-spike',
      'process-unhandled-error',
      'slo-error-budget-burn',
      ...NORTH_STAR_RULE_KEYS,
    ] as const) {
      observations.push(
        config.rules[key].enabled
          ? ruleObservation(config, {
              key,
              title:
                ALERT_RULE_DEFINITIONS.find((definition) => definition.key === key)?.title ?? key,
              severity: 'warning',
              unhealthy: false,
              unknown: true,
              summary: '中心库不可用，当前无法计算该指标',
            })
          : disabledObservation(config, key),
      );
    }
  }

  const checkedAt = new Date();
  observations.push(...(await collectSyntheticObservations(config, state, checkedAt)));
  const reconciled = reconcileAlertState(state, observations, checkedAt, {
    cooldownMinutes: config.global.cooldownMinutes,
    remindersEnabled: config.global.remindersEnabled,
  });
  state = reconciled.state;
  if (p) {
    await recordCheckSnapshots(p, observations, state, checkedAt.toISOString()).catch((error) => {
      console.warn('[alert-worker] check snapshot failed:', sanitizeOpsSummary(error, 240));
    });
    await recordIncidentSnapshots(p, observations, state, checkedAt.toISOString()).catch(
      (error) => {
        console.warn('[alert-worker] incident snapshot failed:', sanitizeOpsSummary(error, 240));
      },
    );
    await resolveInactiveIncidentSnapshots(p, observations, state, checkedAt.toISOString()).catch(
      (error) => {
        console.warn(
          '[alert-worker] incident reconciliation failed:',
          sanitizeOpsSummary(error, 240),
        );
      },
    );
  }
  const hourAgo = checkedAt.getTime() - 60 * 60_000;
  state.notificationHistory = (state.notificationHistory ?? []).filter((timestamp) => {
    const parsed = Date.parse(timestamp);
    return Number.isFinite(parsed) && parsed >= hourAgo;
  });
  const orderedTransitions = prioritizeAlertTransitions(reconciled.transitions);
  // 升级链派生 transition 与 reconcile 输出合并投递：升级是「没人响应」信号，
  // 优先级等同 escalated（排序函数已把 escalated 放最前）。
  const escalationTransitions: AlertTransition[] = pendingEscalations.map((candidate) => ({
    kind: 'escalated',
    key: candidate.alertKey as AlertRuleKey,
    title: candidate.title,
    severity: candidate.severity,
    summary: candidate.summary,
    at: checkedAt.toISOString(),
    firstSeenAt: candidate.firstSeenAt,
  }));
  const allTransitions = prioritizeAlertTransitions([
    ...escalationTransitions,
    ...orderedTransitions,
  ]);
  for (const transition of allTransitions) {
    // 维护窗口抑制：评估与落库照旧，渠道投递抑制（窗口结束后由状态机补发）。
    const suppression = maintenanceSuppression(transition.key, maintenanceKeys);
    const delivery = suppression
      ? { delivered: false, channel: 'suppressed', attempts: 0, error: suppression.reason }
      : await deliverAndRecordTransition(state, transition, allTransitions, config);
    if (p) {
      await recordIncident(p, transition, delivery.delivered).catch(() => {});
      await p
        .query(
          `insert into public.studio_alert_notifications
           (alert_key, transition, severity, delivered, channel, error, attempt_count)
         values ($1, $2, $3, $4, $5, $6, $7)`,
          [
            transition.key,
            transition.kind,
            transition.severity,
            delivery.delivered,
            delivery.channel,
            delivery.error ?? null,
            delivery.attempts ?? 0,
          ],
        )
        .catch(() => {});
    }
  }

  // 自定义策略引擎（P2）：租户/平台自定义 PromQL 阈值策略。Prometheus 查询
  // 通道未配置时整体跳过；转换复用既有投递与事故管线（渠道按策略覆盖解析），
  // 事故租户归属由键命名空间推导（recordIncident）。
  if (p && String(process.env.RDK_PROMETHEUS_QUERY_URL ?? '').trim()) {
    const strategyEntries = await evaluateStrategies(p, checkedAt).catch((error) => {
      console.warn(
        '[alert-worker] strategy evaluation failed:',
        sanitizeOpsSummary(error, 240),
      );
      return [];
    });
    for (const entry of strategyEntries) {
      const suppression = maintenanceSuppression(entry.transition.key, maintenanceKeys);
      const delivery = suppression
        ? { delivered: false, channel: 'suppressed', attempts: 0, error: suppression.reason }
        : entry.channel === 'none'
          ? {
              delivered: false,
              channel: 'suppressed',
              attempts: 0,
              error: 'strategy_notification_disabled',
            }
          : await deliverTransition(
              entry.transition,
              config,
              entry.channel ? { channel: entry.channel } : undefined,
            );
      if (p) {
        await recordIncident(p, entry.transition, delivery.delivered).catch(() => {});
        await p
          .query(
            `insert into public.studio_alert_notifications
             (alert_key, transition, severity, delivered, channel, error, attempt_count)
           values ($1, $2, $3, $4, $5, $6, $7)`,
            [
              entry.transition.key,
              entry.transition.kind,
              entry.transition.severity,
              delivery.delivered,
              delivery.channel,
              delivery.error ?? null,
              delivery.attempts ?? 0,
            ],
          )
          .catch(() => {});
      }
    }
  }

  const active = Object.values(state.keys).filter((entry) => entry.active).length;
  // 自动自愈：新事故通知后按配置开关触发白名单剧本；真实命令在独立 systemd 单元执行，
  // 默认关闭，需在看板“基础配置”显式开启。
  if (p && config.global.autoRemediation) {
    for (const transition of reconciled.transitions) {
      if (transition.kind !== 'opened' && transition.kind !== 'escalated') continue;
      const playbook = remediationPlaybooksForRule(transition.key)[0];
      if (!playbook) continue;
      await requestRemediation(config, playbook.id, 'auto', 'alert-worker')
        .then((result) => {
          if (result.accepted) {
            console.log(
              `[alert-worker] auto-remediation started: ${playbook.id} (${transition.key})`,
            );
          } else {
            console.log(
              `[alert-worker] auto-remediation skipped: ${playbook.id} (${transition.key}) reason=${result.reason ?? result.error}`,
            );
          }
        })
        .catch((error) => {
          console.warn('[alert-worker] auto-remediation failed:', sanitizeOpsSummary(error, 240));
        });
    }
  }
  if (p) {
    await recordWorkerStatus(p, config, checkedAt.toISOString(), observations.length, active).catch(
      (error) => {
        console.warn('[alert-worker] status snapshot failed:', sanitizeOpsSummary(error, 240));
      },
    );
  }

  const lastCleanup = state.lastCleanupAt ? Date.parse(state.lastCleanupAt) : 0;
  if (p && (!Number.isFinite(lastCleanup) || Date.now() - lastCleanup >= 24 * 60 * 60_000)) {
    await p
      .query(`delete from public.studio_ops_events where occurred_at < now() - interval '30 days'`)
      .catch(() => {});
    // 租户事件表同期限清理：线上跑的是主站部署的 worker，它不认识这张表，
    // 因此另有 ops/retention/ 的独立 timer（见 docs/event-ingest.md）。这里保留
    // 一份，保证 d-obs 自己跑 worker 时两表都不会无界增长。
    await p
      .query(
        `delete from public.studio_ops_events_tenant where occurred_at < now() - interval '30 days'`,
      )
      .catch(() => {});
    await p
      .query(`delete from public.studio_sli_samples where sampled_at < now() - interval '35 days'`)
      .catch(() => {});
    state.lastCleanupAt = new Date().toISOString();
  }
  await saveState(state);
  await p?.end().catch(() => {});

  console.log(
    `[alert-worker] checks=${observations.length} active=${active} transitions=${reconciled.transitions.length}`,
  );
}

const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  }
})();

if (invokedAsScript) {
  installSelfProcessGuards();
  installNodeConsoleErrorTelemetry({
    component: 'alert-worker',
    selfLogSink: (entry) => recordSelfLog('alert-worker', entry),
  });
  const command = process.argv.slice(2)[0];
  if (command === '--check-config') {
    loadAlertConfig()
      .then((config) => {
        console.log(
          `[alert-worker] config ok: enabled=${config.global.enabled} shadow=${config.notification.shadowMode} channel=${config.notification.channel}`,
        );
      })
      .catch((error) => {
        console.error('[alert-worker] config invalid:', sanitizeOpsSummary(error, 500));
        process.exitCode = 78;
      });
  } else {
    runWorker().catch((error) => {
      console.error('[alert-worker] fatal:', sanitizeOpsSummary(error, 500));
      process.exitCode = 1;
    });
  }
}
import { registerPlatformObjects } from './observability-object-registry.js';
