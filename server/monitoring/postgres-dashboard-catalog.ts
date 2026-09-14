export interface PostgresAiViewDefinition {
  name: string;
  sourceTable: string;
  description: string;
  columns: readonly string[];
}

export const POSTGRES_AI_VIEWS: readonly PostgresAiViewDefinition[] = [
  {
    name: 'conversation_turns',
    sourceTable: 'conversation_turns',
    description:
      '脱敏对话轮次；不含账号、会话 ID、用户消息、助手消息和错误正文。outcome 常见值为 completed、completed_partial、error、cancelled；“成功”只指 completed，部分完成应单列。',
    columns: [
      'recorded_at timestamptz',
      'channel text',
      'outcome text',
      'client_type text',
      'app_version text',
      'tools_used text[]',
    ],
  },
  {
    name: 'agent_run_records',
    sourceTable: 'agent_run_records',
    description:
      'Agent Run 性能与结果；不含账号、设备、会话、错误正文和工具参数。outcome 常见值为 completed、completed_partial、error、cancelled；“成功”只指 completed，部分完成应单列。',
    columns: [
      'started_at timestamptz',
      'completed_at timestamptz',
      'channel text',
      'outcome text',
      'error_category text',
      'tool_call_count integer',
      'elapsed_ms integer',
      'prompt_tokens integer',
      'completion_tokens integer',
      'model text',
      'retry_count integer',
      'client_type text',
      'app_version text',
      'first_event_ms integer',
      'first_text_ms integer',
    ],
  },
  {
    name: 'studio_daily_usage',
    sourceTable: 'studio_daily_usage',
    description: '按天记录的使用与登录事件；移除账号和匿名设备标识。',
    columns: [
      'created_at timestamptz',
      'usage_date date',
      'app_version text',
      'event_type text',
      'login_channel text',
    ],
  },
  {
    name: 'product_events',
    sourceTable: 'product_events',
    description: '产品事件时间线；移除用户、会话、设备 ID 和原始扩展属性。',
    columns: [
      'event_name text',
      'channel text',
      'occurred_at timestamptz',
      'received_at timestamptz',
      'event_version integer',
    ],
  },
  {
    name: 'studio_ops_events',
    sourceTable: 'studio_ops_events',
    description: '脱敏运维事件；只保留安全摘要，不开放 metadata 与 correlation 原文。',
    columns: [
      'occurred_at timestamptz',
      'component text',
      'event_code text',
      'outcome text',
      'severity_hint text',
      'safe_summary text',
      'created_at timestamptz',
    ],
  },
  {
    name: 'chat_feedback',
    sourceTable: 'chat_feedback',
    description: '反馈类型与原因趋势；不含用户名、评论和对话正文。',
    columns: ['recorded_at timestamptz', 'kind text', 'reason_code text'],
  },
  {
    name: 'credit_account',
    sourceTable: 'credit_account',
    description: '匿名积分与额度分布；不含账号、显示名、设备和网关密钥。',
    columns: [
      'daily_limit integer',
      'daily_used integer',
      'daily_bonus integer',
      'reset_card_balance integer',
      'voucher_balance integer',
      'points_balance integer',
      'source text',
      'created_at timestamptz',
      'updated_at timestamptz',
      'last_login_channel text',
      'acquisition_channel text',
      'acquisition_source text',
      'acquisition_campaign text',
      'acquisition_at timestamptz',
    ],
  },
  {
    name: 'studio_sli_samples',
    sourceTable: 'studio_sli_samples',
    description: '服务等级指标的聚合采样。',
    columns: [
      'sli_key text',
      'source text',
      'sampled_at timestamptz',
      'good_count integer',
      'total_count integer',
      'created_at timestamptz',
    ],
  },
  {
    name: 'studio_alert_checks',
    sourceTable: 'studio_alert_checks',
    description: '告警规则最近一次评估状态。',
    columns: [
      'alert_key text',
      'title text',
      'severity text',
      'unhealthy boolean',
      'active boolean',
      'summary text',
      'checked_at timestamptz',
      'failure_streak integer',
      'success_streak integer',
      'category text',
      'enabled boolean',
    ],
  },
  {
    name: 'studio_alert_incidents',
    sourceTable: 'studio_alert_incidents',
    description: '告警事故生命周期；不含确认人与负责人身份。',
    columns: [
      'alert_key text',
      'title text',
      'severity text',
      'status text',
      'summary text',
      'first_seen_at timestamptz',
      'last_seen_at timestamptz',
      'resolved_at timestamptz',
      'occurrence_count integer',
      'silence_until timestamptz',
    ],
  },
  {
    name: 'studio_alert_notifications',
    sourceTable: 'studio_alert_notifications',
    description: '告警通知投递结果；不含错误正文和渠道凭据。',
    columns: [
      'occurred_at timestamptz',
      'alert_key text',
      'transition text',
      'severity text',
      'delivered boolean',
      'channel text',
      'attempt_count integer',
    ],
  },
  {
    name: 'studio_alert_worker_status',
    sourceTable: 'studio_alert_worker_status',
    description: '告警 Worker 的运行、影子模式与渠道配置状态。',
    columns: [
      'last_run_at timestamptz',
      'enabled boolean',
      'shadow_mode boolean',
      'channel_configured boolean',
      'channel text',
      'config_updated_at timestamptz',
      'check_count integer',
      'active_count integer',
      'worker_version text',
    ],
  },
  {
    name: 'studio_experience_summaries',
    sourceTable: 'studio_experience_summaries',
    description: '匿名体验验收聚合；不含账号、run ID 和原始内容。',
    columns: [
      'occurred_at timestamptz',
      'client_type text',
      'total integer',
      'pass_count integer',
      'fail_count integer',
      'unknown_count integer',
      'contract_hits integer',
      'total_duration_ms bigint',
      'created_at timestamptz',
    ],
  },
  {
    name: 'studio_evolution_runs',
    sourceTable: 'studio_evolution_runs',
    description: '自进化任务的阶段、结果与验证状态。',
    columns: [
      'trigger text',
      'status text',
      'stage text',
      'started_at timestamptz',
      'finished_at timestamptz',
      'failure_tag text',
      'evidence_count integer',
      'source_count integer',
      'verification_passed boolean',
      'safe_summary text',
      'created_at timestamptz',
    ],
  },
  {
    name: 'studio_skill_experiment_summary',
    sourceTable: 'studio_skill_experiment_summary',
    description: 'Skill A/B 实验的聚合效果与成本指标。',
    columns: [
      'experiment_key text',
      'skill_id text',
      'experience_cluster_id text',
      'environment_fingerprint text',
      'variant text',
      'exposed_runs bigint',
      'evidence_backed_runs bigint',
      'passed_runs bigint',
      'failed_runs bigint',
      'trusted_success_rate numeric',
      'avg_retry_count numeric',
      'avg_tool_call_count numeric',
      'avg_duration_ms numeric',
      'avg_total_tokens numeric',
      'distinct_failure_signatures bigint',
      'first_exposure_at timestamptz',
      'last_exposure_at timestamptz',
    ],
  },
] as const;

