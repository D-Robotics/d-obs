/**
 * d-obs 运维事件旁路。
 *
 * 这里只保存告警计算需要的低敏感结构化信号，严禁写入用户提示词、工具参数/结果、
 * Cookie、Token、密钥或原始堆栈。账号/会话/设备标识仅允许进入受运营权限保护的 correlation
 * 字段，用于按需关联既有归档；概览接口必须只返回不可逆引用，不能回传原始标识。
 * 写入失败永远不能影响登录、AI 或 API 主链路。
 */
import { createHash } from 'node:crypto';
import { sanitizeClientErrorLocations } from '../../shared/client-error-location-redaction.js';
import { resolveStudioTraceStoreEnvironment } from '../observability/studio-trace-store.js';
function centralDbUrl() {
    return String(process.env.RDK_CHAT_CREDITS_DB_URL ?? '').trim();
}
export function isOpsEventStoreConfigured() {
    return centralDbUrl().length > 0;
}
let poolReady = null;
async function pool() {
    if (!centralDbUrl())
        throw new Error('RDK_CHAT_CREDITS_DB_URL 未配置');
    if (!poolReady) {
        poolReady = (async () => {
            const pgMod = (await import('pg'));
            return new pgMod.default.Pool({ connectionString: centralDbUrl(), max: 2 });
        })().catch((error) => {
            poolReady = null;
            throw error;
        });
    }
    return poolReady;
}
let schemaReady = null;
export async function ensureOpsEventSchema() {
    if (!isOpsEventStoreConfigured())
        return;
    if (!schemaReady) {
        schemaReady = (async () => {
            const p = await pool();
            await p.query(`
        create table if not exists public.studio_ops_events (
          id uuid primary key default gen_random_uuid(),
          occurred_at timestamptz not null,
          component text not null,
          event_code text not null,
          outcome text not null,
          severity_hint text not null default 'warning',
          fingerprint text not null,
          safe_summary text null,
          metadata jsonb not null default '{}'::jsonb,
          correlation jsonb not null default '{}'::jsonb,
          created_at timestamptz not null default now()
        )
      `);
            await p.query(`alter table public.studio_ops_events
         add column if not exists correlation jsonb not null default '{}'::jsonb`);
            await p.query(`create index if not exists studio_ops_events_occurred_idx
         on public.studio_ops_events (occurred_at desc)`);
            await p.query(`create index if not exists studio_ops_events_code_outcome_idx
         on public.studio_ops_events (event_code, outcome, occurred_at desc)`);
            await p.query(`create index if not exists studio_ops_events_fingerprint_idx
         on public.studio_ops_events (fingerprint, occurred_at desc)`);
            await p.query(`create index if not exists studio_ops_events_run_correlation_idx
         on public.studio_ops_events ((correlation->>'run_id'))
         where correlation->>'run_id' is not null`);
            await p.query(`create index if not exists studio_ops_events_user_correlation_idx
         on public.studio_ops_events ((correlation->>'user_id'), occurred_at desc)
         where correlation->>'user_id' is not null`);
        })().catch((error) => {
            schemaReady = null;
            throw error;
        });
    }
    await schemaReady;
}
const CREDENTIAL_PATTERNS = [
    /\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi,
    /\b(api[_-]?key|token|secret|password|authorization|cookie|set-cookie|x-rdk-sso-session|ccSid|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token)\s*[:=]\s*["']?[^,\s;"']+/gi,
    /\b(?:eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    /\b(?:sk-[A-Za-z0-9_-]{12,}|sb_secret_[A-Za-z0-9_-]{8,})\b/gi,
    /(?:postgres(?:ql)?|mysql|redis):\/\/[^@\s/]+@/gi,
    /([?&](?:token|key|secret|signature|sign|password|access_token|session)=)[^&#\s]+/gi,
    /\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]+/gi,
    /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
];
const DIRECT_IDENTIFIER_PATTERNS = [
    /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    /\b1\d{10}\b/g,
];
function redactWithPatterns(value, patterns) {
    let text = value;
    for (const pattern of patterns) {
        text = text.replace(pattern, (_match, rawLabel) => {
            // RegExp replacers without a capture group receive the numeric match
            // offset as their second argument. Treat only an actual string capture
            // as a label, otherwise offsets such as "7=[REDACTED]" leak into output.
            const label = typeof rawLabel === 'string' ? rawLabel : '';
            if (!label)
                return '[REDACTED]';
            return `${label}${/[=:]$/.test(label) ? '' : '='}[REDACTED]`;
        });
    }
    return text;
}
export function sanitizeOpsSummary(value, maxLength = 500) {
    let text = (value instanceof Error ? value.message : String(value ?? '')).slice(0, 8_192);
    text = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
    text = sanitizeClientErrorLocations(text);
    text = redactWithPatterns(text, CREDENTIAL_PATTERNS);
    text = redactWithPatterns(text, DIRECT_IDENTIFIER_PATTERNS);
    return text.slice(0, Math.max(0, maxLength));
}
function safeSlug(value, fallback) {
    const slug = String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._:-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 96);
    return slug || fallback;
}
function safeMetadata(metadata) {
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(metadata ?? {}).slice(0, 32)) {
        const key = safeSlug(rawKey, '').slice(0, 64);
        if (!key || rawValue === undefined)
            continue;
        if (typeof rawValue === 'string')
            out[key] = sanitizeOpsSummary(rawValue, 240);
        else if (typeof rawValue === 'number' && Number.isFinite(rawValue))
            out[key] = rawValue;
        else if (typeof rawValue === 'boolean' || rawValue === null)
            out[key] = rawValue;
    }
    return out;
}
function safeCorrelationValue(value, maxLength, options = {}) {
    let text = String(value ?? '')
        .slice(0, 8_192)
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    text = redactWithPatterns(text, CREDENTIAL_PATTERNS);
    if (!options.preserveDirectIdentifier) {
        text = redactWithPatterns(text, DIRECT_IDENTIFIER_PATTERNS);
    }
    return text.slice(0, Math.max(0, maxLength));
}
export function sanitizeOpsEventCorrelation(correlation) {
    const source = {
        userId: correlation?.userId,
        sessionId: correlation?.sessionId,
        runId: correlation?.runId,
        deviceId: correlation?.deviceId,
        deviceModel: correlation?.deviceModel,
        clientType: correlation?.clientType,
        channel: correlation?.channel,
        appVersion: correlation?.appVersion,
        // Never trust a producer/body supplied environment.  The observability
        // store resolves it from process configuration and NODE_ENV instead.
        environment: resolveStudioTraceStoreEnvironment(),
    };
    const out = {};
    const keys = [
        ['userId', 'user_id', 240],
        ['sessionId', 'session_id', 240],
        ['runId', 'run_id', 200],
        ['deviceId', 'device_id', 200],
        ['deviceModel', 'device_model', 160],
        ['clientType', 'client_type', 32],
        ['channel', 'channel', 64],
        ['appVersion', 'app_version', 64],
    ];
    for (const [inputKey, outputKey, maxLength] of keys) {
        // userId comes from the authenticated server session and may legitimately be
        // an email/phone account identifier. Every other correlation value can be
        // supplied by telemetry clients, so direct identifiers are redacted there.
        // Credential-shaped content is redacted for all fields.
        const value = safeCorrelationValue(source[inputKey], maxLength, {
            preserveDirectIdentifier: inputKey === 'userId',
        });
        if (value)
            out[outputKey] = value;
    }
    out.environment = resolveStudioTraceStoreEnvironment();
    return out;
}
export function buildOpsEventFingerprint(input) {
    const parts = [
        safeSlug(input.component, 'unknown'),
        safeSlug(input.eventCode, 'unknown'),
        input.outcome,
        ...(input.fingerprintParts ?? []).map((part) => safeSlug(part, '')),
    ];
    return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 24);
}
/**
 * 写入一条低敏感运维事件。返回值只供测试/诊断；业务调用应 fire-and-forget。
 */
