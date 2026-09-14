/**
 * Supabase 连接配置。
 * 优先级：环境变量（本地/CI/安装器注入）> 发版内嵌凭证 > 可选 JSON 文件。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type EmbeddedJson = {
  url?: string;
  secretKey?: string;
  secret_key?: string;
  serviceRoleKey?: string;
  publishableKey?: string;
  table?: string;
};

/**
 * Supabase 对话归档凭证。
 * SECURITY：secretKey 是 RLS-bypass 的服务端密钥——**绝不内嵌进源码/安装包**。
 * 一旦硬编码入仓或随桌面版分发,任何拿到仓库历史或安装包的人都能读取全部租户对话(隐私灾难)。
 * 因此只从【服务器侧】注入,绝不下发到客户端:
 *   - 云端部署:在服务器 env 配 SUPABASE_SECRET_KEY(或放 .gitignore 的 supabase-conversation.embedded.json)→ 正常归档;
 *   - 桌面 / 未配置:key 为空 → 不向 Supabase 写(仅保留本地 JSONL)。安装包不携带 key,也就不再泄露。
 * url 非密钥,可保留默认;切库 / 轮换只改 env,不回写源码。check-no-repo-secrets 会拦截任何把 sb_secret_ 写回仓库的改动。
 */
const SUPABASE_SHIPPING_DEFAULTS = {
  url: process.env.SUPABASE_URL || 'https://pbqmhihtdwhsjaavhzqs.supabase.co',
  secretKey: process.env.SUPABASE_SECRET_KEY || '',
  table: '',
} as const;

function projectRootFromDistServer(): string {
  return path.resolve(__dirname, '..', '..');
}

function tryParseEmbeddedJson(filePath: string): EmbeddedJson | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf-8');
    const j = JSON.parse(raw) as EmbeddedJson;
    return j && typeof j === 'object' ? j : null;
  } catch {
    return null;
  }
}

function pickKeyFromJson(j: EmbeddedJson): string {
  return String(
    j.secretKey
      ?? j.secret_key
      ?? j.serviceRoleKey
      ?? j.publishableKey
      ?? '',
  ).trim();
}

let cachedJson: EmbeddedJson | null | undefined;
let warnedMissingSupabaseKey = false;

function loadEmbeddedJsonOnce(): EmbeddedJson | null {
  if (cachedJson !== undefined) return cachedJson;
  const candidates: string[] = [];
  const dataDir = String(process.env.RDK_DATA_DIR || '').trim();
  if (dataDir) {
    candidates.push(path.join(dataDir, 'supabase-conversation.embedded.json'));
  }
  candidates.push(
    path.join(process.cwd(), 'config', 'supabase-conversation.embedded.json'),
    path.join(projectRootFromDistServer(), 'config', 'supabase-conversation.embedded.json'),
  );
  for (const p of candidates) {
    const j = tryParseEmbeddedJson(p);
    if (j && String(j.url || '').trim() && pickKeyFromJson(j)) {
      cachedJson = j;
      return cachedJson;
    }
  }
  cachedJson = null;
  return null;
}

export function getResolvedSupabaseUrl(): string {
  const env = String(process.env.SUPABASE_URL ?? '').trim();
  if (env) return env;
  const inline = String(SUPABASE_SHIPPING_DEFAULTS.url || '').trim();
  if (inline) return inline;
  const j = loadEmbeddedJsonOnce();
  if (j && String(j.url || '').trim()) return String(j.url).trim();
  return '';
}

export function getResolvedSupabaseKey(): string {
  const env = String(
    process.env.SUPABASE_SECRET_KEY
      ?? process.env.SUPABASE_SERVICE_ROLE_KEY
      ?? process.env.SUPABASE_PUBLISHABLE_KEY
      ?? '',
  ).trim();
  if (env) return env;
  const inline = String(SUPABASE_SHIPPING_DEFAULTS.secretKey || '').trim();
  if (inline) return inline;
  const j = loadEmbeddedJsonOnce();
  const fromJson = j ? pickKeyFromJson(j) : '';
  if (
    !fromJson
    && String(process.env.SUPABASE_CONVERSATION_ENABLED ?? '').trim() === '1'
    && !warnedMissingSupabaseKey
  ) {
    warnedMissingSupabaseKey = true;
    console.warn('[supabase] No secret key configured. Set SUPABASE_SECRET_KEY env var or provide an embedded JSON config file.');
  }
  return fromJson;
}

export function getResolvedSupabaseTable(): string {
  const env = String(process.env.SUPABASE_CONVERSATION_TABLE ?? '').trim();
  if (env) return env;
  const inline = String(SUPABASE_SHIPPING_DEFAULTS.table || '').trim();
  if (inline) return inline;
  const j = loadEmbeddedJsonOnce();
  const t = j && String(j.table || '').trim();
  if (t) return t;
  return 'conversation_turns';
}

export function getResolvedSupabaseRequestTimeoutMs(): number {
  const raw = Number(process.env.SUPABASE_REQUEST_TIMEOUT_MS ?? 10000);
  if (!Number.isFinite(raw)) return 10000;
  return Math.max(1000, Math.min(60000, Math.floor(raw)));
}