const TABLE_DESCRIPTIONS: Readonly<Record<string, string>> = {
  conversation_turns: '每轮用户与 AI 对话的归档；含账号、会话和原始对话正文。',
  studio_daily_usage: '每日使用、登录渠道和客户端版本事件。',
  studio_sli_samples: 'SLO / SLI 的好事件、总事件采样。',
  agent_run_records: 'Agent Run 结果、耗时、模型、token 与工具调用统计。',
  studio_ops_events: '服务端与客户端上报的脱敏运维事件。',
  product_events: '产品功能使用埋点；原表扩展属性可能含业务上下文。',
  agent_run_observability: '单次 Agent Run 的观测摘要快照。',
  credit_account: '用户积分、日额度与登录归因；含账号和网关密钥字段。',
  studio_experience_summaries: '端到端体验信号的匿名聚合结果。',
  credit_daily_reservation: '每日额度预占和幂等记录。',
  studio_alert_notifications: '告警通知尝试、渠道和投递结果。',
  credit_user_key: '用户网关密钥映射；敏感凭据表，AI 不开放。',
  skill_candidate_evidence: 'Skill 候选的证据、草稿和 AI 审核状态。',
  skill_review_queue: 'Skill 人工 / AI 审核队列与审核意见。',
  skill_store: '已发布 Skill 的正文、版本和安装量。',
  chat_credit_accounts: '旧积分账户余额与扩展数据。',
  studio_evolution_runs: '自动进化任务的阶段、结果与验证证据。',
  studio_alert_checks: '告警规则最近一次评估结果和连续状态。',
  chat_credit_ledger_default: '默认分区中的积分流水；含账户与业务引用。',
  credit_gateway_key_provision_intent: '网关密钥开通意图；含密钥和错误信息，AI 不开放。',
  chat_feedback: '用户反馈、原因与对话上下文。',
  studio_alert_incidents: '告警事故的打开、确认、静默和恢复生命周期。',
  redemption_code: '兑换码、面额与核销记录；敏感业务表，AI 不开放。',
  skill_harvest_pending: '等待采收与验证的 Skill 候选正文。',
  studio_alert_worker_status: '告警 Worker 运行状态、影子模式和渠道配置摘要。',
  studio_alert_incident_activity: '事故确认、指派、静默等操作审计。',
  studio_remediation_runs: '自愈剧本的执行步骤与结果。',
  campaigns: '增长活动规则与奖励配置。',
  campaign_participations: '活动参与、邀请与来源归因；含账号标识。',
  studio_skill_experiment_summary: 'Skill 实验的聚合成功率、成本与失败类型。',
};

