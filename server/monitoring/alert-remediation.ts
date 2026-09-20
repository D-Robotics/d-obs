/**
 * d-obs 告警自愈（Remediation）。
 *
 * 一键自愈 = 运营在可观测看板确认（或点击飞书告警里的深链）后触发白名单处置剧本；
 * 自动自愈 = 告警 worker 发现新事故时按配置开关自动触发同一批剧本。剧本一律在独立
 * systemd oneshot 单元里执行固定命令（alert-remediation-runner），带前置安全检查、
 * 冷却与并发闸门、数据库审计，并按原通知渠道回投结果；执行结束立即触发一轮评估，
 * 让“告警恢复”通知尽快闭环。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sendWebhookPayload } from '../analytics-cloud-forward.js';
import { type AlertConfig, type AlertRuleKey } from './alert-config.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';
import {
  ensureRemediationSchema as ensureRemediationSchemaReadiness,
  type RemediationSchemaPool,
} from './alert-remediation-schema.js';

export {
  REMEDIATION_SCHEMA_READINESS_SQL,
  resetRemediationSchemaReadinessForTest,
} from './alert-remediation-schema.js';

const execFileAsync = promisify(execFile);

export type RemediationTrigger = 'manual' | 'auto';

export type RemediationPlaybookId =
  | 'restart-app'
  | 'restart-standby'
  | 'reload-nginx'
  | 'run-evolution';

/**
 * 声明式剧本步骤：runner 按 kind 泛化解释（execFile 固定 argv，不经过 shell）。
 * 新增剧本 = 在 REMEDIATION_PLAYBOOKS 里声明元数据 + 步骤序列，不再改 runner。
 */
export type RemediationStepSpec =
  /** 前置安全闸：systemctl is-active <unit> 必须 active，否则整个剧本拒绝执行。 */
  | { kind: 'assert-active'; name: string; unit: string; failSummary: string }
  /** 固定命令（execFile 固定 argv）。失败即中止并落 failSummary。 */
  | {
      kind: 'exec';
      name: string;
      command: string;
      args: string[];
      timeoutMs?: number;
      failSummary: string;
    }
  /** 健康拨测轮询；失败即中止并落 failSummary。 */
  | {
      kind: 'poll-health';
      name: string;
      url: string;
      attempts?: number;
      intervalMs?: number;
      failSummary: string;
    };

export interface RemediationPlaybook {
  id: RemediationPlaybookId;
  title: string;
  description: string;
  safety: string;
  appliesTo: AlertRuleKey[];
  /** 执行目标：local-host = 本机 systemd/nginx；预留 ssh:<device> 形态给边缘剧本。 */
  target: string;
  /** 声明式步骤序列（runner 泛化解释；disabled 剧本不执行）。 */
  steps: RemediationStepSpec[];
  /** 全部步骤通过后的结果摘要。 */
  successSummary: string;
  /** 声明但被禁用的剧本：保留元数据供看板解释，runner 拒绝执行。 */
  disabledReason?: string;
}

const INTERNAL_HEALTH_URL = 'http://127.0.0.1:18090/api/health';
const STANDBY_HEALTH_URL = 'http://127.0.0.1:18091/api/health';
const PUBLIC_HEALTH_URL = 'https://rdkstudio.d-robotics.cc/rdkstudio/api/health';

