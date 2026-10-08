import type {
  StudioTraceCoverage,
  StudioTraceCoverageReason,
  StudioTraceCoverageSegment,
  StudioTraceSurface,
} from './studio-observability.js';

export interface StudioTraceCoverageInput {
  surface: StudioTraceSurface;
  studioVersion?: string;
  mossVersion?: string;
  mocVersion?: string;
  admittedAt?: number;
  now?: number;
  ingestionGraceMs?: number;
  requiredSegments?: StudioTraceCoverageSegment[];
  observedSegments?: StudioTraceCoverageSegment[];
  hasRunSummary: boolean;
  sampled?: boolean;
  queryFailed?: boolean;
  exportDegraded?: boolean;
  identifierConflict?: boolean;
  invalidParent?: boolean;
  multipleFragments?: boolean;
  duplicateIdentity?: boolean;
  topologyCycle?: boolean;
  minimumStudioVersion?: string;
  supportedMocMajor?: number;
}

const DEFAULT_REQUIRED: StudioTraceCoverageSegment[] = [
  'client',
  'studio_transport',
  'moss_root',
  'moss_children',
  'terminal',
];

function semverTuple(value: string | undefined): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(value: string | undefined, minimum: string): boolean {
  const current = semverTuple(value);
  const floor = semverTuple(minimum);
  if (!current || !floor) return false;
  for (let index = 0; index < 3; index += 1) {
    if (current[index] !== floor[index]) return current[index] > floor[index];
  }
  return true;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/**
 * Canonical structural coverage projection. Advanced exporter health is
 * intentionally orthogonal: it never turns a locally complete trace partial.
 */
export function projectStudioTraceCoverage(
  input: StudioTraceCoverageInput,
): StudioTraceCoverage {
  const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
  const graceMs = Math.max(0, input.ingestionGraceMs ?? 2 * 60_000);
  const required = unique(input.requiredSegments ?? DEFAULT_REQUIRED);
  const observed = new Set(input.observedSegments ?? []);
  const minimumStudioVersion = input.minimumStudioVersion ?? '1.4.0';
  const supportedMocMajor = input.supportedMocMajor ?? 1;
  const localDev = input.surface === 'local-dev';
  // run fact 只带 app_version（MOC/Moss 版本随 span 才有），无 span 的运行版本未知。
  // 未知只能降级为"按片段证据判定"，不能当成"版本不兼容"——否则所有无 span 运行
  // 都会被误标 version_unsupported 并把全部必需片段抄成缺失。
  const studioVersionReported = semverTuple(input.studioVersion) !== null;
  const versionEligible = studioVersionReported
    ? versionAtLeast(input.studioVersion, minimumStudioVersion)
    : true;
  const mocMajor = semverTuple(input.mocVersion)?.[0];
  const contractEligible =
    input.mocVersion == null || input.mocVersion === ''
      ? true
      : mocMajor === supportedMocMajor;
  const eligible = !localDev && versionEligible && contractEligible;
  const common = {
    eligible,
    surface: input.surface,
    ...(input.studioVersion ? { studioVersion: input.studioVersion } : {}),
    ...(input.mossVersion ? { mossVersion: input.mossVersion } : {}),
    ...(input.mocVersion ? { mocVersion: input.mocVersion } : {}),
    ...(input.exportDegraded ? { exportDegraded: true } : {}),
  };
  const extraReasons: StudioTraceCoverageReason[] = [
    ...(input.exportDegraded ? (['export_degraded'] as const) : []),
    ...(input.identifierConflict ? (['identifier_conflict'] as const) : []),
    ...(input.invalidParent ? (['invalid_parent'] as const) : []),
    ...(input.multipleFragments ? (['multiple_fragments'] as const) : []),
    ...(input.duplicateIdentity ? (['duplicate_identity'] as const) : []),
    ...(input.topologyCycle ? (['topology_cycle'] as const) : []),
  ];
  const structuralDrift = Boolean(
    input.identifierConflict ||
      input.invalidParent ||
      input.multipleFragments ||
      input.duplicateIdentity ||
      input.topologyCycle,
  );

  if (!eligible) {
    return {
      ...common,
      state: 'summary_only',
      missingSegments: required,
      reasonCodes: unique([
        versionEligible && contractEligible && localDev ? 'legacy' : 'version_unsupported',
        ...extraReasons,
      ]),
    };
  }
  if (input.queryFailed) {
    return {
      ...common,
      state: 'unavailable',
      missingSegments: required.filter((segment) => !observed.has(segment)),
      reasonCodes: unique(['query_failed', ...extraReasons]),
    };
  }
  if (input.sampled === false) {
    return {
      ...common,
      state: 'summary_only',
      missingSegments: required.filter((segment) => !observed.has(segment)),
      reasonCodes: unique(['unsampled', ...extraReasons]),
    };
  }

  const missingSegments = required.filter((segment) => !observed.has(segment));
  if (missingSegments.length === 0 && !structuralDrift) {
    return {
      ...common,
      state: 'complete',
      missingSegments: [],
      reasonCodes: unique(extraReasons),
    };
  }

  if (missingSegments.length === 0) {
    return {
      ...common,
      state: 'partial',
      missingSegments: [],
      reasonCodes: unique(extraReasons),
    };
  }

  const admittedAt = Number(input.admittedAt);
  const hasAdmissionTime = Number.isFinite(admittedAt);
  const graceExpiresAt = hasAdmissionTime ? admittedAt + graceMs : null;
  if (graceExpiresAt !== null && now < graceExpiresAt) {
    return {
      ...common,
      state: 'partial',
      missingSegments,
      reasonCodes: unique(['within_grace', ...extraReasons]),
      graceExpiresAt: new Date(graceExpiresAt).toISOString(),
    };
  }

  if (observed.size === 0) {
    return {
      ...common,
      state: input.hasRunSummary ? 'summary_only' : 'unavailable',
      missingSegments,
      reasonCodes: unique(['not_received', ...extraReasons]),
    };
  }
  return {
    ...common,
    state: 'partial',
    missingSegments,
    reasonCodes: unique(['not_received', ...extraReasons]),
  };
}