const AI_QUERYABLE_TABLES = new Set(POSTGRES_AI_VIEWS.map((view) => view.sourceTable));

/**
 * 表级硬凭据列 denylist：名字启发式覆盖不到、但值本身就是凭据的列。
 * 预览与整表 CSV 导出会按 schema.table 匹配并强制隐藏这些列；新增敏感表时必须在这里登记，
 * 并在 postgres-dashboard-store.test.ts 里补对应断言。
 */
const TABLE_SECRET_COLUMNS: Readonly<Record<string, ReadonlySet<string>>> = {
  'public.credit_account': new Set(['gateway_user_key']),
  'public.redemption_code': new Set(['code']),
  'public.credit_user_key': new Set(['gateway_key', 'key_id']),
  'public.credit_gateway_key_provision_intent': new Set(['gateway_key', 'last_error']),
  'public.chat_credit_accounts': new Set(['invite_code']),
  'public.credit_setting': new Set(['value']),
};

const SECRET_COLUMN_TABLES = new Set(Object.keys(TABLE_SECRET_COLUMNS));

/** 表内是否存在按表登记的硬凭据列（预览/导出前的前置判断）。 */
export function isPostgresSecretColumnTable(schemaName: string, tableName: string): boolean {
  return SECRET_COLUMN_TABLES.has(`${schemaName}.${tableName}`);
}

/** 表级 denylist 命中返回 true；未登记的表返回 false，交由名字启发式兜底。 */
export function isPostgresTableSecretColumn(
  schemaName: string,
  tableName: string,
  columnName: string,
): boolean {
  return TABLE_SECRET_COLUMNS[`${schemaName}.${tableName}`]?.has(columnName) ?? false;
}

export function isPostgresAiQueryableTable(name: string): boolean {
  return AI_QUERYABLE_TABLES.has(name);
}

export function postgresTableDescription(name: string, catalogComment?: unknown): string {
  const comment = String(catalogComment ?? '').trim();
  if (comment) return comment.slice(0, 500);
  const exact = TABLE_DESCRIPTIONS[name];
  if (exact) return exact;
  if (name.startsWith('studio_alert_')) return '可观测告警的状态、审计或运行记录。';
  if (name.startsWith('studio_skill_')) return 'Skill 实验、策略或安全控制数据。';
  if (name.startsWith('studio_quota_')) return 'Moss 配额账户、授权或结算流水。';
  if (name.startsWith('credit_') || name.startsWith('chat_credit_')) {
    return '积分中心业务数据；可能包含账号、密钥或业务引用，AI 默认不开放。';
  }
  if (name.startsWith('skill_')) return 'Skill 生命周期内容、证据或审核数据。';
  return 'PostgreSQL 业务表；尚未设置数据库 COMMENT，AI 默认不开放。';
}
