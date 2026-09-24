/**
 * d-obs 生产告警的单一配置真源。
 *
 * 配置文件包含通知 Webhook 和合成拨测账号，因此只允许写入仓库外的 0600 文件。
 * 任何发给浏览器的响应都必须先经过 toPublicAlertConfig()，不能直接序列化 AlertConfig。
 */
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import {
  ALERT_CHANNEL_LABELS,
  ALERT_CHANNEL_WEBHOOK_FIELDS,
  ALERT_DELIVERY_CHANNELS,
  alertChannelOptions,
  type AlertDeliveryChannel,
} from './alert-notification-channels.js';
import {
  alertConfigPgStoreEnabled,
  readAlertConfigRawText,
  warnAlertConfigStoreOnce,
  writeAlertConfigRawText,
} from './alert-config-store.js';

const ALERT_DELIVERY_CHANNEL_VALUES = ALERT_DELIVERY_CHANNELS;

export const ALERT_CONFIG_VERSION = 1 as const;
export const DEFAULT_PRODUCTION_ALERT_CONFIG_PATH = '/var/lib/rdstudio-alert-worker/config.json';

export const DEFAULT_ALERT_MESSAGE_TEMPLATE = `[{{product}} · {{status}}] {{title}}
环境：{{environment}}
时间：{{occurredAt}}
级别：{{severity}}
摘要：{{summary}}
指纹：{{alertKey}}
处置：{{actionGuide}}
看板：{{dashboardUrl}}`;

export const ALERT_MESSAGE_TEMPLATE_VARIABLES = [
  'product',
  'status',
  'title',
  'environment',
  'occurredAt',
  'severity',
  'summary',
  'alertKey',
  'actionGuide',
  'dashboardUrl',
] as const;

/**
 * 规则 → 告警对象绑定（借鉴参考平台的 target 模型）：告警对象是一等实体
 * （studio_obs_object_registry 中的 object_id），每条策略显式归属一个对象，
 * 事故据此携带 object_id——对象从此贯穿「策略 → 触发 → 告警中心 → 处置」。
 * 特殊值 host/self 由 worker 解析为本机主机名（host/<hostname>）。
 */
export const ALERT_RULE_OBJECT_TARGETS: Record<string, string> = {
  // 服务器（本机）
  'disk-space': 'host/self',
  'node-memory-pressure': 'host/self',
  'node-cpu-load': 'host/self',
  'internal-health': 'host/self',
  'service-crash-signature': 'host/self',
  'process-unhandled-error': 'host/self',
  // 网关
  'nginx-5xx-log': 'gateway/nginx',
  'agent-model-target-degraded': 'gateway/model-3100-3101',
  'external-dns': 'gateway/external-entry',
  'external-tls': 'gateway/external-entry',
  'external-health': 'gateway/external-entry',
  'external-entry-asset': 'gateway/external-entry',
  // 数据库
  'postgres-error-log': 'database/postgresql',
  'central-database': 'database/postgresql',
  // 主站应用（rdkstudio）
  'api-5xx-spike': 'service/rdkstudio-web',
  'sso-infrastructure-failure': 'service/rdkstudio-web',
  'ai-run-degraded-rate': 'service/rdkstudio-web',
  'ai-auth-or-quota': 'service/rdkstudio-web',
  'llm-token-budget': 'service/rdkstudio-web',
  'tool-failure-repeat': 'service/rdkstudio-web',
  'slo-error-budget-burn': 'service/rdkstudio-web',
  'synthetic-login': 'service/rdkstudio-web',
  'synthetic-ai-chat': 'service/rdkstudio-web',
  'synthetic-tool-call': 'service/rdkstudio-web',
  // d-obs 平台自身
  'evolution-worker-health': 'service/d-obs',
  'otlp-trace-freshness': 'service/d-obs',
  'metric-anomaly': 'service/d-obs',
  'public-health': 'service/d-obs',
  'north-star-skill-hit-rate': 'service/d-obs',
  'north-star-ai-human-consistency': 'service/d-obs',
  'north-star-retention-d1': 'service/d-obs',
  'north-star-first-success-rate': 'service/d-obs',
};

export function alertRuleObjectTarget(key: string): string {
  return ALERT_RULE_OBJECT_TARGETS[key] ?? `service/${key}`;
}

