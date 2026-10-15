import assert from 'node:assert/strict';
import { test } from 'node:test';
import vm from 'node:vm';
import {
  createRunTraceLifecycle,
  createSessionTraceLifecycle,
  createTraceWorkspaceLifecycle,
  type SessionTraceLifecycleState,
  type TraceModuleLifecycle,
} from './observability-page-trace-lifecycle.js';
import { OPS_OBSERVABILITY_SCRIPT_OVERVIEW_WINDOW } from './observability-page-script-c.js';

function fixture() {
  const events: string[] = [];
  let active: 'runs' | 'sessions' | 'overview' = 'runs';
  const state: SessionTraceLifecycleState = {
    requestToken: 4, controller: { abort() { events.push('abort-session'); } },
    sessions: [{ sessionRef: 'previous-account' }], page: { nextCursor: 'old' },
    key: 'previous-scope', expanded: new Set(['previous-account']), renderState: [],
    loading: true, error: 'old-error', query: 'keep-search', unassignedRunCount: 2,
    overviewRef: {}, backgroundLoading: true,
  };
  const runs = createRunTraceLifecycle({
    cancelPage() { events.push('cancel-run'); },
    resetDetail() { events.push('reset-detail'); },
    clearList() { events.push('clear-runs'); },
    clearDetail() { events.push('remove-detail'); },
    isActive() { return active === 'runs'; },
    refreshView() { events.push('refresh-runs'); },
  });
  const sessions = createSessionTraceLifecycle({
    state, isActive() { return active === 'sessions'; },
    refreshView() { events.push('refresh-sessions'); },
    clearView() { events.push('clear-sessions'); },
  });
  const workspace = createTraceWorkspaceLifecycle({ runs, sessions });
  return { events, state, workspace, active(value: typeof active) { active = value; } };
}

test('scope changes invalidate requests and clear scoped data while preserving a time-window search', () => {
  const h = fixture();
  h.workspace.scopeChanged({ reason: 'time-window' });
  assert.equal(h.state.requestToken, 5, 'late responses retain the invalidated token');
  assert.equal(h.state.controller, null);
  assert.deepEqual(h.state.sessions, []);
  assert.equal(h.state.page, null);
  assert.equal(h.state.expanded.size, 0);
  assert.equal(h.state.backgroundLoading, false);
  assert.equal(h.state.loading, false);
  assert.equal(h.state.query, 'keep-search');
  assert.deepEqual(h.events, ['cancel-run', 'reset-detail', 'remove-detail', 'abort-session', 'clear-sessions']);
  h.workspace.scopeChanged({ reason: 'identity' });
  assert.equal(h.state.query, '', 'a departing identity cannot retain another account search');
  assert.equal(h.state.requestToken, 6);
  assert.ok(h.events.includes('clear-runs'));
});

test('workspace refresh selects one active module and disposal cancels both owners', () => {
  const h = fixture();
  h.workspace.refresh();
  h.active('sessions'); h.workspace.refresh();
  h.active('overview'); h.workspace.refresh();
  assert.deepEqual(h.events, ['refresh-runs', 'refresh-sessions']);
  h.events.length = 0;
  h.workspace.dispose();
  assert.deepEqual(h.events, ['cancel-run', 'reset-detail', 'clear-runs', 'remove-detail', 'abort-session', 'clear-sessions']);
  assert.equal(h.state.query, '');
  assert.equal(h.state.requestToken, 5);
});

test('overview time-window control needs only the lifecycle contract, with no trace private state or DOM', async () => {
  const events: string[] = [];
  const state = { overviewHours: 24, overviewLoadRequestToken: 0, overview: {}, investigationOverview: {} };
  const select = { value: '24' };
  const lifecycle: TraceModuleLifecycle = {
    scopeChanged(change) { events.push('scope:' + change.reason); },
    refresh() { events.push('refresh'); },
    dispose() {},
  };
  const context = vm.createContext({ state, $: () => select, nativeTraceWorkspace: lifecycle,
    loadAll: async (force: boolean) => { assert.equal(force, true); events.push('load'); } });
  vm.runInContext(OPS_OBSERVABILITY_SCRIPT_OVERVIEW_WINDOW + '\nglobalThis.change=changeOverviewWindow;', context);
  await context.change(2);
  assert.deepEqual(events, ['scope:time-window', 'refresh', 'load']);
  assert.equal(state.overviewHours, 2);
  assert.equal(state.overview, null);
  assert.equal(state.investigationOverview, null);
  assert.equal(select.value, '2');
});
