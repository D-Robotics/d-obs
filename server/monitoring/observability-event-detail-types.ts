import type { StudioDeploymentEnvironment } from '../../shared/studio-observability.js';

export interface OpsEventContextSummary {
  user: { displayName: string | null; ref: string } | null;
  clientType: string | null;
  channel: string | null;
  appVersion: string | null;
  device: { model: string | null; ref: string | null } | null;
  runRef: string | null;
  sessionRef: string | null;
  detailsAvailable: boolean;
}

export interface OpsEventDetail {
  event: {
    id: string;
    occurredAt: string | null;
    component: string;
    eventCode: string;
    outcome: string;
    severity: string;
    summary: string;
    metadata: Record<string, string | number | boolean | null>;
    environment: StudioDeploymentEnvironment | null;
  };
  context: OpsEventContextSummary;
  run: {
    ref: string;
    outcome: string;
    toolSequence: string[];
    toolCallCount: number;
    elapsedMs: number;
    model: string | null;
    errorCategory: string | null;
    retryCount: number;
    startedAt: string | null;
    completedAt: string | null;
  } | null;
  conversation: {
    status: 'available' | 'missing-correlation' | 'not-found';
    turns: Array<{
      recordedAt: string | null;
      userMessage: string;
      assistantMessage: string;
      toolsUsed: string[];
      outcome: string;
    }>;
  };
}
