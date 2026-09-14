/** 与 Supabase / JSONL 对齐的归档 */
export const CONVERSATION_SCHEMA = 'rdk.studio.conversation_turn.v4';

export type ConversationOutcome =
  | 'completed'
  | 'completed_partial'
  | 'cancelled'
  | 'error'
  | 'rejected'
  | 'queued_cancelled';

export type ConversationTurnRecord = {
  schema: typeof CONVERSATION_SCHEMA;
  /** 毫秒时间戳，本轮结束时刻 */
  recordedAt: number;
  /** RDK Studio 客户端会话 id（本机多线程聊天列表里的 thread id）；旧记录可能为空 */
  sessionId?: string;
  /** Agent 落盘会话键（含设备/RDK Studio session 前缀），仅写入本机 JSONL，云端表忽略 */
  agentSessionKey?: string;
  /** 当前选中设备 id；无设备为空 */
  deviceId?: string;
  /** RDK Studio 对话范围；用于区分普通聊天与项目聊天 */
  chatScope?: string;
  /** project scope 的项目 id */
  projectId?: string;
  /** SSO 展示名；未登录为空 */
  ssoUserName?: string;
  /**
   * 工作区用户 id(req.userId);本地 JSONL 归档隔离用(search_conversations 按它过滤)。
   * 未登录 / 单用户 / 老记录无此字段 = 共享，不参与隔离（self-gating）。
   * 注意:它不是账号 id——feishu/weixin/autonomy 下与 ssoUserId 分叉,且可能来自前端。
   */
  userId?: string;
  /**
   * 计费/账号 id(req.ssoUserId,服务端从会话解析,前端不可控)。中心库 conversation_turns.sso_user_id
   * 列以它为准——云端历史(cloud-history-routes)按 SSO 账号严格过滤读,键必须与 agent_run_records 同源。
   */
  ssoUserId?: string;
  userMessage: string;
  assistantMessage: string;
  /** 本轮实际调用过的工具名（去重，顺序大致为调用顺序） */
  toolsUsed: string[];
  /** studio | feishu | weixin | autonomy */
  channel: string;
  /** 增长遥测入口来源；miniapp 需显式携带，其余入口按部署 profile 解析。 */
  clientType?: 'web-cloud' | 'desktop' | 'web-self-host' | 'local-dev' | 'miniapp';
  /** 客户端版本，仅用于遥测切片；老记录可能为空。 */
  appVersion?: string;
  outcome: ConversationOutcome;
  /** 失败或未完成时的简要原因（可空） */
  errorDetail?: string;
};