/** 白名单剧本：runner 只允许执行这些 id 对应的声明式步骤，不接受任意命令。 */
export const REMEDIATION_PLAYBOOKS: RemediationPlaybook[] = [
  {
    id: 'restart-app',
    title: '重启主服务（standby 接管）',
    description:
      '前置校验 systemctl is-active rdstudio-web-opt-standby.service（不 active 拒绝）→ systemctl restart rdstudio-web-opt.service → 健康拨测 18090。重启窗口内 nginx 自动 failover 到 standby，零停机。',
    safety: 'standby 不 active 时拒绝执行，避免重启窗口造成真实停服',
    appliesTo: [
      'nginx-5xx-log',
      'internal-health',
      'public-health',
      'service-crash-signature',
      'process-unhandled-error',
      'api-5xx-spike',
    ],
    target: 'local-host',
    successSummary: '主服务已重启，本机与公网健康检查通过',
    steps: [
      {
        kind: 'assert-active',
        name: '前置检查：standby active',
        unit: 'rdstudio-web-opt-standby.service',
        failSummary: 'standby 不 active，安全闸门拒绝重启主服务',
      },
      {
        kind: 'exec',
        name: '重启主服务',
        command: 'systemctl',
        args: ['restart', 'rdstudio-web-opt.service'],
        failSummary: 'systemctl restart rdstudio-web-opt 失败',
      },
      {
        kind: 'poll-health',
        name: '验证：本机健康',
        url: INTERNAL_HEALTH_URL,
        failSummary: '主服务已重启，但健康验证未通过',
      },
      {
        kind: 'poll-health',
        name: '验证：公网健康',
        url: PUBLIC_HEALTH_URL,
        attempts: 5,
        intervalMs: 2_000,
        failSummary: '主服务已重启，但公网健康验证未通过',
      },
    ],
  },
  {
    id: 'restart-standby',
    title: '重启 standby 服务',
    description:
      '前置校验 systemctl is-active rdstudio-web-opt.service（不 active 拒绝）→ systemctl restart rdstudio-web-opt-standby.service → 健康拨测 18091。恢复下一次重启窗口的 failover 能力。',
    safety: '主服务不 active 时拒绝执行',
    appliesTo: ['internal-health', 'public-health', 'nginx-5xx-log'],
    target: 'local-host',
    successSummary: 'standby 已重启并恢复健康，failover 能力恢复',
    steps: [
      {
        kind: 'assert-active',
        name: '前置检查：主服务 active',
        unit: 'rdstudio-web-opt.service',
        failSummary: '主服务不 active，安全闸门拒绝重启 standby',
      },
      {
        kind: 'exec',
        name: '重启 standby',
        command: 'systemctl',
        args: ['restart', 'rdstudio-web-opt-standby.service'],
        failSummary: 'systemctl restart rdstudio-web-opt-standby 失败',
      },
      {
        kind: 'poll-health',
        name: '验证：standby 健康',
        url: STANDBY_HEALTH_URL,
        failSummary: 'standby 已重启，但 18091 健康验证未通过',
      },
    ],
  },
  {
    id: 'reload-nginx',
    title: '重载 Nginx',
    description:
      '前置校验 nginx -t（不通过拒绝）→ systemctl reload nginx.service → 公网健康拨测。只 reload 不 restart、不修改任何配置文件。',
    safety: '只 reload 不 restart、不改配置；校验失败拒绝执行',
    appliesTo: ['nginx-5xx-log', 'public-health'],
    target: 'local-host',
    successSummary: 'nginx 已 reload，公网健康检查通过',
    steps: [
      {
        kind: 'exec',
        name: '配置校验 nginx -t',
        command: 'nginx',
        args: ['-t'],
        timeoutMs: 15_000,
        failSummary: 'nginx -t 未通过，拒绝 reload',
      },
      {
        kind: 'exec',
        name: '重载 nginx',
        command: 'systemctl',
        args: ['reload', 'nginx.service'],
        timeoutMs: 30_000,
        failSummary: 'systemctl reload nginx 失败',
      },
      {
        kind: 'poll-health',
        name: '验证：公网健康',
        url: PUBLIC_HEALTH_URL,
        attempts: 5,
        intervalMs: 2_000,
        failSummary: 'nginx 已 reload，但公网健康验证未通过',
      },
    ],
  },
  {
    id: 'run-evolution',
    title: '触发进化 Worker',
    description: '启动 rdstudio-evolution-worker@manual，在隔离副本中生成候选补丁，等待人工审核。',
    safety: 'candidate-only：不自动合并、不自动上线',
    appliesTo: ['evolution-worker-health'],
    target: 'local-host',
    successSummary: '进化 worker 已触发',
    disabledReason: '进化 worker 使用独立 DSH host，当前不允许从 remediation/action 路径触发',
    steps: [],
  },
];

