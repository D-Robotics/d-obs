import type {
  FlywheelDataHealth,
  FlywheelLoginBreakdown,
  FlywheelLoginChannel,
} from '../../shared/ops-data-health.js';

export interface FlywheelDailyPoint {
  day: string;
  total: number;
  completed: number;
  partial: number;
  error: number;
  cancelled: number;
}

/** Skill 生命周期各阶段的 product_events 计数（窗口内）。 */
export interface FlywheelSkillLifecycle {
  candidateWritten: number;
  shadowStarted: number;
  canaryStarted: number;
  canaryPassed: number;
  personalPromoted: number;
  publicApproved: number;
}

/**
 * Skill 数据闭环聚合。埋点与台账由主站应用写入、d-obs 只读；
 * 台账表未建的旧部署对应计数为 null（区别于真实的 0）。
 */
export interface FlywheelSkillOverview {
  /** skill_matched 事件中 matched_count>0 的占比；无样本或表缺失为 null。 */
  skillHitRate: number | null;
  /** 待人工审核候选数（skill_review_queue.human_verdict 为空）。 */
  reviewPending: number | null;
  storePublished: number | null;
  storeInstalls: number | null;
  runsWithRetry: number | null;
  lifecycle: FlywheelSkillLifecycle;
}

export interface FlywheelOverview {
  generatedAt: string;
  windowDays: number;
  users: {
    totalAccounts: number;
    newAccounts7d: number;
    newAccounts30d: number;
    migratedAccounts: number;
    dauToday: number;
    dailyActive: Array<{ day: string; dau: number }>;
  };
  journey: {
    configured: boolean;
    registeredAccounts: number;
    activatedAccounts: number;
    activationRate: number | null;
    activeUsers: number;
    runUsers: number;
    successfulRunUsers: number;
    feedbackUsers: number | null;
  };
  runs: {
    daily: FlywheelDailyPoint[];
    successRate: number | null;
    totalRuns: number;
    realDeviceUsersThisMonth: number;
    realDeviceRunsThisMonth: number;
    realDeviceConfigured: boolean;
    latency: { p50Ms: number | null; p90Ms: number | null };
    topErrorCategories: Array<{ category: string; count: number }>;
    runsWithRetry: number | null;
  };
  conversations: {
    total: number;
    completed: number;
    error: number;
    successRate: number | null;
    sessionCount: number | null;
    sessionCoverageRate: number | null;
    clientCoverageRate: number | null;
    byClient: Array<{ clientType: string; count: number }>;
  };
  feedback: {
    up: number;
    down: number;
    recentDown: Array<{
      recordedAt: string;
      comment: string | null;
      userMessage: string | null;
    }>;
    configured: boolean;
  };
  channels: FlywheelLoginChannel[];
  loginBreakdown: FlywheelLoginBreakdown;
  acquisition: {
    channels: Array<{ channel: string; accounts: number }>;
    attributedAccounts: number;
    totalAccounts: number;
    coverageRate: number | null;
    lastAttributedAt: string | null;
  };
  flywheel: FlywheelSkillOverview;
  dataHealth: FlywheelDataHealth;
}