export const ALERT_RULE_DEFINITIONS = [
  {
    key: 'ai-run-degraded-rate',
    category: 'metric',
    title: 'AI 对话失败率异常',
    description:
      '真实 AI run 的失败 + 真中断部分完成比例（验收审计等 agent 行为口径的部分完成不计）。',
    fields: ['windowMinutes', 'minSamples', 'threshold', 'criticalThreshold', 'ratePercent'],
  },
  {
    key: 'ai-auth-or-quota',
    category: 'metric',
    title: 'AI 鉴权或额度错误',
    description: '密钥、额度、限流或鉴权错误次数。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'agent-model-target-degraded',
    category: 'metric',
    title: '受管 Agent 模型 Target 退化',
    description:
      '读取 3100/3101 gateway 的低敏 target-health 状态，识别 DeepSeek/模型 target 的 502、限流、并发耗尽与熔断；即使最终请求由 standby 成功，也保留退化信号。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'llm-token-budget',
    category: 'metric',
    title: 'LLM token 消耗超预算',
    description: '窗口内真实 AI run 的 prompt + completion token 总量。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'tool-failure-repeat',
    category: 'metric',
    title: '工具调用连续失败',
    description: '同一工具在窗口内影响的独立 run 数；原始失败事件数只用于摘要辅助排查。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'sso-infrastructure-failure',
    category: 'metric',
    title: '登录基础设施异常',
    description: '只统计 SSO 上游或服务端错误，不统计密码/验证码输错。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'api-5xx-spike',
    category: 'metric',
    title: '应用错误激增',
    description: '服务端 HTTP 5xx 与网页/桌面客户端运行错误。',
    fields: ['windowMinutes', 'minSamples', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'process-unhandled-error',
    category: 'metric',
    title: 'Node 进程未捕获异常',
    description: 'uncaughtException / unhandledRejection。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'disk-space',
    category: 'metric',
    title: '生产服务器磁盘空间',
    description: '应用所在磁盘的使用率。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'node-memory-pressure',
    category: 'metric',
    title: '本机内存压力',
    description: 'node_exporter 上报的内存使用率（经 Prometheus 查询）。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'node-cpu-load',
    category: 'metric',
    title: '本机 CPU 负载',
    description: 'node_exporter 每核负载百分比（100% = 满载一核）。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'slo-error-budget-burn',
    category: 'metric',
    title: 'SLO 错误预算燃烧过快',
    description: '核心 SLO（含受管 Agent 网关）的 1 小时 / 6 小时错误预算燃烧率。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'evolution-worker-health',
    category: 'metric',
    title: '进化 Worker 健康异常',
    description: '每日自我进化 worker 运行失败，或超过排期未运行（静默故障监控）。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'otlp-trace-freshness',
    category: 'metric',
    title: 'OTLP 链路断报',
    description:
      '中心库 trace span 的最近落库时间；超过阈值说明接入应用停止上报（部署丢配置、上报通道被切换等静默故障）。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'metric-anomaly',
    category: 'metric',
    title: '指标统计异常',
    description:
      '落库指标在窗口内的最新值偏离基线超过 z-score 阈值时告警（阈值高于观测查询页的 3.5 粗筛：预警 z≥6、严重 z≥10，以降低误报；触发后请至观测查询下钻确认）。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'service-crash-signature',
    category: 'log',
    title: '应用崩溃日志',
    description: 'systemd journal 中的崩溃、模块和语法错误签名。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'nginx-5xx-log',
    category: 'log',
    title: 'Nginx 5xx 日志',
    description:
      '公网反向代理 access log 中的 5xx 响应；设备可视状态轮询路径上的应用层设备离线 503 按设计排除。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'postgres-error-log',
    category: 'log',
    title: 'PostgreSQL 错误日志',
    description: '数据库容器日志中的 FATAL、PANIC、死锁和连接耗尽。',
    fields: ['windowMinutes', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'internal-health',
    category: 'probe',
    title: '本机健康拨测',
    description: '从独立 worker 访问本机 /api/health。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'public-health',
    category: 'probe',
    title: '公网入口拨测',
    description: '从服务器经公网域名访问 /api/health。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'central-database',
    category: 'probe',
    title: '中心 PostgreSQL 拨测',
    description: '真实执行 select 1 并测量耗时。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'synthetic-login',
    category: 'probe',
    title: '真实登录拨测',
    description: '使用专用 canary 账号完成一次账号密码登录。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'synthetic-ai-chat',
    category: 'probe',
    title: '真实 AI 对话拨测',
    description: '登录后发起一次最小 AI 对话并等待完成事件。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'synthetic-tool-call',
    category: 'probe',
    title: '真实工具调用拨测',
    description: '登录后让 AI 调用只读 device_list_all 工具并检查成功事件。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'external-dns',
    category: 'probe',
    title: '异地 DNS 拨测',
    description: '从异地独立主机解析生产域名并测量耗时。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'external-tls',
    category: 'probe',
    title: '异地 TLS 证书拨测',
    description: '校验证书链，并按证书剩余天数触发告警。',
    fields: ['threshold'],
  },
  {
    key: 'external-health',
    category: 'probe',
    title: '异地健康接口拨测',
    description: '从异地访问生产公网健康接口并校验响应。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'external-entry-asset',
    category: 'probe',
    title: '异地前端入口拨测',
    description: '从异地访问首页及其入口 JavaScript 资源。',
    fields: ['threshold', 'criticalThreshold'],
  },
  // 北极星指标（越低越糟）：观测来自 server/monitoring/north-star-metrics.ts 的日级快照，
  // 阈值锚定 2026-08-26 生产基线并留余量。
  {
    key: 'north-star-skill-hit-rate',
    category: 'metric',
    title: 'Skill 命中率回落',
    description: '7 天 skill_matched 事件的命中占比；低于阈值说明 Skill 供给质量在退化。',
    fields: ['windowMinutes', 'minSamples', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'north-star-ai-human-consistency',
    category: 'metric',
    title: 'AI 审核一致率回落',
    description: 'Skill 候选审核队列中 AI 与人工二元裁决的一致率。',
    fields: ['windowMinutes', 'minSamples', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'north-star-retention-d1',
    category: 'metric',
    title: '新账号次日留存回落',
    description: '30 天注册 cohort（剔除迁移导入账号）的次日活跃留存。',
    fields: ['windowMinutes', 'minSamples', 'threshold', 'criticalThreshold'],
  },
  {
    key: 'north-star-first-success-rate',
    category: 'metric',
    title: '新账号首次成功率回落',
    description: '30 天注册 cohort 中出现过成功 run 的账号占比。',
    fields: ['windowMinutes', 'minSamples', 'threshold', 'criticalThreshold'],
  },
] as const;

export type AlertRuleKey = (typeof ALERT_RULE_DEFINITIONS)[number]['key'];
/**
 * 阈值方向为「越低越糟」的规则：critical 必须低于 threshold。
 * 其余规则「越高越糟」，critical 必须高于 threshold。
 */
export const LOWER_IS_WORSE_ALERT_RULE_KEYS: ReadonlySet<AlertRuleKey> = new Set([
  'north-star-skill-hit-rate',
  'north-star-ai-human-consistency',
  'north-star-retention-d1',
  'north-star-first-success-rate',
]);

export type AlertRuleCategory = (typeof ALERT_RULE_DEFINITIONS)[number]['category'];
export type AlertNotificationChannel =
  | 'default'
  | AlertDeliveryChannel
  | 'none';

export interface AlertRuleConfig {
  enabled: boolean;
  windowMinutes: number;
  minSamples: number;
  threshold: number;
  criticalThreshold: number;
  ratePercent: number;
  openAfter: number;
  resolveAfter: number;
  notificationChannel: AlertNotificationChannel;
  /**
   * 审计元数据，只由服务端在参数真实变更时盖章（提交方携带的同名字段一律剥除）。
   * `createdBy/createdAt` 记首次记录在案的写入者；字段上线前已写入配置文件的规则
   * 无法回溯归属，保持缺省，由展示层按「存量」说明。内置默认值里的规则未落盘，
   * 展示层按「内置」说明。
   */
  createdBy?: string;
  createdAt?: string;
  updatedBy?: string;
  updatedAt?: string;
}

export interface AlertConfig {
  version: 1;
  updatedAt: string | null;
  /**
   * 配置文件里存在、但本服务不管理的规则键（原样保留、不编辑、不删除）。
   *
   * 为什么需要：同一份告警配置可能被多条部署共用，各自的规则集并不相同。真机
   * 验证过——线上那份 26 条规则的配置里有 `l4-shadow-ready-to-observe`、
   * `l4-canary-ready-for-approval` 是 d-obs 不认识的，另有 `moss-model-target-degraded`
   * 是 d-obs 侧已重命名（→ agent-model-target-degraded）的旧键：直接保存会让前者
   * 消失、让后者被搬走，而跑基线告警的 worker 只认旧键——那条规则会静默停止评估。
   * 保留它们之后，d-obs 的编辑只影响自己管理的规则集。
   */
  preservedRules: Record<string, unknown>;
  global: {
    enabled: boolean;
    environmentLabel: string;
    cooldownMinutes: number;
    remindersEnabled: boolean;
    notifyOnRecovery: boolean;
    maxNotificationsPerHour: number;
    autoRemediation: boolean;
    remediationCooldownMinutes: number;
  };
  notification: {
    enabled: boolean;
    shadowMode: boolean;
    channel: AlertDeliveryChannel;
    criticalChannel: string;
    warningChannel: string;
    /** 恢复通知正文模板；空串沿用 messageTemplate（P3）。 */
    recoveryTemplate: string;
    /** 升级链（P3）：无人确认超时升级重发，可路由到指定渠道（'none'=仅记录）。 */
    escalation: {
      ackTimeoutMinutes: number;
      maxEscalations: number;
      channel: string;
    };
    minSeverity: 'warning' | 'critical';
    titlePrefix: string;
    messageTemplate: string;
    actionGuide: string;
    dashboardUrl: string;
    dingtalkWebhookUrl: string;
    wecomWebhookUrl: string;
    slackWebhookUrl: string;
    telegramWebhookUrl: string;
    dingtalkSignSecret: string;
    feishuWebhookUrl: string;
    webhookUrl: string;
    bearerSecret: string;
    feishuSignSecret: string;
  };
  synthetic: {
    intervalMinutes: number;
    username: string;
    password: string;
    sessionIdPrefix: string;
  };
  logSignatures: {
    application: string[];
    postgres: string[];
  };
  rules: Record<AlertRuleKey, AlertRuleConfig>;
}

const DEFAULT_RULE: AlertRuleConfig = {
  enabled: true,
  windowMinutes: 10,
  minSamples: 1,
  threshold: 1,
  criticalThreshold: 3,
  ratePercent: 50,
  openAfter: 1,
  resolveAfter: 2,
  notificationChannel: 'default',
};

function rule(overrides: Partial<AlertRuleConfig>): AlertRuleConfig {
  return { ...DEFAULT_RULE, ...overrides };
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  version: ALERT_CONFIG_VERSION,
  updatedAt: null,
  // 内置默认配置不含「外部管理」的规则；它们只可能来自被共用的配置文件。
  preservedRules: {},
  global: {
    enabled: true,
    environmentLabel: 'production',
    cooldownMinutes: 30,
    remindersEnabled: true,
    notifyOnRecovery: true,
    maxNotificationsPerHour: 20,
    autoRemediation: false,
    remediationCooldownMinutes: 10,
  },
  notification: {
    enabled: false,
    shadowMode: true,
    channel: 'feishu',
    minSeverity: 'warning',
    titlePrefix: 'd-obs',
    messageTemplate: DEFAULT_ALERT_MESSAGE_TEMPLATE,
    actionGuide: '查看可观测看板、服务日志、中心遥测和依赖健康状态。',
    dashboardUrl: 'http://127.0.0.1:47110/ops-observability#alerts',
      criticalChannel: '',
      warningChannel: '',
    recoveryTemplate: '',
    escalation: { ackTimeoutMinutes: 15, maxEscalations: 3, channel: '' },
    dingtalkWebhookUrl: '',
    wecomWebhookUrl: '',
    slackWebhookUrl: '',
    telegramWebhookUrl: '',
    dingtalkSignSecret: '',
    feishuWebhookUrl: '',
    webhookUrl: '',
    bearerSecret: '',
    feishuSignSecret: '',
  },
  synthetic: {
    intervalMinutes: 10,
    username: '',
    password: '',
    sessionIdPrefix: 'ops-probe',
  },
  logSignatures: {
    application: [
      'ERR_MODULE_NOT_FOUND',
      'ERR_PACKAGE_PATH_NOT_EXPORTED',
      'SyntaxError',
      'uncaughtException',
      'unhandledRejection',
      'Main process exited',
    ],
    postgres: [
      'FATAL:',
      'PANIC:',
      'deadlock detected',
      'too many clients',
      'out of memory',
      'could not write',
    ],
  },
  rules: {
    'ai-run-degraded-rate': rule({
      windowMinutes: 10,
      minSamples: 3,
      threshold: 2,
      criticalThreshold: 3,
      ratePercent: 50,
    }),
    'ai-auth-or-quota': rule({
      windowMinutes: 10,
      threshold: 2,
      criticalThreshold: 3,
    }),
    'agent-model-target-degraded': rule({
      windowMinutes: 10,
      threshold: 1,
      criticalThreshold: 2,
      openAfter: 1,
      resolveAfter: 2,
    }),
    // 阈值基于 2026-07-29~08-05 生产基线（日耗 4.8M~54.9M tokens）：
    // 预警取 P95 之上留余量，严重约 2 倍 P95；旧默认 2M/5M 低于日均，永久 critical。
    'llm-token-budget': rule({
      windowMinutes: 1440,
      threshold: 70_000_000,
      criticalThreshold: 120_000_000,
    }),
    'tool-failure-repeat': rule({
      windowMinutes: 10,
      threshold: 3,
      criticalThreshold: 6,
    }),
    'sso-infrastructure-failure': rule({
      windowMinutes: 10,
      threshold: 3,
      criticalThreshold: 6,
    }),
    'api-5xx-spike': rule({
      windowMinutes: 10,
      minSamples: 2,
      threshold: 3,
      criticalThreshold: 8,
    }),
    'process-unhandled-error': rule({
      windowMinutes: 10,
      threshold: 1,
      criticalThreshold: 2,
    }),
    'disk-space': rule({
      threshold: 90,
      criticalThreshold: 95,
      openAfter: 1,
    }),
    'node-memory-pressure': rule({
      threshold: 90,
      criticalThreshold: 95,
      openAfter: 3,
    }),
    'node-cpu-load': rule({
      threshold: 100,
      criticalThreshold: 200,
      openAfter: 3,
    }),
    'slo-error-budget-burn': rule({
      threshold: 2,
      criticalThreshold: 6,
      openAfter: 2,
    }),
    'evolution-worker-health': rule({
      threshold: 1,
      criticalThreshold: 2,
      openAfter: 2,
    }),
    // 阈值单位为分钟：链路是事件驱动流量，48h 预警 / 6d 严重，避免低峰误报。
    'otlp-trace-freshness': rule({
      threshold: 2_880,
      criticalThreshold: 8_640,
      openAfter: 1,
    }),
    // 阈值单位为 z 分数：比观测查询页的 3.5 粗筛更保守，避免每次波动都告警。
    'metric-anomaly': rule({
      threshold: 6,
      criticalThreshold: 10,
      windowMinutes: 240,
      openAfter: 2,
    }),
    'service-crash-signature': rule({
      windowMinutes: 2,
      threshold: 2,
      criticalThreshold: 4,
    }),
    'nginx-5xx-log': rule({
      windowMinutes: 5,
      threshold: 3,
      criticalThreshold: 8,
    }),
    'postgres-error-log': rule({
      windowMinutes: 5,
      threshold: 1,
      criticalThreshold: 3,
    }),
    'internal-health': rule({
      threshold: 3_000,
      criticalThreshold: 8_000,
      openAfter: 2,
    }),
    'public-health': rule({
      threshold: 5_000,
      criticalThreshold: 8_000,
      openAfter: 2,
    }),
    'central-database': rule({
      threshold: 1_500,
      criticalThreshold: 5_000,
      openAfter: 2,
    }),
    'synthetic-login': rule({
      enabled: false,
      threshold: 8_000,
      criticalThreshold: 15_000,
      openAfter: 2,
    }),
    'synthetic-ai-chat': rule({
      enabled: false,
      threshold: 30_000,
      criticalThreshold: 60_000,
      openAfter: 2,
    }),
    'synthetic-tool-call': rule({
      enabled: false,
      threshold: 45_000,
      criticalThreshold: 90_000,
      openAfter: 2,
    }),
    'external-dns': rule({
      threshold: 3_000,
      criticalThreshold: 8_000,
      openAfter: 2,
    }),
    'external-tls': rule({
      // Production uses Let's Encrypt's six-day short-lived profile; alert
      // before the two-day renewal safety floor instead of applying a 90-day
      // certificate threshold that is always red.
      threshold: 2,
      criticalThreshold: 2,
      openAfter: 2,
    }),
    'external-health': rule({
      threshold: 5_000,
      criticalThreshold: 10_000,
      openAfter: 2,
    }),
    'external-entry-asset': rule({
      threshold: 8_000,
      criticalThreshold: 15_000,
      openAfter: 2,
    }),
    // 北极星（越低越糟；6h 快照评估窗口）。阈值锚定 2026-08-26 生产基线：
    // Skill 命中率基线 78.9%、AI 审核一致率 79.2%、次日留存 8.7%、首次成功率 37.7%。
    'north-star-skill-hit-rate': rule({
      windowMinutes: 360,
      minSamples: 100,
      threshold: 65,
      criticalThreshold: 55,
    }),
    'north-star-ai-human-consistency': rule({
      windowMinutes: 360,
      minSamples: 10,
      threshold: 70,
      criticalThreshold: 55,
    }),
    'north-star-retention-d1': rule({
      windowMinutes: 360,
      minSamples: 30,
      threshold: 5,
      criticalThreshold: 2.5,
    }),
    'north-star-first-success-rate': rule({
      windowMinutes: 360,
      minSamples: 30,
      threshold: 30,
      criticalThreshold: 20,
    }),
  },
};

const ruleSchema = z
  .object({
    enabled: z.boolean(),
    windowMinutes: z.number().int().min(1).max(1_440),
    minSamples: z.number().int().min(1).max(100_000),
    // 上限放宽到 10 亿：llm-token-budget 以 token 计数（生产日基线 5M~55M），
    // 原 10M 上限会把合理阈值挡在 schema 外，导致整份配置回退到安全默认值。
    threshold: z.number().min(0).max(1_000_000_000),
    criticalThreshold: z.number().min(0).max(1_000_000_000),
    ratePercent: z.number().min(0).max(100),
    openAfter: z.number().int().min(1).max(60),
    resolveAfter: z.number().int().min(1).max(60),
    notificationChannel: z.enum(['default', ...ALERT_DELIVERY_CHANNEL_VALUES, 'none']),
    createdBy: z.string().trim().min(1).max(160).optional(),
    createdAt: z.string().datetime().optional(),
    updatedBy: z.string().trim().min(1).max(160).optional(),
    updatedAt: z.string().datetime().optional(),
  })
  .strict();

const alertDeliveryChannelSchema = z.enum(ALERT_DELIVERY_CHANNEL_VALUES);
const ruleKeys = ALERT_RULE_DEFINITIONS.map((item) => item.key) as [
  AlertRuleKey,
  ...AlertRuleKey[],
];
type AlertChannelWebhookField = (typeof ALERT_CHANNEL_WEBHOOK_FIELDS)[AlertDeliveryChannel];
type AlertChannelSecretFieldMap = {
  [K in keyof typeof ALERT_CHANNEL_WEBHOOK_FIELDS as `${K}WebhookUrl`]: string;
};
const alertChannelWebhookUrlFields = ALERT_DELIVERY_CHANNELS.map(
  (channel) => ALERT_CHANNEL_WEBHOOK_FIELDS[channel],
) as [AlertChannelWebhookField, ...AlertChannelWebhookField[]];

const alertConfigSchema = z
  .object({
    version: z.literal(ALERT_CONFIG_VERSION),
    updatedAt: z.string().datetime().nullable(),
    global: z
      .object({
        enabled: z.boolean(),
        environmentLabel: z.string().trim().min(1).max(80),
        cooldownMinutes: z.number().int().min(5).max(1_440),
        remindersEnabled: z.boolean(),
        notifyOnRecovery: z.boolean(),
        maxNotificationsPerHour: z.number().int().min(1).max(200),
        autoRemediation: z.boolean(),
        remediationCooldownMinutes: z.number().int().min(1).max(720),
      })
      .strict(),
    notification: z
      .object({
        enabled: z.boolean(),
        shadowMode: z.boolean(),
        channel: alertDeliveryChannelSchema,
        minSeverity: z.enum(['warning', 'critical']),
        titlePrefix: z.string().trim().min(1).max(80),
        messageTemplate: z.string().trim().min(1).max(2_000),
        actionGuide: z.string().trim().min(1).max(500),
        dashboardUrl: z.string().trim().url().max(2_048),
        criticalChannel: z
          .union([z.literal(''), z.enum(['default', ...ALERT_DELIVERY_CHANNEL_VALUES, 'none'])])
          .default(''),
        warningChannel: z
          .union([z.literal(''), z.enum(['default', ...ALERT_DELIVERY_CHANNEL_VALUES, 'none'])])
          .default(''),
        recoveryTemplate: z.string().trim().max(2_000).default(''),
        escalation: z
          .object({
            ackTimeoutMinutes: z.number().int().min(5).max(720),
            maxEscalations: z.number().int().min(0).max(10),
            channel: z
              .union([z.literal(''), z.enum(['default', ...ALERT_DELIVERY_CHANNEL_VALUES, 'none'])])
              .default(''),
          })
          .strict()
          .default({ ackTimeoutMinutes: 15, maxEscalations: 3, channel: '' }),
        feishuWebhookUrl: z.string().max(2_048),
        webhookUrl: z.string().max(2_048),
        bearerSecret: z.string().max(512),
        feishuSignSecret: z.string().max(512),
        dingtalkWebhookUrl: z.string().max(2_048),
        wecomWebhookUrl: z.string().max(2_048),
        slackWebhookUrl: z.string().max(2_048),
        telegramWebhookUrl: z.string().max(2_048),
        dingtalkSignSecret: z.string().max(512),
      })
      .strict(),
    synthetic: z
      .object({
        intervalMinutes: z.number().int().min(5).max(1_440),
        username: z.string().trim().max(160),
        password: z.string().max(256),
        sessionIdPrefix: z.string().regex(/^[a-z0-9-]{1,40}$/i),
      })
      .strict(),
    logSignatures: z
      .object({
        application: z.array(z.string().trim().min(2).max(160)).max(30),
        postgres: z.array(z.string().trim().min(2).max(160)).max(30),
      })
      .strict(),
    rules: z.record(z.enum(ruleKeys), ruleSchema),
    preservedRules: z.record(z.string(), z.unknown()).default({}),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const key of ruleKeys) {
      const rule = value.rules[key];
      if (!rule) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', key],
          message: '缺少告警规则',
        });
        continue;
      }
      if (LOWER_IS_WORSE_ALERT_RULE_KEYS.has(key)) {
        if (rule.criticalThreshold > rule.threshold) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rules', key, 'criticalThreshold'],
            message: '严重阈值不能高于普通阈值',
          });
        }
      } else if (rule.criticalThreshold < rule.threshold) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', key, 'criticalThreshold'],
          message: 'criticalThreshold 不能小于 threshold',
        });
      }
    }
    for (const field of alertChannelWebhookUrlFields) {
      const raw = value.notification[field].trim();
      if (!raw) continue;
      try {
        const url = new URL(raw);
        const localHttp =
          url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
        if (url.protocol !== 'https:' && !localHttp) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['notification', field],
            message: 'Webhook 必须使用 HTTPS（本机测试允许 HTTP）',
          });
        }
        if (url.username || url.password) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['notification', field],
            message: 'Webhook URL 不能内嵌用户名或密码',
          });
        }
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['notification', field],
          message: 'Webhook URL 无效',
        });
      }
    }
    const templateTokens: string[] =
      value.notification.messageTemplate.match(/\{\{[^}]+\}\}/g) ?? [];
    const allowedTemplateTokens = new Set<string>(
      ALERT_MESSAGE_TEMPLATE_VARIABLES.map((token) => `{{${token}}}`),
    );
    for (const token of templateTokens) {
      if (!allowedTemplateTokens.has(token)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['notification', 'messageTemplate'],
          message: `不支持的模板变量 ${token}`,
        });
      }
    }
    for (const requiredToken of ['{{title}}', '{{summary}}']) {
      if (!templateTokens.includes(requiredToken)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['notification', 'messageTemplate'],
          message: `模板必须包含 ${requiredToken}`,
        });
      }
    }
  });