/** Evolution currently owns a second DSH host; keep it out of the action path
 * until it is folded into the production composition root. */
export function isRemediationPlaybookActionEnabled(id: string): boolean {
  return id !== 'run-evolution';
}

export function getRemediationPlaybook(id: string): RemediationPlaybook | undefined {
  return REMEDIATION_PLAYBOOKS.find((playbook) => playbook.id === id);
}

export function remediationPlaybooksForRule(key: AlertRuleKey): RemediationPlaybook[] {
  return REMEDIATION_PLAYBOOKS.filter(
    (playbook) =>
      isRemediationPlaybookActionEnabled(playbook.id) && playbook.appliesTo.includes(key),
  );
}

/** 飞书告警里的一键自愈深链：看板解析 #remediate=<key> 后定位到自愈中心。 */
export function remediationDeepLink(config: AlertConfig, key: AlertRuleKey): string {
  const base = config.notification.dashboardUrl.split('#')[0];
  return `${base}#remediate=${key}`;
}

type PgQueryResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };
type Pool = {
  query: (text: string, params?: unknown[]) => Promise<PgQueryResult>;
  end: () => Promise<void>;
};

/**
 * Verify that the checked-in remediation migration is ready.  This deliberately
 * delegates to a SELECT-only catalog probe; schema ownership stays in Supabase
 * migrations and request-time paths never execute DDL.
 */
export async function ensureRemediationSchema(p: Pool): Promise<void> {
  await ensureRemediationSchemaReadiness(p as RemediationSchemaPool);
}

export interface RemediationStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface RemediationRun {
  id: string;
  environment: StudioDeploymentEnvironment;
  startedAt: string;
  finishedAt: string | null;
  playbookId: string;
  trigger: RemediationTrigger | string;
  triggeredBy: string;
  status: 'running' | 'succeeded' | 'failed' | 'rejected' | string;
  summary: string;
  steps: RemediationStep[];
}

const REMEDIATION_RUN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const REMEDIATION_ENVIRONMENTS: readonly StudioDeploymentEnvironment[] = [
  'production',
  'staging',
  'development',
  'test',
];

/** Resolve environment from server configuration; callers cannot override it. */
export function resolveRemediationEnvironment(): StudioDeploymentEnvironment {
  const configured = String(process.env.RDK_OBSERVABILITY_ENVIRONMENT ?? '')
    .trim()
    .toLowerCase();
  if (REMEDIATION_ENVIRONMENTS.includes(configured as StudioDeploymentEnvironment)) {
    return configured as StudioDeploymentEnvironment;
  }
  if (process.env.NODE_ENV === 'production') return 'production';
  if (process.env.NODE_ENV === 'test') return 'test';
  return 'development';
}

/**
 * The shipped systemd template targets the production host and units.  Until
 * there are explicit per-environment unit/url bindings, side-effecting
 * remediation is production-only; staging/dev/test requests fail before a
 * durable reservation or systemctl invocation is attempted.
 */
export function assertProductionRemediationEnvironment(): void {
  const environment = resolveRemediationEnvironment();
  if (environment !== 'production') {
    throw new Error('remediation_non_production_disabled');
  }
}

function remediationRunFromRow(row: Record<string, unknown>): RemediationRun {
  return {
    id: String(row.id),
    environment: REMEDIATION_ENVIRONMENTS.includes(row.environment as StudioDeploymentEnvironment)
      ? (row.environment as StudioDeploymentEnvironment)
      : 'production',
    startedAt: row.started_at ? new Date(String(row.started_at)).toISOString() : '',
    finishedAt: row.finished_at ? new Date(String(row.finished_at)).toISOString() : null,
    playbookId: String(row.playbook_id),
    trigger: String(row.trigger),
    triggeredBy: String(row.triggered_by),
    status: String(row.status),
    summary: row.summary ? String(row.summary) : '',
    steps: Array.isArray(row.steps) ? (row.steps as RemediationStep[]) : [],
  };
}

