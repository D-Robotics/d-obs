export type OpsDataHealthState =
  | 'live'
  | 'partial'
  | 'no_samples'
  | 'not_configured';

export type OpsDataHealthReason =
  | 'legacy_fallback'
  | 'direct_login_only'
  | 'missing_dimension'
  | 'source_unavailable';

export interface OpsDataHealthSignal {
  state: OpsDataHealthState;
  source: string;
  sampleCount: number;
  lastEventAt: string | null;
  coverageRate: number | null;
  coveredSamples?: number;
  eligibleSamples?: number;
  /** 数据源自身的有效窗口；例如运维登录事件只保留 30 天。 */
  effectiveWindowDays?: number;
  reason?: OpsDataHealthReason;
}

export interface FlywheelLoginChannel {
  channel: string;
  logins: number;
  users: number;
}

export interface FlywheelLoginBreakdownItem {
  key: string;
  successes: number;
  rejected: number;
  errors: number;
  uniqueUsers: number | null;
}

export interface FlywheelLoginBreakdown {
  source: 'studio_ops_events' | 'studio_daily_usage' | 'unavailable';
  dimension: 'direct_method' | 'entry_channel' | 'unavailable';
  items: FlywheelLoginBreakdownItem[];
  effectiveWindowDays: number;
}

export interface FlywheelDataHealth {
  users: OpsDataHealthSignal;
  /** 稳定账号键驱动的注册 cohort 与使用旅程；旧 API 可缺省。 */
  journey?: OpsDataHealthSignal;
  runs: OpsDataHealthSignal;
  conversations: OpsDataHealthSignal;
  feedback: OpsDataHealthSignal;
  acquisition: OpsDataHealthSignal;
  loginChannels: OpsDataHealthSignal;
  /** Skill 事件埋点（product_events · skill_matched）；旧部署缺表时缺省。 */
  skillEvents?: OpsDataHealthSignal;
  /** Skill 台账（skill_review_queue / skill_store）；表未建时缺省。 */
  skillLedger?: OpsDataHealthSignal;
}

export function classifyOpsDataHealth(input: {
  configured: boolean;
  sampleCount: number;
  coverageRate?: number | null;
  minimumCoverage?: number;
}): OpsDataHealthState {
  if (!input.configured) return 'not_configured';
  if (input.sampleCount <= 0) return 'no_samples';
  if (
    input.coverageRate != null &&
    input.coverageRate < (input.minimumCoverage ?? 0.8)
  ) {
    return 'partial';
  }
  return 'live';
}
