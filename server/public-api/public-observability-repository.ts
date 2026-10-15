import type {
  PublicObservabilityEvaluationRecord,
  PublicObservabilityFeedbackRecord,
  PublicObservabilityRunRecord,
  PublicObservabilityScoreRecord,
  PublicObservabilitySpanRecord,
} from './public-observability-store.js';
import type { PublicObservabilityObjectProfile } from '../../shared/public-observability-client.js';
import type { TelemetryDeletionTombstone } from '../observability/governance-deletion.js';

/**
 * Public observability exposes a bounded local projection plus a PostgreSQL
 * entity index when configured. Legacy snapshots describe only the local cache;
 * shared authority is always read/written per run or profile in PG transactions.
 */
export const PUBLIC_OBSERVABILITY_PERSISTENCE_MODE = 'process-memory-cache' as const;
export const PUBLIC_OBSERVABILITY_SNAPSHOT_SCHEMA = 'rdk.public.observability.snapshot.v1' as const;

export type PublicObservabilityPersistenceMode = typeof PUBLIC_OBSERVABILITY_PERSISTENCE_MODE | 'postgres-entity-index';

export interface PublicObservabilityPersistenceLimits {
  maxRuns: number;
  maxObjectProfiles: number;
  maxSpansPerRun: number;
  maxScoresPerRun: number;
  maxFeedbackPerRun: number;
  maxEvaluationsPerRun: number;
  retentionMs: number;
}

export interface PublicObservabilityPersistenceStatus {
  mode: PublicObservabilityPersistenceMode;
  authoritative: 'process-cache' | 'postgres';
  durableProjections: readonly ['studio-trace-store', 'public-observability-quality-store'];
  degraded: boolean;
  cache: {
    runs: number;
    objectProfiles: number;
    governanceTombstones: number;
    quarantineAllTelemetry: boolean;
  };
  limits: PublicObservabilityPersistenceLimits;
  generatedAt: number;
}

export interface PublicObservabilitySnapshotRun {
  run: PublicObservabilityRunRecord;
  spans: PublicObservabilitySpanRecord[];
  scores: PublicObservabilityScoreRecord[];
  feedback: PublicObservabilityFeedbackRecord[];
  evaluations: PublicObservabilityEvaluationRecord[];
}

export interface PublicObservabilitySnapshot {
  schema: typeof PUBLIC_OBSERVABILITY_SNAPSHOT_SCHEMA;
  generatedAt: number;
  persistenceMode: PublicObservabilityPersistenceMode;
  runs: PublicObservabilitySnapshotRun[];
  objectProfiles: Array<PublicObservabilityObjectProfile & { owner: string; updatedBy: string }>;
  /** Governance selectors travel with a handoff so deleted telemetry cannot be restored. */
  tombstones: TelemetryDeletionTombstone[];
  quarantineAllTelemetry: boolean;
}

export interface PublicObservabilitySnapshotImportResult {
  importedRuns: number;
  importedObjectProfiles: number;
  skippedRuns: number;
  skippedObjectProfiles: number;
  replaced: boolean;
}

export interface PublicObservabilityRepository {
  getPersistenceStatus(): PublicObservabilityPersistenceStatus;
  exportSnapshot(): PublicObservabilitySnapshot;
  importSnapshot(
    snapshot: unknown,
    options?: { replace?: boolean },
  ): PublicObservabilitySnapshotImportResult;
}
