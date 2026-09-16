/**
 * 事件域租户隔离回归：
 *  - 归属租户只来自摄取身份，非法/缺省值收敛到 platform；
 *  - 指纹含租户（否则可跨租户压制同名事件）；
 *  - 写入与去重都带 tenant_id；
 *  - 平台侧读取点（看板/告警/指标/Run 证据）逐条带 `tenant_id = 'platform'`——
 *    这条用源码静态检查兜底，因为漏一处就会让租户数据混进平台口径。
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';

import {
  OPS_EVENT_PLATFORM_TENANT,
  buildOpsEventFingerprint,
  configureOpsEventPoolForTest,
  recordOpsEvent,
  resolveOpsEventTenantId,
} from './ops-event-store.js';

/** 仓库根（本测试位于 server/monitoring/ 下）。 */
const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

type Query = { text: string; params?: unknown[] };

/** 只回空行的假池：记录 SQL 与参数，用来断言写入/去重语句的形状。 */
function recordingPool(queries: Query[]): {
  query: (text: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
} {
  return {
    query: async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      return { rows: [] };
    },
  };
}

const ENV_KEYS = ['RDK_CHAT_CREDITS_DB_URL', 'RDK_ALERT_LOG_ERRORS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.RDK_CHAT_CREDITS_DB_URL = 'postgres://test:test@127.0.0.1:1/none';
  configureOpsEventPoolForTest(null);
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  configureOpsEventPoolForTest(null);
});

test('租户归属解析：只接受合法租户 id，其余一律 platform', () => {
  assert.equal(resolveOpsEventTenantId({ tenantId: 'sim2real' }), 'sim2real');
  assert.equal(resolveOpsEventTenantId({ tenantId: ' platform ' }), 'platform');
  assert.equal(resolveOpsEventTenantId({}), OPS_EVENT_PLATFORM_TENANT);
  assert.equal(resolveOpsEventTenantId({ tenantId: '' }), 'platform');
  // 非法形状（大写/点/过短/保留写法）不得被当成租户，否则能伪造归属。
  for (const bad of ['Sim2Real', 'a', 'team.a', 'team a', '-team', 'a'.repeat(41), 'x'.repeat(64)]) {
    assert.equal(resolveOpsEventTenantId({ tenantId: bad }), 'platform', bad);
  }
});

test('指纹含租户：同名事件在不同归属下指纹不同（防跨租户压制）', () => {
  const base = { component: 'web', eventCode: 'http_5xx', outcome: 'error' as const, fingerprintParts: ['fp-1'] };
  const platform = buildOpsEventFingerprint({ ...base, tenantId: 'platform' });
  const tenant = buildOpsEventFingerprint({ ...base, tenantId: 'sim2real' });
  const other = buildOpsEventFingerprint({ ...base, tenantId: 'mujoco-lab' });
  assert.notEqual(platform, tenant);
  assert.notEqual(tenant, other);
  // 同租户同内容稳定（幂等去重仍然有效）。
  assert.equal(tenant, buildOpsEventFingerprint({ ...base, tenantId: 'sim2real' }));
  // 未声明租户等价于 platform。
  assert.equal(buildOpsEventFingerprint(base), platform);
});

test('写入：insert 带 tenant_id，去重窗口按 tenant_id 过滤', async () => {
  const queries: Query[] = [];
  configureOpsEventPoolForTest(recordingPool(queries));
  const ok = await recordOpsEvent({
    tenantId: 'sim2real',
    component: 'web',
    eventCode: 'run_created',
    outcome: 'ok',
    fingerprintParts: ['e-1'],
    dedupeWithinMs: 60_000,
  });
  assert.equal(ok, true);
  const insert = queries.find((q) => q.text.includes('insert into public.studio_ops_events'));
  assert.ok(insert, '应执行 insert');
  assert.match(insert.text, /tenant_id/);
  assert.equal(insert.params?.at(-1), 'sim2real');
  const dedupe = queries.find((q) => q.text.includes('from public.studio_ops_events'));
  assert.ok(dedupe, '应执行去重查询');
  assert.match(dedupe.text, /and tenant_id = \$4/);
  assert.equal(dedupe.params?.at(-1), 'sim2real');
});

test('写入：缺省租户归属 platform', async () => {
  const queries: Query[] = [];
  configureOpsEventPoolForTest(recordingPool(queries));
  await recordOpsEvent({ component: 'web', eventCode: 'run_created', outcome: 'ok' });
  const insert = queries.find((q) => q.text.includes('insert into public.studio_ops_events'));
  assert.equal(insert?.params?.at(-1), 'platform');
});

/**
 * 平台侧读取点静态检查。
 *
 * `studio_ops_events` 的读取方一律是平台口径（平台看板/平台告警规则/Run 证据/
 * 平台登录指标），必须带 `tenant_id = 'platform'`。新增查询漏掉这个过滤就会让
 * 租户数据混进平台信号，而这类回归没有数据库就测不出来——所以在这里做源码级
 * 兜底：每个读取点必须在紧随其后的若干行内出现 tenant 过滤。
 *
 * 唯一豁免：全局保留期清理（delete ... where occurred_at < ...），它本来就应
 * 该跨租户删除。
 */
test('平台侧每个 studio_ops_events 读取点都带平台租户过滤', async () => {
  const targets = [
    'server/monitoring/observability-store.ts',
    'server/monitoring/studio-alert-worker.ts',
    'server/observability/run-observability-service.ts',
    'server/flywheel/metrics-store.ts',
  ];
  const missing: string[] = [];
  let checked = 0;
  for (const relative of targets) {
    const source = await readFile(path.join(SERVER_ROOT, relative), 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      if (!/from\s+(public\.)?studio_ops_events/.test(line)) return;
      // 语句边界：这些 SQL 是模板字面量，从当前行向后找到收尾的反引号即可拿到
      // 整条语句（长度随 join 数量变化，所以不能用固定行数窗口）。
      let end = index;
      while (end < lines.length && !lines[end].includes('`')) end += 1;
      const statement = lines.slice(index, Math.min(end + 1, lines.length)).join('\n');
      // 保留期清理：全局 delete，本来就应跨租户删除。
      if (/delete\s+from\s+(public\.)?studio_ops_events/i.test(statement)) return;
      checked += 1;
      if (!/tenant_id\s*=\s*'platform'/.test(statement)) {
        missing.push(`${relative}:${index + 1}`);
      }
    });
  }
  assert.ok(checked >= 6, `应检查到至少 6 个读取点，实际 ${checked}`);
  assert.deepEqual(missing, [], `以下读取点缺少 tenant_id = 'platform' 过滤：${missing.join(', ')}`);
});
