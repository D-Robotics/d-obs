import { sanitizeOpsSummary } from './ops-event-store.js';
const STATE_VERSION = 1;
function durationMinutesBetween(firstSeenAt, at, nowMs) {
    const firstSeen = firstSeenAt ? Date.parse(firstSeenAt) : Number.NaN;
    const endMs = Number.isFinite(Date.parse(at)) ? Date.parse(at) : nowMs;
    if (!Number.isFinite(firstSeen))
        return null;
    return Math.max(0, Math.round((endMs - firstSeen) / 60_000));
}
export function reconcileAlertState(previous, observations, now = new Date(), options) {
    const at = now.toISOString();
    const nowMs = now.getTime();
    const cooldownMs = Math.max(5, options?.cooldownMinutes ?? 30) * 60_000;
    const remindersEnabled = options?.remindersEnabled ?? true;
    const keys = { ...(previous.keys ?? {}) };
    const transitions = [];
    for (const observation of observations) {
        const prior = keys[observation.key] ?? {
            active: false,
            notified: false,
            failureStreak: 0,
            successStreak: 0,
        };
        const next = { ...prior };
        const priorSeverity = prior.severity;
        next.title = observation.title;
        next.summary = sanitizeOpsSummary(observation.summary, 800);
        next.severity = observation.severity;
        next.lastSeenAt = at;
        if (observation.enabled === false) {
            next.failureStreak = 0;
            next.successStreak = 0;
            if (next.active) {
                transitions.push({
                    kind: 'resolved',
                    key: observation.key,
                    title: observation.title,
                    severity: next.severity ?? observation.severity,
                    summary: '规则已停用，事故自动关闭',
                    at,
                    firstSeenAt: next.firstSeenAt,
                    durationMinutes: durationMinutesBetween(next.firstSeenAt, at, nowMs),
                });
            }
            next.active = false;
            next.notified = false;
            next.firstSeenAt = undefined;
            next.lastAttemptAt = undefined;
            next.lastNotifiedAt = undefined;
        }
        else if (observation.unknown) {
            // Preserve the last conclusive state and both streaks. Treating "cannot
            // evaluate" as healthy would falsely close an active incident.
        }
        else if (observation.unhealthy) {
            next.failureStreak += 1;
            next.successStreak = 0;
            if (!next.firstSeenAt)
                next.firstSeenAt = at;
            const shouldOpen = next.failureStreak >= (observation.openAfter ?? 1);
            if (shouldOpen && !next.active) {
                next.active = true;
                transitions.push({
                    kind: 'opened',
                    key: observation.key,
                    title: observation.title,
                    severity: observation.severity,
                    summary: next.summary,
                    at,
                    firstSeenAt: next.firstSeenAt,
                    failureStreak: next.failureStreak,
                });
            }
            else if (shouldOpen &&
                next.active &&
                next.notified &&
                priorSeverity === 'warning' &&
                observation.severity === 'critical') {
                transitions.push({
                    kind: 'escalated',
                    key: observation.key,
                    title: observation.title,
                    severity: observation.severity,
                    summary: next.summary,
                    at,
                    firstSeenAt: next.firstSeenAt,
                    failureStreak: next.failureStreak,
                });
            }
            else if (shouldOpen &&
                next.active &&
                next.notified &&
                remindersEnabled &&
                observation.remindersEnabled !== false) {
                const last = next.lastNotifiedAt ? Date.parse(next.lastNotifiedAt) : 0;
                if (!Number.isFinite(last) || nowMs - last >= cooldownMs) {
                    transitions.push({
                        kind: 'reminder',
                        key: observation.key,
                        title: observation.title,
                        severity: observation.severity,
                        summary: next.summary,
                        at,
                        firstSeenAt: next.firstSeenAt,
                        failureStreak: next.failureStreak,
                    });
                }
            }
            else if (shouldOpen && next.active && !next.notified) {
                // 影子模式或未配通知渠道时不把事故永久吞掉；渠道补齐后下一轮仍会尝试。
                const lastAttempt = next.lastAttemptAt ? Date.parse(next.lastAttemptAt) : 0;
                if (!Number.isFinite(lastAttempt) || nowMs - lastAttempt >= cooldownMs) {
                    transitions.push({
                        kind: 'opened',
                        key: observation.key,
                        title: observation.title,
                        severity: observation.severity,
                        summary: next.summary,
                        at,
                        firstSeenAt: next.firstSeenAt,
                        failureStreak: next.failureStreak,
                    });
                }
            }
        }
        else {
            next.failureStreak = 0;
            next.successStreak += 1;
            if (next.active && next.successStreak >= (observation.resolveAfter ?? 2)) {
                const firstSeen = next.firstSeenAt ? Date.parse(next.firstSeenAt) : Number.NaN;
                const durationMinutes = Number.isFinite(firstSeen)
                    ? Math.max(0, Math.round((nowMs - firstSeen) / 60_000))
                    : null;
                transitions.push({
                    kind: 'resolved',
                    key: observation.key,
                    title: observation.title,
                    severity: next.severity ?? observation.severity,
                    summary: `${durationMinutes != null ? `事故持续 ${durationMinutes} 分钟，` : ''}连续 ${next.successStreak} 次检查正常`,
                    at,
                    firstSeenAt: next.firstSeenAt,
                    durationMinutes,
                    successStreak: next.successStreak,
                });
                next.active = false;
                next.notified = false;
                next.firstSeenAt = undefined;
                next.lastAttemptAt = undefined;
                next.lastNotifiedAt = undefined;
            }
        }
        keys[observation.key] = next;
    }
    return {
        state: {
            ...previous,
            version: STATE_VERSION,
            keys,
        },
        transitions,
    };
}