export async function listRemediationRuns(p: Pool, limit = 10): Promise<RemediationRun[]> {
  const result = await p.query(
    `select id, environment, started_at, finished_at, playbook_id, trigger, triggered_by, status, summary, steps
     from public.studio_remediation_runs where environment = $1
     order by started_at desc
     limit $2`,
    [resolveRemediationEnvironment(), limit],
  );
  return result.rows.map(remediationRunFromRow);
}

/** Read one exact remediation run for post-checks; never rely on a recency page. */
export async function getRemediationRun(p: Pool, runId: string): Promise<RemediationRun | null> {
  const normalized = String(runId ?? '').trim();
  if (!REMEDIATION_RUN_ID_PATTERN.test(normalized)) return null;
  const result = await p.query(
    `select id, environment, started_at, finished_at, playbook_id, trigger, triggered_by, status, summary, steps
     from public.studio_remediation_runs
     where id = $1::uuid and environment = $2 limit 1`,
    [normalized, resolveRemediationEnvironment()],
  );
  return result.rows[0] ? remediationRunFromRow(result.rows[0]) : null;
}

export async function startRemediationRun(
  p: Pool,
  input: { playbookId: string; trigger: string; triggeredBy: string },
): Promise<string> {
  const result = await p.query(
    `insert into public.studio_remediation_runs (environment, playbook_id, trigger, triggered_by, status)
     values ($1, $2, $3, $4, 'running')
     returning id`,
    [resolveRemediationEnvironment(), input.playbookId, input.trigger, input.triggeredBy],
  );
  return String(result.rows[0]?.id ?? '');
}

export interface RemediationReservation {
  reserved: boolean;
  runId?: string;
  reason?: string;
  retryAt?: string | null;
}

/**
 * 原子预约：闸门检查与占位合并为一条条件插入，消除“检查后插入”的并发窗口。
 * 请求方（路由 / alert-worker）在启动 systemd 单元前调用，保证审计行从一开始
 * 就带正确的 trigger/triggered_by；runner 启动后认领这条预约行而不是另插一行。
 *
 * 条件插入本身在无锁下并非原子（两个并发事务可同时观察到“无冲突行”并双双
 * 插入成功 → 双重启主服务），故包一层事务级全局 advisory lock 串行化预约：
 * 自愈触发频率极低，全局锁代价可忽略。
 */
export async function reserveRemediationRun(
  p: Pool,
  config: AlertConfig,
  input: { playbookId: string; trigger: string; triggeredBy: string },
): Promise<RemediationReservation> {
  const cooldownMinutes = Math.max(1, config.global.remediationCooldownMinutes);
  const environment = resolveRemediationEnvironment();
  const insertSql = `insert into public.studio_remediation_runs (environment, playbook_id, trigger, triggered_by, status)
       select $1, $2, $3, $4, 'running'
       where not exists (
         select 1 from public.studio_remediation_runs
         where environment = $1
           and ((status = 'running' and started_at >= now() - interval '20 minutes')
            or (playbook_id = $2 and status in ('running', 'succeeded', 'failed')
                and started_at >= now() - make_interval(mins => $5::int))
       ))
       returning id`;
  const insertParams = [
    environment,
    input.playbookId,
    input.trigger,
    input.triggeredBy,
    cooldownMinutes,
  ];
  // Pool 结构类型只声明 query，但生产注入的是真实 pg Pool；运行时鸭式判定，
  // 拿不到 connect（测试 mock）则回落无条件插入，保持旧行为不阻断。
  const connector = p as unknown as {
    connect?: () => Promise<{
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
      release: () => void;
    }>;
  };
  let id: unknown;
  if (typeof connector.connect !== 'function') {
    const result = await p.query(insertSql, insertParams);
    id = result.rows[0]?.id;
  } else {
    const client = await connector.connect();
    try {
      await client.query('begin');
      await client.query(`select pg_advisory_xact_lock(hashtext('studio_remediation_reserve'))`);
      const result = await client.query(insertSql, insertParams);
      await client.query('commit');
      id = (result.rows[0] as { id?: unknown } | undefined)?.id;
    } catch (error) {
      try {
        await client.query('rollback');
      } catch {
        /* 连接已断，忽略 */
      }
      throw error;
    } finally {
      client.release();
    }
  }
  if (id) return { reserved: true, runId: String(id) };
  const gate = await gateRemediation(p, config, input.playbookId);
  if (gate.allowed) return { reserved: false, reason: 'remediation_reservation_lost' };
  return { reserved: false, reason: gate.reason, retryAt: gate.retryAt };
}

