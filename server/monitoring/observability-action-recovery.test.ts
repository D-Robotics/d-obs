/**
 * 行动环恢复路径回归测试：worker 后置验证推进（executing → 终态）与
 * origin 溯源在 propose/row 映射两端的保真。
 *
 * verifyExecutingObservabilityActions 用内存 pg 替身模拟 store：只验证
 * 状态机语义（终态才推进、缺失 run 走宽限期、状态冲突不中断整轮），
 * 不触真实数据库。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applyActionVerification,
  insertObservabilityAction,
  proposeObservabilityAction,
  rowToActionForTest,
  updateObservabilityAction,
  verifyExecutingObservabilityActions,
  type ActionStorePool,
  type ObservabilityActionRecord,
} from './observability-action-loop.js';

type PgResult = { rows: Array<Record<string, unknown>>; rowCount?: number | null };

const RUN_ID = '0f1e2d3c-4b5a-4978-8a9b-0c1d2e3f4a5b';

const READY_ROW = {
  relation_exists: true,
  rls_enabled: true,
  columns_ready: true,
  nullability_ready: true,
  constraints_ready: true,
  indexes_ready: true,
  privileges_ready: true,
};

/** readiness 探针（pg_catalog CTE）先行，再按表名路由到具体 fake。 */
function routeQuery(
  pool: ActionStorePool,
  remediationRuns: () => PgResultLike = () => ({ rows: [] }),
): ActionStorePool {
  return {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes('relrowsecurity')) {
        // 两个 readiness 探针都长这样，返回全绿即可。
        return { rows: [READY_ROW] };
      }
      if (sql.includes('studio_remediation_runs')) {
        return remediationRuns();
      }
      return pool.query(sql, params);
    },
  };
}

type PgResultLike = { rows: Array<Record<string, unknown>>; rowCount?: number | null };

/** action record → 数据库行形态（snake_case + jsonb 字符串），供 rowToAction 消费。 */
function actionRow(action: ObservabilityActionRecord): Record<string, unknown> {
  return {
    id: action.id,
    account_scope_id: action.accountScopeId,
    environment: action.environment,
    run_id: action.runId,
    type: action.type,
    title: action.title,
    rationale: action.rationale,
    playbook_id: action.playbookId,
    evidence_refs: JSON.stringify(action.evidenceRefs),
    requires_approval: action.requiresApproval,
    status: action.status,
    origin: action.origin,
    proposed_by: action.proposedBy,
    approved_by: action.approvedBy,
    approval_expires_at: action.approvalExpiresAt,
    created_at: action.createdAt,
    updated_at: action.updatedAt,
    // pg 的 jsonb 列在 node-postgres 里自动解析成对象（不是字符串）。
    execution: action.execution ?? null,
    regression_marker: action.regressionMarker,
    revision: action.revision,
  };
}

function poolWithActions(actions: ObservabilityActionRecord[]): {
  pool: ActionStorePool;
  writes: Array<{ id: string; status: string }>;
} {
  const writes: Array<{ id: string; status: string }> = [];
  const pool: ActionStorePool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.includes("status = 'executing'")) {
        return {
          rows: actions.filter((action) => action.status === 'executing').map(actionRow),
        };
      }
      if (sql.trim().toLowerCase().startsWith('update')) {
        const updated = actions.find((action) => action.id === String(params?.[0]));
        if (updated) {
          const statusIndex = 4;
          const next = String(params?.[statusIndex]);
          writes.push({ id: updated.id, status: next });
          return { rows: [{ id: updated.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      return { rows: [] };
    },
  };
  return { pool, writes };
}

function executingAction(overrides: Partial<ObservabilityActionRecord> = {}): ObservabilityActionRecord {
  const base = proposeObservabilityAction({
    accountScopeId: 'studio:ops',
    environment: 'production',
    type: 'remediate',
    title: '重启主服务',
    rationale: 'internal-health 持续 5xx',
    playbookId: 'restart-app',
    evidenceRefs: ['event:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'],
    proposedBy: 'user-ops',
  });
  return {
    ...base,
    status: 'executing',
    approvedBy: 'user-ops2',
    execution: {
      accepted: true,
      runId: RUN_ID,
      startedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      finishedAt: null,
      playbookId: 'restart-app',
      request: { accepted: true },
    },
    ...overrides,
  };
}

test('remediation run 成功 → worker 推进为 succeeded', async () => {
  const action = executingAction();
  const { pool, writes } = poolWithActions([action]);
  const combined = routeQuery(pool, () => ({
    rows: [
      {
        id: RUN_ID,
        environment: action.environment,
        started_at: new Date().toISOString(),
        finished_at: new Date().toISOString(),
        playbook_id: 'restart-app',
        trigger: 'manual',
        triggered_by: 'user-ops',
        status: 'succeeded',
        summary: 'restart ok',
        steps: [],
      },
    ],
  }));
  const updated = await verifyExecutingObservabilityActions(combined);
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.status, 'succeeded');
  assert.equal(writes.length, 1);
});

test('run 未终态（running）→ 不推进、不写库', async () => {
  const action = executingAction();
  const { pool, writes } = poolWithActions([action]);
  const combined = routeQuery(pool, () => ({ rows: [{ id: RUN_ID, status: 'running' }] }));
  const updated = await verifyExecutingObservabilityActions(combined);
  assert.deepEqual(updated, []);
  assert.deepEqual(writes, []);
});

test('run 缺失且超过宽限期 → verification_failed', async () => {
  const action = executingAction();
  const { pool, writes } = poolWithActions([action]);
  const combined = routeQuery(pool);
  const updated = await verifyExecutingObservabilityActions(combined, {
    lookupGraceMs: 60_000,
  });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.status, 'verification_failed');
  assert.equal(writes.length, 1);
});

