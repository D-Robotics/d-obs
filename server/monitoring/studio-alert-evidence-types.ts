/** Bounded operational facts shared by notification cards and historical alert details. */
export interface AlertEvidenceGroup {
  accountId: string | null;
  appVersion: string | null;
  clientType: string | null;
  module: string;
  failureCount: number;
  runCount: number;
}

export interface AlertEvidenceSample {
  eventId: string;
  occurredAt: string;
  accountId: string | null;
  appVersion: string | null;
  clientType: string | null;
  module: string;
  toolName: string | null;
  failureCategory: string | null;
  failureDetail: string | null;
}

export interface AlertEvidence {
  /** An older window can be reconstructed only from retained original records. */
  source?: 'evaluation' | 'historical-reconstruction';
  capturedAt?: string;
  windowStart: string;
  windowEnd: string;
  eventCount: number;
  runCount: number;
  totalGroups: number;
  groups: AlertEvidenceGroup[];
  samples: AlertEvidenceSample[];
  /** Infrastructure rules have no account/client dimension. */
  applicability: 'business' | 'infrastructure';
}