function cloneDefaultConfig(): AlertConfig {
  return JSON.parse(JSON.stringify(DEFAULT_ALERT_CONFIG)) as AlertConfig;
}

function applyEnvironmentFallbacks(config: AlertConfig): AlertConfig {
  const next = cloneDefaultConfig();
  Object.assign(next, config);
  next.global = { ...DEFAULT_ALERT_CONFIG.global, ...config.global };
  next.notification = { ...DEFAULT_ALERT_CONFIG.notification, ...config.notification };
  next.synthetic = { ...DEFAULT_ALERT_CONFIG.synthetic, ...config.synthetic };
  next.logSignatures = { ...DEFAULT_ALERT_CONFIG.logSignatures, ...config.logSignatures };
  next.rules = { ...DEFAULT_ALERT_CONFIG.rules };
  for (const key of ruleKeys) {
    next.rules[key] = { ...DEFAULT_ALERT_CONFIG.rules[key], ...config.rules?.[key] };
  }

  // 旧环境变量只作为首次迁移 fallback；一旦配置文件写入，它就是唯一真源。
  const anyChannelUrlConfigured = ALERT_DELIVERY_CHANNELS.some(
    (channel) => next.notification[ALERT_CHANNEL_WEBHOOK_FIELDS[channel]],
  );
  if (!anyChannelUrlConfigured) {
    const fallbackUrl = String(process.env.RDK_ALERT_WEBHOOK_URL ?? '').trim();
    next.notification.bearerSecret = String(process.env.RDK_ALERT_WEBHOOK_SECRET ?? '').trim();
    next.notification.feishuSignSecret = String(
      process.env.RDK_ALERT_FEISHU_SIGN_SECRET ?? '',
    ).trim();
    next.notification.dingtalkSignSecret = String(
      process.env.RDK_ALERT_DINGTALK_SIGN_SECRET ?? '',
    ).trim();
    if (fallbackUrl) {
      next.notification.enabled = true;
      next.notification.shadowMode = !['0', 'false', 'off', 'no'].includes(
        String(process.env.RDK_ALERT_SHADOW_MODE ?? 'true')
          .trim()
          .toLowerCase(),
      );
      next.notification.channel = detectChannelFromUrl(fallbackUrl);
      next.notification[ALERT_CHANNEL_WEBHOOK_FIELDS[next.notification.channel]] = fallbackUrl;
    }
  }
  return next;
}

