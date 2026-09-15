const DISPATCH_MODES = new Set(['auto_preflight', 'approved_preflight', 'model_dispatch']);
const SUCCESS_OUTCOMES = new Set(['completed', 'completed_partial']);
function finiteNumber(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}
function percentile(values, fraction) {
    if (values.length === 0)
        return null;
    const sorted = [...values].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
    return Math.round(sorted[index]);
}
function rate(numerator, denominator) {
    return denominator > 0 ? numerator / denominator : null;
}
export function emptyAgentDispatchMetrics(windowDays, configured = false) {
    return {
        configured,
        windowDays,
        runsWithPlan: 0,
        dispatchRuns: 0,
        classifierEligibleRuns: 0,
        classifierRequiredRuns: 0,
        effectiveEligibleRuns: 0,
        effectiveRequiredRuns: 0,
        autoPreflightRuns: 0,
        approvedPreflightRuns: 0,
        modelDispatchRuns: 0,
        completedRuns: 0,
        partialRuns: 0,
        errorRuns: 0,
        cancelledRuns: 0,
        dispatchRate: null,
        classifierEligibleRate: null,
        classifierRequiredRate: null,
        effectiveEligibleRate: null,
        effectiveRequiredRate: null,
        successRate: null,
        latency: { p50Ms: null, p95Ms: null },
        daily: [],
        sources: 'agent_run_records.agent_dispatch_plan（仅聚合调度标签、结果和耗时）',
    };
}
/** Aggregate bounded scheduler receipts without exposing prompts, identities, or raw JSON. */
export function buildAgentDispatchMetrics(rows, windowDays) {
    if (rows.length === 0) {
        return emptyAgentDispatchMetrics(windowDays, true);
    }
    const countOutcome = (outcome) => rows.filter((row) => row.outcome === outcome).length;
    const dispatchRuns = rows.filter((row) => DISPATCH_MODES.has(row.executionMode)).length;
    const completedRuns = countOutcome('completed');
    const partialRuns = countOutcome('completed_partial');
    const errorRuns = countOutcome('error');
    const cancelledRuns = countOutcome('cancelled');
    const validLatency = rows
        .filter((row) => row.outcome !== 'cancelled')
        .map((row) => finiteNumber(row.elapsedMs))
        .filter((value) => value != null && value >= 0);
    const successDenominator = completedRuns + partialRuns + errorRuns;
    const days = [...new Set(rows.map((row) => row.day).filter(Boolean))].sort();
    const daily = days.map((day) => {
        const selected = rows.filter((row) => row.day === day);
        const completed = selected.filter((row) => row.outcome === 'completed').length;
        const partial = selected.filter((row) => row.outcome === 'completed_partial').length;
        const errors = selected.filter((row) => row.outcome === 'error').length;
        const selectedLatency = selected
            .filter((row) => row.outcome !== 'cancelled')
            .map((row) => finiteNumber(row.elapsedMs))
            .filter((value) => value != null && value >= 0);
        return {
            day,
            runsWithPlan: selected.length,
            dispatchRuns: selected.filter((row) => DISPATCH_MODES.has(row.executionMode)).length,
            autoPreflightRuns: selected.filter((row) => row.executionMode === 'auto_preflight').length,
            approvedPreflightRuns: selected.filter((row) => row.executionMode === 'approved_preflight').length,
            modelDispatchRuns: selected.filter((row) => row.executionMode === 'model_dispatch').length,
            classifierRequiredRuns: selected.filter((row) => row.classifierRequired).length,
            effectiveRequiredRuns: selected.filter((row) => row.required).length,
            completedRuns: completed,
            partialRuns: partial,
            errorRuns: errors,
            cancelledRuns: selected.filter((row) => row.outcome === 'cancelled').length,
            successRate: rate(completed + partial, completed + partial + errors),
            p50ElapsedMs: percentile(selectedLatency, 0.5),
            p95ElapsedMs: percentile(selectedLatency, 0.95),
        };
    });
    return {
        configured: true,
        windowDays,
        runsWithPlan: rows.length,
        dispatchRuns,
        classifierEligibleRuns: rows.filter((row) => row.classifierEligible).length,
        classifierRequiredRuns: rows.filter((row) => row.classifierRequired).length,
        effectiveEligibleRuns: rows.filter((row) => row.eligible).length,
        effectiveRequiredRuns: rows.filter((row) => row.required).length,
        autoPreflightRuns: rows.filter((row) => row.executionMode === 'auto_preflight').length,
        approvedPreflightRuns: rows.filter((row) => row.executionMode === 'approved_preflight').length,
        modelDispatchRuns: rows.filter((row) => row.executionMode === 'model_dispatch').length,
        completedRuns,
        partialRuns,
        errorRuns,
        cancelledRuns,
        dispatchRate: rate(dispatchRuns, rows.length),
        classifierEligibleRate: rate(rows.filter((row) => row.classifierEligible).length, rows.length),
        classifierRequiredRate: rate(rows.filter((row) => row.classifierRequired).length, rows.length),
        effectiveEligibleRate: rate(rows.filter((row) => row.eligible).length, rows.length),
        effectiveRequiredRate: rate(rows.filter((row) => row.required).length, rows.length),
        successRate: rate(completedRuns + partialRuns, successDenominator),
        latency: { p50Ms: percentile(validLatency, 0.5), p95Ms: percentile(validLatency, 0.95) },
        daily,
        sources: 'agent_run_records.agent_dispatch_plan（仅聚合调度标签、结果和耗时）',
    };
}
