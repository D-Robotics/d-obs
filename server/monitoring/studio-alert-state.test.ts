/** 告警状态机回归测试：Pending→open→reminder/escalated→resolved 全链路。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  reconcileAlertState,
  type AlertObservation,
  type AlertWorkerState,
} from './studio-alert-state.js';

const emptyState = (): AlertWorkerState => ({ version: 1, keys: {} });

function observation(overrides: Partial<AlertObservation> = {}): AlertObservation {
  return {
    key: 'ai-run-degraded-rate',
    title: 'AI 对话失败率异常',
    severity: 'warning',
    unhealthy: false,
    summary: 'ok',
    openAfter: 2,
    resolveAfter: 2,
    ...overrides,
  } as AlertObservation;
}

function observe(
  state: AlertWorkerState,
  obs: AlertObservation[],
  now = new Date(),
  options?: Parameters<typeof reconcileAlertState>[3],
): ReturnType<typeof reconcileAlertState> {
  return reconcileAlertState(state, obs, now, options);
}

test('连续失败不足 openAfter 时保持 Pending，不开事故', () => {
  let { state } = observe(emptyState(), [observation({ unhealthy: true })]);
  assert.equal(state.keys['ai-run-degraded-rate']?.active, false);
  assert.equal(state.keys['ai-run-degraded-rate']?.failureStreak, 1);
  ({ state } = observe(state, [observation({ unhealthy: true })]));
  // openAfter=2：第二次失败才开。
  assert.equal(state.keys['ai-run-degraded-rate']?.active, true);
  assert.equal(state.keys['ai-run-degraded-rate']?.failureStreak, 2);
});

test('连续成功不足 resolveAfter 时事故保持 open', () => {
  let { state, transitions } = observe(
    emptyState(),
    [observation({ unhealthy: true }), observation({ unhealthy: true })],
  );
  assert.equal(transitions.filter((t) => t.kind === 'opened').length, 1);
  ({ state, transitions } = observe(state, [observation()]));
  assert.equal(state.keys['ai-run-degraded-rate']?.active, true);
  assert.equal(transitions.length, 0);
  ({ state, transitions } = observe(state, [observation()]));
  assert.equal(state.keys['ai-run-degraded-rate']?.active, false);
  assert.match(transitions[0]?.summary ?? '', /连续 2 次检查正常/);
  assert.equal(transitions[0]?.kind, 'resolved');
  // 恢复后 streak 归零，firstSeen 清空，可重新开事故。
  assert.equal(state.keys['ai-run-degraded-rate']?.firstSeenAt, undefined);
});

test('unknown 观测不开启也不恢复：数据库不可用不得误关事故', () => {
  let { state } = observe(
    emptyState(),
    [observation({ unhealthy: true }), observation({ unhealthy: true })],
  );
  assert.equal(state.keys['ai-run-degraded-rate']?.active, true);
  const streakBefore = state.keys['ai-run-degraded-rate']?.failureStreak;
  ({ state } = observe(state, [observation({ unknown: true, unhealthy: true })]));
  assert.equal(state.keys['ai-run-degraded-rate']?.active, true);
  assert.equal(state.keys['ai-run-degraded-rate']?.failureStreak, streakBefore);
  // unknown 期间不算成功，恢复判定不推进。
  ({ state } = observe(state, [observation({ unknown: true, unhealthy: false })]));
  assert.equal(state.keys['ai-run-degraded-rate']?.successStreak, 0);
});

test('severity 从 warning 升级到 critical 产出 escalated 转换', () => {
  let { state, transitions } = observe(
    emptyState(),
    [observation({ unhealthy: true }), observation({ unhealthy: true })],
  );
  assert.equal(transitions[0]?.kind, 'opened');
  // 标记已通知（模拟通知投递成功后的状态回写）。
  state.keys['ai-run-degraded-rate']!.notified = true;
  state.keys['ai-run-degraded-rate']!.lastNotifiedAt = new Date().toISOString();
  ({ transitions } = observe(state, [observation({ unhealthy: true, severity: 'critical' })]));
  assert.equal(transitions[0]?.kind, 'escalated');
  assert.equal(transitions[0]?.severity, 'critical');
});

test('reminder 受冷却时间约束，冷却内不重复提醒', () => {
  const start = new Date('2026-09-01T00:00:00Z');
  let { state, transitions } = observe(
    emptyState(),
    [observation({ unhealthy: true }), observation({ unhealthy: true })],
    start,
  );
  state.keys['ai-run-degraded-rate']!.notified = true;
  state.keys['ai-run-degraded-rate']!.lastNotifiedAt = start.toISOString();
  // 冷却 30 分钟内：无 reminder。
  ({ state, transitions } = observe(
    state,
    [observation({ unhealthy: true })],
    new Date('2026-09-01T00:10:00Z'),
  ));
  assert.equal(transitions.length, 0);
  // 超过冷却：产出 reminder。
  ({ state, transitions } = observe(
    state,
    [observation({ unhealthy: true })],
    new Date('2026-09-01T00:31:00Z'),
    { cooldownMinutes: 30 },
  ));
  assert.equal(transitions[0]?.kind, 'reminder');
});

test('全局关闭提醒或观测级关闭提醒后不再 reminder', () => {
  // 全局关闭。
  {
    const start = new Date('2026-09-01T00:00:00Z');
    let { state } = observe(
      emptyState(),
      [observation({ unhealthy: true }), observation({ unhealthy: true })],
      start,
    );
    state.keys['ai-run-degraded-rate']!.notified = true;
    state.keys['ai-run-degraded-rate']!.lastNotifiedAt = start.toISOString();
    const { transitions } = observe(
      state,
      [observation({ unhealthy: true })],
      new Date('2026-09-01T02:00:00Z'),
      { remindersEnabled: false },
    );
    assert.equal(transitions.length, 0);
  }
  // 观测级关闭（北极星天级指标的降噪路径）。
  {
    const start = new Date('2026-09-01T00:00:00Z');
    let { state } = observe(
      emptyState(),
      [observation({ unhealthy: true }), observation({ unhealthy: true })],
      start,
    );
    state.keys['ai-run-degraded-rate']!.notified = true;
    state.keys['ai-run-degraded-rate']!.lastNotifiedAt = start.toISOString();
    const { transitions } = observe(
      state,
      [observation({ unhealthy: true, remindersEnabled: false })],
      new Date('2026-09-01T02:00:00Z'),
    );
    assert.equal(transitions.length, 0);
  }
});

test('规则停用后活动事故自动关闭', () => {
  let { state } = observe(
    emptyState(),
    [observation({ unhealthy: true }), observation({ unhealthy: true })],
  );
  assert.equal(state.keys['ai-run-degraded-rate']?.active, true);
  const { state: next, transitions } = observe(state, [observation({ enabled: false })]);
  assert.equal(next.keys['ai-run-degraded-rate']?.active, false);
  assert.equal(transitions[0]?.kind, 'resolved');
  assert.match(transitions[0]?.summary ?? '', /规则已停用/);
});

test('影子模式（未通知）下 opened 转换按冷却重试，不永久吞事故', () => {
  const start = new Date('2026-09-01T00:00:00Z');
  let { state, transitions } = observe(
    emptyState(),
    [observation({ unhealthy: true }), observation({ unhealthy: true })],
    start,
  );
  assert.equal(transitions[0]?.kind, 'opened');
  // 模拟投递层写回的尝试时间（notified 仍为 false = 影子模式/未配渠道）。
  state.keys['ai-run-degraded-rate']!.lastAttemptAt = start.toISOString();
  // 冷却内不重试。
  ({ state, transitions } = observe(
    state,
    [observation({ unhealthy: true })],
    new Date('2026-09-01T00:10:00Z'),
  ));
  assert.equal(transitions.length, 0);
  // 冷却到期后重新产出 opened，渠道补齐后仍会尝试通知。
  ({ transitions } = observe(
    state,
    [observation({ unhealthy: true })],
    new Date('2026-09-01T00:31:00Z'),
  ));
  assert.equal(transitions[0]?.kind, 'opened');
});

test('streak 交替：失败一次成功一次不产生转换', () => {
  let { state, transitions } = observe(emptyState(), [observation({ unhealthy: true })]);
  assert.equal(transitions.length, 0);
  ({ state, transitions } = observe(state, [observation()]));
  assert.equal(transitions.length, 0);
  assert.equal(state.keys['ai-run-degraded-rate']?.failureStreak, 0);
  assert.equal(state.keys['ai-run-degraded-rate']?.successStreak, 1);
  ({ state, transitions } = observe(state, [observation({ unhealthy: true })]));
  // 成功后 failure streak 从 0 重新计，1 < openAfter=2 不开事故。
  assert.equal(transitions.length, 0);
  assert.equal(state.keys['ai-run-degraded-rate']?.failureStreak, 1);
});