/** 按 URL 形状猜渠道：只用于环境变量迁移；配置文件才是最终真源。 */
function detectChannelFromUrl(url: string): AlertDeliveryChannel {
  if (process.env.RDK_ALERT_FEISHU_WEBHOOK === '1') return 'feishu';
  if (/open\.(?:feishu|larksuite)\./i.test(url)) return 'feishu';
  if (/oapi\.dingtalk\.com\/robot\/send/i.test(url)) return 'dingtalk';
  if (/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send/i.test(url)) return 'wecom';
  if (/hooks\.slack\.com\/services\//i.test(url)) return 'slack';
  if (/api\.telegram\.org\/bot\//i.test(url)) return 'telegram';
  return 'webhook';
}

const LEGACY_MODEL_TARGET_RULE_KEY = 'moss-model-target-degraded';

type StoredAlertConfig = Omit<Partial<AlertConfig>, 'notification' | 'rules'> & {
  notification?: Partial<AlertConfig['notification']>;
  rules?: Record<string, Partial<AlertRuleConfig> | undefined>;
};

export function normalizeStoredAlertConfig(raw: unknown): AlertConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return alertConfigSchema.parse(raw) as AlertConfig;
  }
  const stored = raw as StoredAlertConfig;
  const storedRules: Record<string, Partial<AlertRuleConfig> | undefined> = stored.rules ?? {};
  const normalized: AlertConfig = {
    ...cloneDefaultConfig(),
    ...stored,
    global: { ...DEFAULT_ALERT_CONFIG.global, ...(stored.global ?? {}) },
    notification: {
      ...DEFAULT_ALERT_CONFIG.notification,
      ...(stored.notification ?? {}),
    },
    synthetic: { ...DEFAULT_ALERT_CONFIG.synthetic, ...(stored.synthetic ?? {}) },
    logSignatures: {
      ...DEFAULT_ALERT_CONFIG.logSignatures,
      ...(stored.logSignatures ?? {}),
    },
    // 未知/旧规则键原样留档：本服务不编辑它们，但保存时必须写回文件
    // （旧键走 LEGACY_RULE_KEY_ALIASES 读写，但仍留档，整份写出时才不会丢）。
    preservedRules: Object.fromEntries(
      Object.entries(storedRules).filter(
        ([key, value]) =>
          !ruleKeys.includes(key as (typeof ruleKeys)[number]) &&
          Boolean(value) &&
          typeof value === 'object' &&
          !Array.isArray(value),
      ),
    ),
    rules: Object.fromEntries(
      ruleKeys.map((key) => [
        key,
        {
          ...DEFAULT_ALERT_CONFIG.rules[key],
          ...(storedRules[key] ??
            (key === 'agent-model-target-degraded'
              ? storedRules[LEGACY_MODEL_TARGET_RULE_KEY]
              : undefined) ??
            {}),
        },
      ]),
    ) as Record<AlertRuleKey, AlertRuleConfig>,
  };
  const legacyNotification =
    stored.notification && typeof stored.notification === 'object'
      ? (stored.notification as unknown as Record<string, unknown>)
      : null;
  if (
    legacyNotification &&
    !Object.prototype.hasOwnProperty.call(legacyNotification, 'feishuWebhookUrl') &&
    legacyNotification.channel === 'feishu' &&
    typeof legacyNotification.webhookUrl === 'string' &&
    legacyNotification.webhookUrl
  ) {
    normalized.notification.feishuWebhookUrl = legacyNotification.webhookUrl;
    normalized.notification.webhookUrl = '';
  }
  return alertConfigSchema.parse(normalized) as AlertConfig;
}