/**
 * runner 认领请求方写入的预约行（闸门已过、归属正确），保留其 trigger/triggered_by；
 * 无可认领行（例如手工 CLI 直跑）时返回 null，由调用方自行闸门复核并建行。
 */
export async function claimRemediationRun(
  p: Pool,
  playbookId: string,
): Promise<{ id: string; trigger: string; triggeredBy: string } | null> {
  const result = await p.query(
    `select id, trigger, triggered_by from public.studio_remediation_runs
     where environment = $1 and playbook_id = $2 and status = 'running'
       and started_at >= now() - interval '15 minutes'
     order by started_at desc limit 1`,
    [resolveRemediationEnvironment(), playbookId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: String(row.id),
    trigger: String(row.trigger),
    triggeredBy: String(row.triggered_by),
  };
}

export async function finishRemediationRun(
  p: Pool,
  id: string,
  input: { status: string; summary: string; steps: RemediationStep[] },
): Promise<void> {
  await p.query(
    `update public.studio_remediation_runs
     set status = $2, summary = $3, steps = $4::jsonb, finished_at = now()
     where id = $1::uuid and environment = $5`,
    [
      id,
      input.status,
      sanitizeOpsSummary(input.summary, 800),
      JSON.stringify(input.steps),
      resolveRemediationEnvironment(),
    ],
  );
}

export type RemediationGate =
  | { allowed: true }
  | { allowed: false; reason: string; retryAt: string | null };

/** 冷却 + 并发闸门：路由层预检与 runner 启动时复核共用，避免自愈风暴。 */
export async function gateRemediation(
  p: Pool,
  config: AlertConfig,
  playbookId: string,
): Promise<RemediationGate> {
  const cooldownMinutes = Math.max(1, config.global.remediationCooldownMinutes);
  const environment = resolveRemediationEnvironment();
  const last = await p.query(
    `select started_at from public.studio_remediation_runs
     where environment = $1 and playbook_id = $2 and status in ('running', 'succeeded', 'failed')
       and started_at >= now() - make_interval(mins => $3::int)
     order by started_at desc limit 1`,
    [environment, playbookId, cooldownMinutes],
  );
  if (last.rows[0]?.started_at) {
    const retryAt = new Date(
      new Date(String(last.rows[0].started_at)).getTime() + cooldownMinutes * 60_000,
    ).toISOString();
    return { allowed: false, reason: 'remediation_cooldown', retryAt };
  }
  const running = await p.query(
    `select id from public.studio_remediation_runs
     where environment = $1 and status = 'running' and started_at >= now() - interval '20 minutes'
     limit 1`,
    [environment],
  );
  if (running.rows[0])
    return { allowed: false, reason: 'remediation_already_running', retryAt: null };
  return { allowed: true };
}

export interface RemediationRequestResult {
  accepted: boolean;
  /** Durable audit row id, so callers can verify the exact asynchronous run. */
  runId?: string;
  reason?: string;
  retryAt?: string | null;
  error?: string;
}

/**
 * 触发自愈：只启动白名单 systemd 模板单元，真实命令序列在 runner 里执行。
 * 与 run-checks 相同，用 --no-block 让 oneshot 单元异步运行，调用方不被阻塞。
 */
export async function requestRemediation(
  config: AlertConfig,
  playbookId: string,
  trigger: RemediationTrigger,
  triggeredBy: string,
): Promise<RemediationRequestResult> {
  const playbook = getRemediationPlaybook(playbookId);
  if (!playbook) return { accepted: false, reason: 'unknown_remediation_playbook' };
  if (!isRemediationPlaybookActionEnabled(playbook.id)) {
    return { accepted: false, reason: 'remediation_playbook_disabled' };
  }
  try {
    assertProductionRemediationEnvironment();
  } catch (error) {
    return {
      accepted: false,
      reason: error instanceof Error ? error.message : 'remediation_non_production_disabled',
    };
  }
  let p: Pool | null = null;
  try {
    const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
    if (!connectionString) return { accepted: false, error: 'remediation_store_unavailable' };
    const pgMod = (await import('pg' as string)) as {
      default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
    };
    p = new pgMod.default.Pool({ connectionString, max: 2 });
    await ensureRemediationSchema(p);
    // 原子预约：闸门与占位在同一条条件插入中完成，并发触发只有一个能成功。
    const reservation = await reserveRemediationRun(p, config, {
      playbookId,
      trigger,
      triggeredBy,
    });
    if (!reservation.reserved || !reservation.runId) {
      return {
        accepted: false,
        reason: reservation.reason ?? 'remediation_reservation_lost',
        retryAt: reservation.retryAt,
      };
    }
    try {
      await execFileAsync(
        'systemctl',
        ['start', '--no-block', `rdstudio-remediation@${playbook.id}.service`],
        { timeout: 15_000, maxBuffer: 200_000 },
      );
    } catch (error) {
      // 单元启动失败时把预约行标记为失败，避免占位空转挡住后续自愈。
      await finishRemediationRun(p, reservation.runId, {
        status: 'failed',
        summary: 'systemd 单元启动失败，自愈未执行',
        steps: [],
      }).catch(() => {});
      return {
        accepted: false,
        error: sanitizeOpsSummary(error, 240) || 'remediation_start_failed',
      };
    }
    console.log(
      `[remediation] started playbook=${playbook.id} trigger=${trigger} by=${triggeredBy || 'unknown'} run=${reservation.runId}`,
    );
    return { accepted: true, runId: reservation.runId };
  } catch (error) {
    return { accepted: false, error: sanitizeOpsSummary(error, 240) || 'remediation_start_failed' };
  } finally {
    await p?.end().catch(() => {});
  }
}

export interface RemediationOverview {
  playbooks: RemediationPlaybook[];
  runs: RemediationRun[];
  gates: Record<string, { allowed: boolean; reason?: string; retryAt?: string | null }>;
  autoRemediation: boolean;
  cooldownMinutes: number;
}

/** 看板自愈中心数据：剧本清单 + 最近执行 + 各剧本闸门状态。 */
export async function getRemediationOverview(config: AlertConfig): Promise<RemediationOverview> {
  const base = {
    playbooks: REMEDIATION_PLAYBOOKS.filter((playbook) =>
      isRemediationPlaybookActionEnabled(playbook.id),
    ),
    autoRemediation: config.global.autoRemediation,
    cooldownMinutes: config.global.remediationCooldownMinutes,
  };
  const connectionString = String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
  if (!connectionString) return { ...base, runs: [], gates: {} };
  const pgMod = (await import('pg' as string)) as {
    default: { Pool: new (cfg: { connectionString: string; max?: number }) => Pool };
  };
  const p = new pgMod.default.Pool({ connectionString, max: 2 });
  try {
    await ensureRemediationSchema(p);
    const runs = await listRemediationRuns(p, 10);
    const gates: RemediationOverview['gates'] = {};
    for (const playbook of base.playbooks) {
      const gate = await gateRemediation(p, config, playbook.id);
      gates[playbook.id] = gate.allowed
        ? { allowed: true }
        : { allowed: false, reason: gate.reason, retryAt: gate.retryAt };
    }
    return { ...base, runs, gates };
  } finally {
    await p.end().catch(() => {});
  }
}

export interface RemediationNotice {
  playbookTitle: string;
  statusLabel: '执行中' | '成功' | '失败' | '被闸门拒绝';
  summary: string;
  trigger: string;
  triggeredBy: string;
}

/** 自愈通知卡片配色：成功绿、失败红、执行中蓝、被闸门拒绝橙。 */
function remediationCardSpec(notice: RemediationNotice): {
  template: 'red' | 'orange' | 'green' | 'blue';
  emoji: string;
  color: string;
} {
  switch (notice.statusLabel) {
    case '成功':
      return { template: 'green', emoji: '✅', color: 'green' };
    case '失败':
      return { template: 'red', emoji: '❌', color: 'red' };
    case '执行中':
      return { template: 'blue', emoji: '⏳', color: 'blue' };
    default:
      return { template: 'orange', emoji: '🚫', color: 'orange' };
  }
}

function buildFeishuRemediationCard(
  config: AlertConfig,
  notice: RemediationNotice,
): Record<string, unknown> {
  const spec = remediationCardSpec(notice);
  const triggerLabel = notice.trigger === 'auto' ? '自动自愈' : '一键自愈';
  return {
    config: { wide_screen_mode: true },
    header: {
      template: spec.template,
      title: {
        tag: 'plain_text',
        content: `${spec.emoji} [${config.notification.titlePrefix} · 自愈] ${triggerLabel} · ${notice.playbookTitle}`,
      },
    },
    elements: [
      {
        tag: 'markdown',
        content: [
          `**环境** ${config.global.environmentLabel}　|　**触发** ${triggerLabel}　|　**执行人** ${notice.triggeredBy || 'ops'}`,
          `**时间** ${new Date()
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d+Z$/, '')} UTC`,
          `**结果** <font color='${spec.color}'>${notice.statusLabel}</font>`,
        ].join('\n'),
      },
      { tag: 'markdown', content: `**摘要** ${notice.summary}` },
      { tag: 'hr' },
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '查看看板' },
            type: 'default',
            url: config.notification.dashboardUrl,
          },
        ],
      },
    ],
  };
}

