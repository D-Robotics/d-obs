/** The workbench publishes scope changes; each trace module owns its own cleanup. */
export type TraceWorkspaceScopeChange = {
  reason: 'time-window' | 'identity';
};

export interface TraceModuleLifecycle {
  scopeChanged(change: TraceWorkspaceScopeChange): void;
  /** Refresh only when this module is the active trace view. */
  refresh(): void;
  /** Cancel pending work and remove data for the departing identity. */
  dispose(): void;
}

export type TraceWorkspaceModules = {
  runs: TraceModuleLifecycle;
  sessions: TraceModuleLifecycle;
};

export interface SessionTraceLifecycleState {
  requestToken: number;
  controller: { abort(): void } | null;
  sessions: unknown[];
  page: unknown | null;
  key: string;
  expanded: Set<string>;
  renderState: unknown[] | null;
  loading: boolean;
  error: string;
  query: string;
  unassignedRunCount: number;
  overviewRef: unknown | null;
  backgroundLoading: boolean;
}

export type SessionTraceLifecyclePorts = {
  state: SessionTraceLifecycleState;
  isActive(): boolean;
  refreshView(): void;
  clearView(): void;
};

export type RunTraceLifecyclePorts = {
  cancelPage(): void;
  resetDetail(): void;
  clearList(): void;
  clearDetail(): void;
  isActive(): boolean;
  refreshView(): void;
};

/** Request tokens invalidate late responses even when abort is ignored upstream. */
export function createSessionTraceLifecycle(ports: SessionTraceLifecyclePorts): TraceModuleLifecycle {
  return {
    scopeChanged(change) {
      const state = ports.state;
      state.requestToken += 1;
      state.controller?.abort();
      state.controller = null;
      state.sessions = [];
      state.page = null;
      state.key = '';
      state.expanded.clear();
      state.renderState = null;
      state.loading = false;
      state.error = '';
      if (change.reason === 'identity') state.query = '';
      state.unassignedRunCount = 0;
      state.overviewRef = null;
      state.backgroundLoading = false;
      ports.clearView();
    },
    refresh() {
      if (ports.isActive()) ports.refreshView();
    },
    dispose() {
      this.scopeChanged({ reason: 'identity' });
    },
  };
}

export function createRunTraceLifecycle(ports: RunTraceLifecyclePorts): TraceModuleLifecycle {
  return {
    scopeChanged(change) {
      ports.cancelPage();
      ports.resetDetail();
      if (change.reason === 'identity') ports.clearList();
      ports.clearDetail();
    },
    refresh() {
      if (ports.isActive()) ports.refreshView();
    },
    dispose() {
      this.scopeChanged({ reason: 'identity' });
    },
  };
}

/**
 * Keep this factory self-contained: the same checked implementation is embedded
 * in the standalone workbench, without a second handwritten JavaScript version.
 */
export function createTraceWorkspaceLifecycle(modules: TraceWorkspaceModules): TraceModuleLifecycle {
  return {
    scopeChanged(change) {
      modules.runs.scopeChanged(change);
      modules.sessions.scopeChanged(change);
    },
    refresh() {
      modules.runs.refresh();
      modules.sessions.refresh();
    },
    dispose() {
      modules.runs.dispose();
      modules.sessions.dispose();
    },
  };
}

export const OPS_OBSERVABILITY_SCRIPT_TRACE_LIFECYCLE = [
  `const createSessionTraceLifecycle = ${createSessionTraceLifecycle.toString()};`,
  `const createRunTraceLifecycle = ${createRunTraceLifecycle.toString()};`,
  `const createTraceWorkspaceLifecycle = ${createTraceWorkspaceLifecycle.toString()};`,
].join('\n') + '\n';
