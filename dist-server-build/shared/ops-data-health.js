export function classifyOpsDataHealth(input) {
    if (!input.configured)
        return 'not_configured';
    if (input.sampleCount <= 0)
        return 'no_samples';
    if (input.coverageRate != null &&
        input.coverageRate < (input.minimumCoverage ?? 0.8)) {
        return 'partial';
    }
    return 'live';
}
