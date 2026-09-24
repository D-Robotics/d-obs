import type { AlertRuleKey } from './alert-config.js';
import { sanitizeOpsSummary } from './ops-event-store.js';
import type { SyntheticProbeResult } from './synthetic-probes.js';

const STATE_VERSION = 1;

export type AlertSeverity = 'warning' | 'critical';

export interface AlertObservation {
  key: AlertRuleKey;
  title: string;
  severity: AlertSeverity;
  unhealthy: boolean;
  /** 可选的低敏感 SLI 聚合样本；不包含用户、会话或请求正文。 */
  sli?: {
    key:
      | 'public-availability'
      | 'gateway-availability'
      | 'gateway-latency'
      | 'ai-ttft'
      | 'login-reliability'
      | 'ai-run-success'
      | 'tool-call-success';
    good: number;
    total: number;
    source: string;
  };
  /**
   * The dependency needed to evaluate this rule is unavailable.
   *
   * Unknown observations refresh the visible diagnostic text but must not count
   * as either a failure or a recovery. In particular, a central database outage
   * must not resolve incidents whose metrics can no longer be queried.
   */
  unknown?: boolean;
  summary: string;
  enabled?: boolean;
  openAfter?: number;
  resolveAfter?: number;
  /**
   * 观测级提醒开关：false 时该规则的事故在冷却到期后不再重复提醒。
   * 天级指标（北极星）最多 6h 刷新一次，按冷却重复提醒同一数值只是噪音；
   * 未设置时回落到全局 global.remindersEnabled。
   */
  remindersEnabled?: boolean;
}

export interface AlertKeyState {
  active: boolean;
  notified: boolean;
  failureStreak: number;
  successStreak: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  lastAttemptAt?: string;
  lastNotifiedAt?: string;
  severity?: AlertSeverity;
  title?: string;
  summary?: string;
}

export interface AlertWorkerState {
  version: 1;
  keys: Record<string, AlertKeyState>;
  lastServiceRestarts?: number;
  lastCleanupAt?: string;
  lastSyntheticAt?: string;
  syntheticResults?: Partial<Record<AlertRuleKey, SyntheticProbeResult>>;
  notificationHistory?: string[];
  /** ops 事件 → 日志域镜像的 created_at 游标（ISO 字符串）。 */
  logMirrorCursor?: string;
}

export interface AlertTransition {
  kind: 'opened' | 'escalated' | 'reminder' | 'resolved';
  key: AlertRuleKey;
  title: string;
  severity: AlertSeverity;
  summary: string;
  at: string;
  /** 事故首次观测时间，供通知卡片展示持续时长等细节。 */
  firstSeenAt?: string;
  /** 事故持续分钟数；恢复时按 firstSeenAt 计算。 */
  durationMinutes?: number | null;
  /** 转换发生时的连续异常检查次数。 */
  failureStreak?: number;
  /** 转换发生时的连续正常检查次数。 */
  successStreak?: number;
}

function durationMinutesBetween(
  firstSeenAt: string | undefined,
  at: string,
  nowMs: number,
): number | null {
  const firstSeen = firstSeenAt ? Date.parse(firstSeenAt) : Number.NaN;
  const endMs = Number.isFinite(Date.parse(at)) ? Date.parse(at) : nowMs;
  if (!Number.isFinite(firstSeen)) return null;
  return Math.max(0, Math.round((endMs - firstSeen) / 60_000));
}

export function reconcileAlertState(
  previous: AlertWorkerState,
  observations: AlertObservation[],
  now = new Date(),
  options?: {
    cooldownMinutes?: number;
    remindersEnabled?: boolean;
  },
): { state: AlertWorkerState; transitions: AlertTransition[] } {
  const at = now.toISOString();
  const nowMs = now.getTime();
  const cooldownMs = Math.max(5, options?.cooldownMinutes ?? 30) * 60_000;
  const remindersEnabled = options?.remindersEnabled ?? true;
  const keys = { ...(previous.keys ?? {}) };
  const transitions: AlertTransition[] = [];

  for (const observation of observations) {
    const prior = keys[observation.key] ?? {
      active: false,
      notified: false,
      failureStreak: 0,
      successStreak: 0,
    };
    const next: AlertKeyState = { ...prior };
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
    } else if (observation.unknown) {
      // Preserve the last conclusive state and both streaks. Treating "cannot
      // evaluate" as healthy would falsely close an active incident.
    } else if (observation.unhealthy) {
      next.failureStreak += 1;
      next.successStreak = 0;
      if (!next.firstSeenAt) next.firstSeenAt = at;
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
      } else if (
        shouldOpen &&
        next.active &&
        next.notified &&
        priorSeverity === 'warning' &&
        observation.severity === 'critical'
      ) {
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
      } else if (
        shouldOpen &&
        next.active &&
        next.notified &&
        remindersEnabled &&
        observation.remindersEnabled !== false
      ) {
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
      } else if (shouldOpen && next.active && !next.notified) {
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
    } else {
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