export function alertConfigPath(): string {
  const configured = String(process.env.RDK_ALERT_CONFIG_PATH ?? '').trim();
  if (configured) return configured;
  return process.env.NODE_ENV === 'production'
    ? DEFAULT_PRODUCTION_ALERT_CONFIG_PATH
    : path.join(os.homedir(), '.rdk-studio', 'alert-config.json');
}

export async function loadAlertConfig(): Promise<AlertConfig> {
  return alertConfigFromFileState(await alertConfigFileState());
}

/**
 * 配置文件在磁盘上的原始状态。
 *
 * 这里的 `rawText`/`parsed` 是**未经默认值合并**的原始文档——保存时必须以它为基准，
 * 否则「面板展示的默认值」会被当成用户的改动写进文件（见 {@link planAlertConfigWrite}）。
 */
export interface AlertConfigFileState {
  /** 文件原文；不存在或读失败时为 null。 */
  rawText: string | null;
  /** 文件确实不存在（ENOENT）。只有这种情况才吃旧环境变量 fallback。 */
  missing: boolean;
  /** 原文能解析成 JSON 对象。 */
  parseable: boolean;
  parsed: Record<string, unknown> | null;
  /** 文件 `rules` 里出现过的键（含未知键与旧键）。 */
  presentRuleKeys: string[];
  /** 其中本服务 schema 不认识的键。 */
  unknownRuleKeys: string[];
}

export function alertConfigFileStateFromText(rawText: string | null): AlertConfigFileState {
  if (rawText === null) {
    return {
      rawText: null,
      missing: true,
      parseable: false,
      parsed: null,
      presentRuleKeys: [],
      unknownRuleKeys: [],
    };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    const candidate = JSON.parse(rawText) as unknown;
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      parsed = candidate as Record<string, unknown>;
    }
  } catch {
    parsed = null;
  }
  const rawRules =
    parsed && parsed.rules && typeof parsed.rules === 'object' && !Array.isArray(parsed.rules)
      ? (parsed.rules as Record<string, unknown>)
      : {};
  const presentRuleKeys = Object.keys(rawRules);
  const known = new Set<string>(ruleKeys);
  return {
    rawText,
    missing: false,
    parseable: parsed !== null,
    parsed,
    presentRuleKeys,
    unknownRuleKeys: presentRuleKeys.filter((key) => !known.has(key)),
  };
}