export async function recordOpsEvent(input) {
    if (!isOpsEventStoreConfigured())
        return false;
    try {
        await ensureOpsEventSchema();
        const p = await pool();
        const fingerprint = buildOpsEventFingerprint(input);
        const correlation = sanitizeOpsEventCorrelation(input.correlation);
        const dedupeWithinMs = Math.max(0, Math.min(60 * 60_000, Math.floor(Number(input.dedupeWithinMs) || 0)));
        if (dedupeWithinMs > 0) {
            const recent = await p.query(`select 1
         from public.studio_ops_events
         where fingerprint = $1
           and occurred_at >= now() - make_interval(secs => $2::double precision)
           and coalesce(correlation->>'user_id', '') = $3
         limit 1`, [fingerprint, dedupeWithinMs / 1_000, correlation.user_id ?? '']);
            if (recent.rows.length > 0)
                return true;
        }
        await p.query(`insert into public.studio_ops_events
         (occurred_at, component, event_code, outcome, severity_hint, fingerprint, safe_summary, metadata, correlation)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`, [
            input.occurredAt && Number.isFinite(Date.parse(input.occurredAt))
                ? input.occurredAt
                : new Date().toISOString(),
            safeSlug(input.component, 'unknown'),
            safeSlug(input.eventCode, 'unknown'),
            input.outcome,
            input.severityHint ?? (input.outcome === 'error' ? 'warning' : 'info'),
            fingerprint,
            input.safeSummary ? sanitizeOpsSummary(input.safeSummary) : null,
            JSON.stringify(safeMetadata(input.metadata)),
            JSON.stringify(correlation),
        ]);
        return true;
    }
    catch (error) {
        if (String(process.env.RDK_ALERT_LOG_ERRORS ?? '').trim() === '1') {
            console.warn('[ops-events] insert failed:', error instanceof Error ? sanitizeOpsSummary(error.message, 240) : 'unknown');
        }
        return false;
    }
}
