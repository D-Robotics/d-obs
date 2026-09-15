/** Low-sensitivity projection of the managed gateway's provider target state. */
function timestamp(value) {
    if (typeof value === 'number' && Number.isFinite(value)) {
        // Gateway state stores epoch milliseconds; tolerate epoch seconds in tests.
        return value < 10_000_000_000 ? value * 1_000 : value;
    }
    if (typeof value === 'string' && value.trim()) {
        const parsed = Date.parse(value);
        return Number.isFinite(parsed) ? parsed : Number(value) || 0;
    }
    return 0;
}
function targetParts(key) {
    const first = key.indexOf('|');
    if (first < 0)
        return { baseUrl: key, model: '' };
    const second = key.indexOf('|', first + 1);
    return {
        baseUrl: key.slice(0, first),
        model: key.slice(first + 1, second < 0 ? key.length : second),
    };
}
function targetLabel(key) {
    const { baseUrl, model } = targetParts(key);
    try {
        return `${model || 'unknown'}@${new URL(baseUrl).hostname}`;
    }
    catch {
        return `${model || 'unknown'}@${baseUrl.slice(0, 80)}`;
    }
}
function isMatchedTarget(key, pattern) {
    const { baseUrl, model } = targetParts(key);
    return pattern.test(`${baseUrl}|${model}`);
}
export function summarizeGatewayTargetHealth(snapshots, options) {
    const now = options?.now ?? Date.now();
    const cutoff = now - Math.max(1, options?.windowMinutes ?? 10) * 60_000;
    const pattern = options?.targetPattern ?? /ai-api\.d-robotics\.cc|deepseek/i;
    const details = [];
    let matchedTargets = 0;
    let degradedTargets = 0;
    let concurrencyTargets = 0;
    let primaryDegraded = false;
    let standbyDegraded = false;
    let staleSources = 0;
    for (const snapshot of snapshots) {
        const stale = Boolean(snapshot.savedAt && timestamp(snapshot.savedAt) < cutoff);
        if (stale)
            staleSources += 1;
        // A stale snapshot may retain an old cooldown from the last request that
        // lane handled. Report the stale source, but do not project old records as
        // current target degradation.
        if (stale)
            continue;
        const keys = new Set([
            ...Object.keys(snapshot.targetHealth ?? {}),
            ...Object.keys(snapshot.targetMetrics ?? {}),
        ]);
        for (const key of keys) {
            if (!isMatchedTarget(key, pattern))
                continue;
            matchedTargets += 1;
            const health = snapshot.targetHealth?.[key] ?? {};
            const metrics = snapshot.targetMetrics?.[key] ?? {};
            const lastAttemptAt = timestamp(metrics.lastAttemptAt);
            const lastFailureAt = timestamp(metrics.lastFailureAt ?? health.lastFailureAt);
            const status = Number(metrics.lastStatus ?? 0);
            const lastError = String(metrics.lastError ?? health.lastError ?? '').toLowerCase();
            const concurrency = /concurr|in.?flight|target_busy/.test(lastError);
            const cooling = timestamp(health.disabledUntil) > now;
            const recentFailure = lastFailureAt >= cutoff || (lastAttemptAt >= cutoff && status >= 500);
            const degraded = cooling || (recentFailure && (Number(metrics.consecutiveFailures ?? 0) > 0 ||
                [429, 502, 503, 504].includes(status) ||
                Boolean(lastError)));
            if (!degraded)
                continue;
            degradedTargets += 1;
            if (concurrency)
                concurrencyTargets += 1;
            if (snapshot.port === 3101)
                standbyDegraded = true;
            else
                primaryDegraded = true;
            const reasons = [
                cooling ? 'cooldown' : '',
                concurrency ? 'concurrency' : '',
                status >= 400 ? `HTTP ${status}` : '',
                lastError && !concurrency ? lastError : '',
            ].filter(Boolean);
            details.push(`${snapshot.port === 3101 ? 'standby' : 'primary'} ${targetLabel(key)}: ${reasons.join(', ') || 'degraded'}`);
        }
    }
    return {
        matchedTargets,
        degradedTargets,
        concurrencyTargets,
        primaryDegraded,
        standbyDegraded,
        staleSources,
        details: details.slice(0, 8),
    };
}