export async function alertConfigFileState(): Promise<AlertConfigFileState> {
  // 解析顺序：PG（可达且行存在）→ 文件（PG 空时自动导入）→ 安全默认。
  // PG 不可用时整体回落文件语义（与历史行为一致）。RDK_ALERT_CONFIG_PG=0 可关闭。
  if (alertConfigPgStoreEnabled()) {
    try {
      const pgText = await readAlertConfigRawText();
      if (pgText !== null) {
        const state = alertConfigFileStateFromText(pgText);
        if (state.parseable) return state;
        // PG 行存在但解析不了：视为存储损坏，回落文件。
        warnAlertConfigStoreOnce('pg config row is not parseable; falling back to file');
      } else {
        const fileState = await readAlertConfigFileState();
        // PG 尚无配置而文件有：首次迁移，把文件原文导入 PG 后继续用文件语义。
        if (fileState.rawText !== null && fileState.parseable) {
          try {
            await writeAlertConfigRawText(fileState.rawText, 'file-import');
          } catch (error) {
            warnAlertConfigStoreOnce(`pg config import failed: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        return fileState;
      }
    } catch (error) {
      warnAlertConfigStoreOnce(`pg config read failed; falling back to file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return readAlertConfigFileState();
}

async function readAlertConfigFileState(): Promise<AlertConfigFileState> {
  try {
    return alertConfigFileStateFromText(await readFile(alertConfigPath(), 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return {
        rawText: null,
        missing: true,
        parseable: false,
        parsed: null,
        presentRuleKeys: [],
        unknownRuleKeys: [],
      };
    }
    console.warn(
      '[alert-config] config read failed; treating as absent:',
      error instanceof Error ? error.message : String(error),
    );
    // 读失败（EACCES 等）不算 missing：不能退回旧环境变量，只能退回安全默认。
    return {
      rawText: null,
      missing: false,
      parseable: false,
      parsed: null,
      presentRuleKeys: [],
      unknownRuleKeys: [],
    };
  }
}

/**
 * 去掉本服务 schema 不认识的字段，只为**校验**用；磁盘原文一字不动。
 *
 * 配置文件是共用的：别的部署/worker 会在里面放自己的字段（顶层、notification 里、
 * 甚至某条规则里）。而 `alertConfigSchema` 是 strict 的——一个多余字段就会让整份配置
 * 校验失败、退回安全默认值：面板显示的不是线上真实的告警配置，而一次保存（旧实现）
 * 会把这份「默认值」整份写回去，等于用默认值覆盖线上告警。
 *
 * 所以读取时只把未知字段滤掉做校验，未知字段本身留在磁盘原文里（写盘以原文为基准做
 * 最小改动，因此它们既不会被校验拒绝，也不会被写丢）。
 */
export function sanitizeStoredAlertConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULT_ALERT_CONFIG)) {
    if (key in raw) out[key] = raw[key];
  }
  for (const section of ['global', 'notification', 'synthetic', 'logSignatures'] as const) {
    const stored = raw[section];
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) continue;
    const allowed = new Set(Object.keys(DEFAULT_ALERT_CONFIG[section]));
    out[section] = Object.fromEntries(
      Object.entries(stored as Record<string, unknown>).filter(([name]) => allowed.has(name)),
    );
  }
  const storedRules = raw.rules;
  if (storedRules && typeof storedRules === 'object' && !Array.isArray(storedRules)) {
    out.rules = Object.fromEntries(
      Object.entries(storedRules as Record<string, unknown>).map(([key, value]) => {
        const definition = DEFAULT_ALERT_CONFIG.rules[key as AlertRuleKey] as unknown as
          | Record<string, unknown>
          | undefined;
        if (!definition || !value || typeof value !== 'object' || Array.isArray(value)) {
          return [key, value];
        }
        // 审计字段不在默认规则对象里（服务端盖章后才出现），必须随白名单放行，
        // 否则每次加载都会剥掉归属，第二次修改就会丢失首任创建者。
        const allowed = new Set([...Object.keys(definition), ...RULE_AUDIT_KEYS]);
        return [
          key,
          Object.fromEntries(
            Object.entries(value as Record<string, unknown>).filter(([name]) => allowed.has(name)),
          ),
        ];
      }),
    );
  }
  return out;
}

/**
 * 由磁盘状态还原出「面板看到的那份配置」。
 *
 * 与 {@link loadAlertConfig} 的失败语义保持一致：文件不存在才吃旧环境变量 fallback；
 * 解析失败/校验失败一律退回安全默认值（不启用任何通知）。
 */
export function alertConfigFromFileState(file: AlertConfigFileState): AlertConfig {
  if (file.missing) {
    return alertConfigSchema.parse(applyEnvironmentFallbacks(cloneDefaultConfig())) as AlertConfig;
  }
  if (!file.parseable || file.parsed === null) {
    return alertConfigSchema.parse(cloneDefaultConfig()) as AlertConfig;
  }
  try {
    return normalizeStoredAlertConfig(sanitizeStoredAlertConfig(file.parsed));
  } catch (error) {
    console.warn(
      '[alert-config] invalid config; using safe shadow defaults:',
      error instanceof Error ? error.message : String(error),
    );
    return alertConfigSchema.parse(cloneDefaultConfig()) as AlertConfig;
  }
}

/** 旧键 → 现键。文件里可能只有旧键，而线上 worker 读的正是旧键。 */
const LEGACY_RULE_KEY_ALIASES: Record<string, AlertRuleKey> = {
  [LEGACY_MODEL_TARGET_RULE_KEY]: 'agent-model-target-degraded',
};

function legacyAliasForRuleKey(key: AlertRuleKey): string | null {
  for (const [alias, canonical] of Object.entries(LEGACY_RULE_KEY_ALIASES)) {
    if (canonical === key) return alias;
  }
  return null;
}

/**
 * 文件里没有的已知规则键（把旧键算作「有」：`moss-` 旧键在文件里就等于那条规则在文件里）。
 *
 * 面板与写盘计划共用这一份判断，避免出现「面板说未写入、保存却按旧键写了」这种自相矛盾。
 */
export function defaultOnlyKnownRuleKeys(presentRuleKeys: readonly string[]): AlertRuleKey[] {
  return ruleKeys.filter((key) => {
    if (presentRuleKeys.includes(key)) return false;
    const alias = legacyAliasForRuleKey(key);
    return !(alias && presentRuleKeys.includes(alias));
  }) as AlertRuleKey[];
}

export interface AlertConfigWritePlan {
  /** 是否真的需要落盘。面板原样保存（没有改动）时为 false —— 不该碰文件。 */
  changed: boolean;
  /** 需要写入的文件内容（changed=false 时等于现有原文）。 */
  text: string;
  /** 本次真正改动的顶层字段，如 `global.enabled`。 */
  changedFields: string[];
  /** 本次真正改动的规则键（可能是旧键，见 aliasedRuleKeys）。 */
  changedRuleKeys: string[];
  /** 面板做了改动、但按文件里的旧键写入的映射：展示键 → 实际写入键。 */
  aliasedRuleKeys: Record<string, string>;
  /** 文件 `rules` 里没有的已知规则键（含只有旧键的情况）：不改动就不会被写进文件。 */
  defaultOnlyRuleKeys: AlertRuleKey[];
  /** 本次被显式「固定进配置文件」的规则键（取值未变也会写入）。 */
  pinnedRuleKeys: AlertRuleKey[];
  /** 本次是「整份写出」（文件不存在/损坏，没有可增补的基准文档）。 */
  fullWrite: boolean;
}

const RULE_SECTION_KEYS = ['global', 'notification', 'synthetic', 'logSignatures'] as const;

/**
 * 计算「把这次改动写回文件」的最小文档。
 *
 * 背景：面板展示的是「默认值 ⊕ 文件」。以前保存直接序列化这份合并结果，于是
 * 一次只改一条规则的保存会把**所有**已知规则键和所有默认字段物化进文件——
 * 共用该文件的线上 worker 会因此开始评估它原本没在评估的规则。
 *
 * 现在分两种情况：
 *  - 文件已存在且可解析（共用场景）→ 以文件原文为基准，只写 `next` 与 `current`
 *    真正不同的字段/规则键；没有改动就 `changed=false`，调用方完全不碰文件
 *    （连备份都不产生）。未知键、旧键、未知顶层字段一律原样保留。
 *  - 文件不存在/损坏（首次安装）→ 仍按老行为整份写出，作为后续的基准文档。
 *
 * 规则在文件里只有旧键时，改动写到旧键上：线上 worker 读的是旧键，写新键等于没改。
 */
export function planAlertConfigWrite(
  file: AlertConfigFileState,
  current: AlertConfig,
  next: AlertConfig,
  options: { pinRuleKeys?: readonly string[] } = {},
): AlertConfigWritePlan {
  const changedFields: string[] = [];
  const changedRuleKeys: string[] = [];
  const aliasedRuleKeys: Record<string, string> = {};
  const sharedDocument = file.parseable && file.parsed !== null;

  for (const section of RULE_SECTION_KEYS) {
    const currentSection = current[section] as Record<string, unknown>;
    const nextSection = next[section] as Record<string, unknown>;
    for (const name of Object.keys(nextSection)) {
      if (isDeepStrictEqual(currentSection[name], nextSection[name])) continue;
      changedFields.push(`${section}.${name}`);
    }
  }
  // 显式固定：即使取值与默认值相同也要写进文件，让「面板显示的值」= 「线上生效的值」。
  // 只接受文件里原本没有的已知规则键——已经在文件里的键本来就被固定着。
  const pinnedRuleKeys = ruleKeys.filter(
    (key) =>
      (options.pinRuleKeys ?? []).includes(key) &&
      !file.presentRuleKeys.includes(key) &&
      !(
        legacyAliasForRuleKey(key) &&
        file.presentRuleKeys.includes(legacyAliasForRuleKey(key) as string)
      ),
  ) as AlertRuleKey[];
  for (const key of ruleKeys) {
    if (isDeepStrictEqual(current.rules[key], next.rules[key]) && !pinnedRuleKeys.includes(key)) {
      continue;
    }
    const alias = legacyAliasForRuleKey(key);
    // 文件里只有旧键 → 改动落到旧键上，否则线上 worker 读不到这次修改。
    const written =
      sharedDocument && !file.presentRuleKeys.includes(key) && alias && file.presentRuleKeys.includes(alias)
        ? alias
        : key;
    changedRuleKeys.push(written);
    if (written !== key) aliasedRuleKeys[key] = written;
  }

  const defaultOnlyRuleKeys = defaultOnlyKnownRuleKeys(file.presentRuleKeys);

  if (!changedFields.length && !changedRuleKeys.length) {
    return {
      changed: false,
      text: file.rawText ?? '',
      changedFields,
      changedRuleKeys,
      aliasedRuleKeys,
      defaultOnlyRuleKeys,
      pinnedRuleKeys,
      fullWrite: false,
    };
  }

  if (!sharedDocument) {
    return {
      changed: true,
      text: serializeFullAlertConfig(next),
      changedFields,
      changedRuleKeys,
      aliasedRuleKeys,
      defaultOnlyRuleKeys,
      pinnedRuleKeys,
      fullWrite: true,
    };
  }

  const out: Record<string, unknown> = { ...file.parsed };
  for (const section of RULE_SECTION_KEYS) {
    const names = changedFields
      .filter((field) => field.startsWith(`${section}.`))
      .map((field) => field.slice(section.length + 1));
    if (!names.length) continue;
    const merged: Record<string, unknown> = {
      ...((out[section] as Record<string, unknown> | undefined) ?? {}),
    };
    for (const name of names) merged[name] = (next[section] as Record<string, unknown>)[name];
    out[section] = merged;
  }
  if (changedRuleKeys.length) {
    const rules: Record<string, unknown> = {
      ...((out.rules as Record<string, unknown> | undefined) ?? {}),
    };
    for (const key of ruleKeys) {
      const written = aliasedRuleKeys[key] ?? key;
      if (!changedRuleKeys.includes(written)) continue;
      rules[written] = next.rules[key];
    }
    out.rules = rules;
  }
  // updatedAt 只在确有改动时前进：否则「原样保存」也会改文件，等价性无从校验。
  out.updatedAt = next.updatedAt;
  return {
    changed: true,
    text: `${JSON.stringify(out, null, 2)}\n`,
    changedFields,
    changedRuleKeys,
    aliasedRuleKeys,
    defaultOnlyRuleKeys,
    pinnedRuleKeys,
    fullWrite: false,
  };
}

/** 落盘形态：保留键并回 rules（其它部署就是这么读的），不写 preservedRules 这个内部字段。 */
function serializeFullAlertConfig(config: AlertConfig): string {
  const { preservedRules, ...rest } = config;
  const onDisk = { ...rest, rules: { ...rest.rules, ...preservedRules } };
  return `${JSON.stringify(onDisk, null, 2)}\n`;
}

export interface AlertConfigPanelWriteResult {
  /** 是否真的落盘了（false = 没有任何改动，文件一个字节都没动）。 */
  changed: boolean;
  /** 写后（或未改动时）的配置视图。 */
  config: AlertConfig;
  /** 写后文件里出现过的 rules 键；文件不可解析时为 null。 */
  fileRuleKeys: string[] | null;
  plan: AlertConfigWritePlan;
}

/**
 * 面板保存告警配置的唯一入口：读盘 → 合并校验 → 最小改动落盘。
 *
 * 单独抽出来是为了让路由和测试跑**同一份**语义：面板保存最危险的行为
 * （把默认值物化进共用文件、把别人管理的规则写丢）都在这里被约束住。
 */
export async function applyPanelAlertConfigPatch(
  patch: AlertConfigPatch,
  options: { pinRuleKeys?: readonly string[]; actor?: string } = {},
): Promise<AlertConfigPanelWriteResult> {
  const file = await alertConfigFileState();
  const current = alertConfigFromFileState(file);
  const next = mergeAndValidateAlertConfig(current, patch, new Date(), { actor: options.actor });
  const plan = planAlertConfigWrite(file, current, next, options);
  if (plan.changed) await writeAlertConfigText(plan.text);
  const after = plan.changed ? alertConfigFileStateFromText(plan.text) : file;
  return {
    changed: plan.changed,
    config: plan.changed ? next : current,
    fileRuleKeys: after.parseable ? after.presentRuleKeys : null,
    plan,
  };
}

export type AlertConfigPatch = {
  global?: Partial<AlertConfig['global']>;
  notification?: Partial<
    Omit<AlertConfig['notification'], keyof AlertChannelSecretFieldMap>
  > &
    Partial<Record<keyof AlertChannelSecretFieldMap, string>> & {
      clearDingtalkWebhookUrl?: boolean;
      clearWecomWebhookUrl?: boolean;
      clearSlackWebhookUrl?: boolean;
      clearTelegramWebhookUrl?: boolean;
      clearDingtalkSignSecret?: boolean;
      clearFeishuWebhookUrl?: boolean;
      clearWebhookUrl?: boolean;
      clearBearerSecret?: boolean;
      clearFeishuSignSecret?: boolean;
    };
  synthetic?: Partial<AlertConfig['synthetic']> & {
    clearPassword?: boolean;
  };
  logSignatures?: Partial<AlertConfig['logSignatures']>;
  rules?: Partial<Record<AlertRuleKey, Partial<AlertRuleConfig>>>;
};

const RULE_AUDIT_KEYS = ['createdBy', 'createdAt', 'updatedBy', 'updatedAt'] as const;

/** 审计字段只由服务端盖章：合并与等值比较前剥除，防止提交方伪造归属或凭空触发落盘。 */
function stripRuleAudit(rule: Partial<AlertRuleConfig>): Partial<AlertRuleConfig> {
  const rest: Record<string, unknown> = { ...rule };
  for (const key of RULE_AUDIT_KEYS) delete rest[key];
  return rest as Partial<AlertRuleConfig>;
}

export function mergeAndValidateAlertConfig(
  current: AlertConfig,
  patch: AlertConfigPatch,
  now = new Date(),
  audit: { actor?: string } = {},
): AlertConfig {
  const notificationPatch = patch.notification ?? {};
  const syntheticPatch = patch.synthetic ?? {};
  const next: AlertConfig = {
    ...current,
    version: ALERT_CONFIG_VERSION,
    updatedAt: now.toISOString(),
    global: { ...current.global, ...(patch.global ?? {}) },
    notification: {
      ...current.notification,
      ...notificationPatch,
      feishuWebhookUrl: notificationPatch.clearFeishuWebhookUrl
        ? ''
        : notificationPatch.feishuWebhookUrl?.trim() || current.notification.feishuWebhookUrl,
      webhookUrl: notificationPatch.clearWebhookUrl
        ? ''
        : notificationPatch.webhookUrl?.trim() || current.notification.webhookUrl,
      bearerSecret: notificationPatch.clearBearerSecret
        ? ''
        : notificationPatch.bearerSecret || current.notification.bearerSecret,
      feishuSignSecret: notificationPatch.clearFeishuSignSecret
        ? ''
        : notificationPatch.feishuSignSecret || current.notification.feishuSignSecret,
      dingtalkWebhookUrl: notificationPatch.clearDingtalkWebhookUrl
        ? ''
        : notificationPatch.dingtalkWebhookUrl?.trim() || current.notification.dingtalkWebhookUrl,
      dingtalkSignSecret: notificationPatch.clearDingtalkSignSecret
        ? ''
        : notificationPatch.dingtalkSignSecret || current.notification.dingtalkSignSecret,
      wecomWebhookUrl: notificationPatch.clearWecomWebhookUrl
        ? ''
        : notificationPatch.wecomWebhookUrl?.trim() || current.notification.wecomWebhookUrl,
      slackWebhookUrl: notificationPatch.clearSlackWebhookUrl
        ? ''
        : notificationPatch.slackWebhookUrl?.trim() || current.notification.slackWebhookUrl,
      telegramWebhookUrl: notificationPatch.clearTelegramWebhookUrl
        ? ''
        : notificationPatch.telegramWebhookUrl?.trim() || current.notification.telegramWebhookUrl,
    },
    synthetic: {
      ...current.synthetic,
      ...syntheticPatch,
      password: syntheticPatch.clearPassword
        ? ''
        : syntheticPatch.password || current.synthetic.password,
    },
    logSignatures: {
      ...current.logSignatures,
      ...(patch.logSignatures ?? {}),
    },
    rules: { ...current.rules },
    preservedRules: { ...current.preservedRules },
  };
  delete (next.notification as Record<string, unknown>).clearFeishuWebhookUrl;
  delete (next.notification as Record<string, unknown>).clearWebhookUrl;
  delete (next.notification as Record<string, unknown>).clearBearerSecret;
  delete (next.notification as Record<string, unknown>).clearFeishuSignSecret;
  delete (next.notification as Record<string, unknown>).clearDingtalkWebhookUrl;
  delete (next.notification as Record<string, unknown>).clearDingtalkSignSecret;
  delete (next.notification as Record<string, unknown>).clearWecomWebhookUrl;
  delete (next.notification as Record<string, unknown>).clearSlackWebhookUrl;
  delete (next.notification as Record<string, unknown>).clearTelegramWebhookUrl;
  delete (next.synthetic as Record<string, unknown>).clearPassword;
  for (const key of ruleKeys) {
    const previous = current.rules[key];
    const patchRule = patch.rules?.[key];
    const merged: AlertRuleConfig = {
      ...previous,
      ...(patchRule ? stripRuleAudit(patchRule) : {}),
    };
    // 只有参数确有变化才盖章：原样保存不能凭空产生「修改记录」，这与落盘侧
    // 「updatedAt 只在确有改动时前进」的纪律是同一条规则。
    if (audit.actor && !isDeepStrictEqual(stripRuleAudit(previous), stripRuleAudit(merged))) {
      merged.updatedBy = audit.actor;
      merged.updatedAt = now.toISOString();
      if (!previous.createdBy) {
        merged.createdBy = audit.actor;
        merged.createdAt = now.toISOString();
      }
    }
    next.rules[key] = merged;
  }
  return alertConfigSchema.parse(next) as AlertConfig;
}

/**
 * 覆写前留一份时间戳备份（保留最近 {@link ALERT_CONFIG_BACKUP_KEEP} 份）。
 *
 * 告警配置是**活的运维数据**：同一份文件可能被多个部署/进程使用，而每个写入方
 * 只认识自己那套规则键。真机验证时发现线上那份 26 条规则的配置里有 3 条
 * `moss-model-target-degraded` / `l4-shadow-ready-to-for-observe` /
 * `l4-canary-ready-for-approval` 是 d-obs 的 schema 不认识的，写回时会被丢掉
 * ——一次误写就可能静默关掉别人的告警。备份不能阻止这种丢字段，但能让它可恢复。
 */
const ALERT_CONFIG_BACKUP_KEEP = 5;

async function backupAlertConfigIfPresent(target: string): Promise<void> {
  let existing: string;
  try {
    existing = await readFile(target, 'utf8');
  } catch {
    return; // 首次写入没有可备份的内容
  }
  // 保留毫秒：同秒内的连续写入各自成档，且字典序仍等于时间序。
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.(\d{3})Z$/, '$1Z');
  await writeFile(`${target}.bak-${stamp}`, existing, { encoding: 'utf8', mode: 0o600 }).catch(
    () => undefined,
  );
  // 只保留最近若干份，避免无限堆积（配置写入本身很罕见）。
  const dir = path.dirname(target);
  const base = path.basename(target);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const backups = entries
    .filter((name) => name.startsWith(`${base}.bak-`))
    .sort()
    .reverse();
  for (const stale of backups.slice(ALERT_CONFIG_BACKUP_KEEP)) {
    await rm(path.join(dir, stale), { force: true }).catch(() => undefined);
  }
}

export async function saveAlertConfig(config: AlertConfig): Promise<void> {
  await writeAlertConfigText(serializeFullAlertConfig(config));
}

/** 备份 + 原子写入（0600）。写给共用文件的**最小改动**也走这里。 */
export async function writeAlertConfigText(text: string): Promise<void> {
  const target = alertConfigPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await backupAlertConfigIfPresent(target);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, text, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, target);
  // 文件仍是写盘基准（面板最小 diff 机制依赖磁盘原文）；PG 是跨副本的一致读源。
  // PG 写失败不阻断保存（文件已落盘），读路径会继续用文件语义。
  if (alertConfigPgStoreEnabled()) {
    try {
      await writeAlertConfigRawText(text, 'panel');
    } catch (error) {
      warnAlertConfigStoreOnce(`pg config write failed; file already saved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function configuredHost(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

export function toPublicAlertConfig(
  config: AlertConfig,
  options: { fileRuleKeys?: string[] | null } = {},
) {
  const defaultWebhookUrl =
    ALERT_CHANNEL_WEBHOOK_FIELDS[config.notification.channel] != null
      ? config.notification[ALERT_CHANNEL_WEBHOOK_FIELDS[config.notification.channel]]
      : '';
  const fileRuleKeys = options.fileRuleKeys ?? null;
  const channelStatus = alertChannelOptions().map((option) => {
    const field = ALERT_CHANNEL_WEBHOOK_FIELDS[option.value];
    const rawUrl = String(config.notification[field] ?? '');
    return {
      channel: option.value,
      label: option.label,
      description: option.description,
      webhookConfigured: Boolean(rawUrl),
      webhookHost: configuredHost(rawUrl),
    };
  });
  const defaultChannelEntry = channelStatus.find(
    (item) => item.channel === config.notification.channel,
  );
  return {
    version: config.version,
    updatedAt: config.updatedAt,
    global: config.global,
    /**
     * 配置文件里由其它系统管理的规则键（本面板不编辑）。让面板能如实说明
     * 「你看到的不是全部规则」，而不是让运维以为改了面板就管住了所有告警。
     */
    unmanagedRuleKeys: Object.keys(config.preservedRules)
      .filter((key) => !Object.prototype.hasOwnProperty.call(LEGACY_RULE_KEY_ALIASES, key))
      .sort(),
    /**
     * 只在默认值里存在、配置文件里没有的规则键。这些规则**线上并未评估**，
     * 面板不能把它显示成「已启用」而不加说明：不改动就不会写进文件。
     */
    defaultOnlyRuleKeys:
      fileRuleKeys === null ? [] : defaultOnlyKnownRuleKeys(fileRuleKeys),
    /** 配置文件是否存在（false = 面板展示的全是内置默认值）。 */
    configFilePresent: fileRuleKeys !== null,
    notification: {
      enabled: config.notification.enabled,
      shadowMode: config.notification.shadowMode,
      channel: config.notification.channel,
      channelLabel: ALERT_CHANNEL_LABELS[config.notification.channel],
      minSeverity: config.notification.minSeverity,
      titlePrefix: config.notification.titlePrefix,
      messageTemplate: config.notification.messageTemplate,
      actionGuide: config.notification.actionGuide,
      dashboardUrl: config.notification.dashboardUrl,
      webhookConfigured: defaultChannelEntry?.webhookConfigured ?? false,
      webhookHost: defaultChannelEntry?.webhookHost ?? null,
      feishuWebhookConfigured: Boolean(config.notification.feishuWebhookUrl),
      feishuWebhookHost: configuredHost(config.notification.feishuWebhookUrl),
      genericWebhookConfigured: Boolean(config.notification.webhookUrl),
      genericWebhookHost: configuredHost(config.notification.webhookUrl),
      dingtalkWebhookConfigured: Boolean(config.notification.dingtalkWebhookUrl),
      dingtalkWebhookHost: configuredHost(config.notification.dingtalkWebhookUrl),
      wecomWebhookConfigured: Boolean(config.notification.wecomWebhookUrl),
      wecomWebhookHost: configuredHost(config.notification.wecomWebhookUrl),
      slackWebhookConfigured: Boolean(config.notification.slackWebhookUrl),
      slackWebhookHost: configuredHost(config.notification.slackWebhookUrl),
      telegramWebhookConfigured: Boolean(config.notification.telegramWebhookUrl),
      telegramWebhookHost: configuredHost(config.notification.telegramWebhookUrl),
      bearerSecretConfigured: Boolean(config.notification.bearerSecret),
      feishuSignSecretConfigured: Boolean(config.notification.feishuSignSecret),
      dingtalkSignSecretConfigured: Boolean(config.notification.dingtalkSignSecret),
      channels: channelStatus,
    },
    synthetic: {
      intervalMinutes: config.synthetic.intervalMinutes,
      username: config.synthetic.username,
      passwordConfigured: Boolean(config.synthetic.password),
      sessionIdPrefix: config.synthetic.sessionIdPrefix,
    },
    logSignatures: config.logSignatures,
    rules: config.rules,
    definitions: ALERT_RULE_DEFINITIONS,
  };
}

export function alertConfigValidationMessage(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('；');
  }
  return error instanceof Error ? error.message : String(error);
}