/** 自愈结果按原告警渠道回投；影子模式/未配置时只落日志，与告警投递语义一致。 */
export async function deliverRemediationNotice(
  config: AlertConfig,
  notice: RemediationNotice,
): Promise<{ delivered: boolean; channel: string; error?: string }> {
  const channel = config.notification.channel;
  const url =
    channel === 'feishu'
      ? config.notification.feishuWebhookUrl.trim()
      : config.notification.webhookUrl.trim();
  const triggerLabel = notice.trigger === 'auto' ? '自动自愈' : '一键自愈';
  const message = `[${config.notification.titlePrefix} · 自愈] ${triggerLabel} · ${notice.playbookTitle}
环境：${config.global.environmentLabel}
时间：${new Date().toISOString()}
结果：${notice.statusLabel}
摘要：${notice.summary}
执行人：${notice.triggeredBy || 'ops'}
看板：${config.notification.dashboardUrl}`;
  if (!config.notification.enabled || config.notification.shadowMode || !url) {
    console.log(`[remediation][shadow] ${message.replace(/\n/g, ' | ')}`);
    return {
      delivered: false,
      channel: url ? 'shadow' : 'unconfigured',
      error: !url ? `${channel}_contact_point_not_configured` : 'shadow_mode',
    };
  }
  const result = await sendWebhookPayload(
    url,
    {
      schema: 'rdk.studio.remediation.v1',
      playbook: notice.playbookTitle,
      status: notice.statusLabel,
      trigger: notice.trigger,
      triggeredBy: notice.triggeredBy,
      summary: notice.summary,
      environment: config.global.environmentLabel,
      message,
      dashboardUrl: config.notification.dashboardUrl,
    },
    {
      bearerSecret:
        channel === 'webhook' ? config.notification.bearerSecret || undefined : undefined,
      feishuSignSecret:
        channel === 'feishu' ? config.notification.feishuSignSecret || undefined : undefined,
      forceFeishuFormat: channel === 'feishu',
      feishuText: message,
      feishuCard: channel === 'feishu' ? buildFeishuRemediationCard(config, notice) : undefined,
      logTag: 'remediation',
      suppressResponseBodyInLogs: true,
    },
  );
  return {
    delivered: result.ok,
    channel,
    ...(result.error ? { error: sanitizeOpsSummary(result.error, 240) } : {}),
  };
}
