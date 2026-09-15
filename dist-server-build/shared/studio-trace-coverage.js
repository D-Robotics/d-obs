const DEFAULT_REQUIRED = [
    'client',
    'studio_transport',
    'moss_root',
    'moss_children',
    'terminal',
];
function semverTuple(value) {
    const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ''));
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}
function versionAtLeast(value, minimum) {
    const current = semverTuple(value);
    const floor = semverTuple(minimum);
    if (!current || !floor)
        return false;
    for (let index = 0; index < 3; index += 1) {
        if (current[index] !== floor[index])
            return current[index] > floor[index];
    }
    return true;
}
function unique(values) {
    return [...new Set(values)];
}
/**
 * Canonical structural coverage projection. Advanced exporter health is
 * intentionally orthogonal: it never turns a locally complete trace partial.
 */
export function projectStudioTraceCoverage(input) {
    const now = Number.isFinite(input.now) ? Number(input.now) : Date.now();
    const graceMs = Math.max(0, input.ingestionGraceMs ?? 2 * 60_000);
    const required = unique(input.requiredSegments ?? DEFAULT_REQUIRED);
    const observed = new Set(input.observedSegments ?? []);
    const minimumStudioVersion = input.minimumStudioVersion ?? '1.4.0';
    const supportedMocMajor = input.supportedMocMajor ?? 1;
    const mocMajor = semverTuple(input.mocVersion)?.[0];
    const localDev = input.surface === 'local-dev';
    const versionEligible = versionAtLeast(input.studioVersion, minimumStudioVersion);
    const contractEligible = mocMajor === supportedMocMajor;
    const eligible = !localDev && versionEligible && contractEligible;
    const common = {
        eligible,
        surface: input.surface,
        ...(input.studioVersion ? { studioVersion: input.studioVersion } : {}),
        ...(input.mossVersion ? { mossVersion: input.mossVersion } : {}),
        ...(input.mocVersion ? { mocVersion: input.mocVersion } : {}),
        ...(input.exportDegraded ? { exportDegraded: true } : {}),
    };
    const extraReasons = [
        ...(input.exportDegraded ? ['export_degraded'] : []),
        ...(input.identifierConflict ? ['identifier_conflict'] : []),
        ...(input.invalidParent ? ['invalid_parent'] : []),
        ...(input.multipleFragments ? ['multiple_fragments'] : []),
        ...(input.duplicateIdentity ? ['duplicate_identity'] : []),
        ...(input.topologyCycle ? ['topology_cycle'] : []),
    ];
    const structuralDrift = Boolean(input.identifierConflict ||
        input.invalidParent ||
        input.multipleFragments ||
        input.duplicateIdentity ||
        input.topologyCycle);
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