test('run 缺失但在宽限期内 → 不推进', async () => {
  const action = executingAction({
    execution: {
      accepted: true,
      runId: RUN_ID,
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      finishedAt: null,
      playbookId: 'restart-app',
      request: { accepted: true },
    },
  });
  const { pool, writes } = poolWithActions([action]);
  const combined = routeQuery(pool);
  const updated = await verifyExecutingObservabilityActions(combined, {
    lookupGraceMs: 5 * 60_000,
  });
  assert.deepEqual(updated, []);
  assert.deepEqual(writes, []);
});

test('state conflict 单条失败不中断整轮 pass', async () => {
  const conflicting = executingAction();
  const healthy = executingAction();
  healthy.id = 'action-11111111-2222-3333-8444-555555555555';
  const { pool, writes } = poolWithActions([conflicting, healthy]);
  // 同一 pool 先返回两条 executing；update 对 conflicting 抛冲突。
  const inner: ActionStorePool = {
    async query(sql: string, params?: unknown[]) {
      if (sql.trim().toLowerCase().startsWith('update')) {
        if (String(params?.[0]) === conflicting.id) {
          throw new Error('action_state_conflict');
        }
        writes.push({ id: String(params?.[0]), status: String(params?.[4]) });
        return { rows: [{ id: String(params?.[0]) }], rowCount: 1 };
      }
      return pool.query(sql, params);
    },
  };
  const combined = routeQuery(inner, () => ({
    rows: [{ id: RUN_ID, status: 'succeeded' }],
  }));
  const updated = await verifyExecutingObservabilityActions(combined);
  // conflict 被跳过，healthy 正常推进。
  assert.equal(updated.length, 1);
  assert.equal(updated[0]!.id, healthy.id);
  assert.equal(updated[0]!.status, 'succeeded');
});

test('applyActionVerification：pending 不动状态，终态写 regression marker', () => {
  const action = executingAction();
  const pending = applyActionVerification(action, {
    ok: false,
    pending: true,
    checkedAt: new Date().toISOString(),
    detail: 'run still executing',
    checks: [{ name: 'remediation-run', ok: false, detail: 'pending' }],
  });
  assert.equal(pending.status, 'executing');
  assert.equal(pending.regressionMarker, null);

  const failed = applyActionVerification(action, {
    ok: false,
    checkedAt: new Date().toISOString(),
    detail: 'run failed',
    checks: [{ name: 'remediation-run', ok: false, detail: 'failed' }],
  });
  assert.equal(failed.status, 'verification_failed');
  assert.equal(failed.regressionMarker, 'post-check-failed');
});

test('origin 在 propose 校验与 row 映射两端保真', () => {
  const human = proposeObservabilityAction({
    accountScopeId: 'studio:ops',
    environment: 'production',
    type: 'observe',
    title: '观察 5xx 趋势',
    rationale: '',
    evidenceRefs: ['event:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'],
    proposedBy: 'user-ops',
  });
  assert.equal(human.origin, 'human');

  const ai = proposeObservabilityAction({
    accountScopeId: 'studio:ops',
    environment: 'production',
    type: 'observe',
    title: '观察 5xx 趋势',
    rationale: '',
    evidenceRefs: ['event:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'],
    proposedBy: 'user-ops',
    origin: 'ai-copilot',
  });
  assert.equal(ai.origin, 'ai-copilot');

  const invalid = proposeObservabilityAction({
    accountScopeId: 'studio:ops',
    environment: 'production',
    type: 'observe',
    title: '观察 5xx 趋势',
    rationale: '',
    evidenceRefs: ['event:0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b'],
    proposedBy: 'user-ops',
    origin: 'agent-autonomous' as unknown as 'human',
  });
  assert.equal(invalid.origin, 'human');

  assert.equal(rowToActionForTest(actionRow({ ...ai, origin: 'ai-copilot' })).origin, 'ai-copilot');
  assert.equal(rowToActionForTest(actionRow({ ...human })).origin, 'human');
  assert.equal(rowToActionForTest({ ...actionRow(human), origin: null }).origin, 'human');
});

void insertObservabilityAction;
void updateObservabilityAction;
