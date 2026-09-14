/**
 * RDK Studio 生产告警的单一配置真源。
 *
 * 配置文件包含通知 Webhook 和合成拨测账号，因此只允许写入仓库外的 0600 文件。
 * 任何发给浏览器的响应都必须先经过 toPublicAlertConfig()，不能直接序列化 AlertConfig。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

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
    description: '从 106.53 独立主机解析生产域名并测量耗时。',
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
    description: '从 106.53 访问生产公网健康接口并校验响应。',
    fields: ['threshold', 'criticalThreshold'],
  },
  {
    key: 'external-entry-asset',
    category: 'probe',
    title: '异地前端入口拨测',
    description: '从 106.53 访问首页及其入口 JavaScript 资源。',
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
export type AlertNotificationChannel = 'default' | 'feishu' | 'webhook' | 'none';

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
}

export interface AlertConfig {
  version: 1;
  updatedAt: string | null;
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
    channel: 'feishu' | 'webhook';
    minSeverity: 'warning' | 'critical';
    titlePrefix: string;
    messageTemplate: string;
    actionGuide: string;
    dashboardUrl: string;
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
  global: {
    enabled: true,
    environmentLabel: 'production / 47.110',
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
    titlePrefix: 'RDK Studio',
    messageTemplate: DEFAULT_ALERT_MESSAGE_TEMPLATE,
    actionGuide: '查看可观测看板、服务日志、中心遥测和依赖健康状态。',
    dashboardUrl: 'https://rdkstudio.d-robotics.cc/rdkstudio/ops-observability#rules',
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
    notificationChannel: z.enum(['default', 'feishu', 'webhook', 'none']),
  })
  .strict();

const ruleKeys = ALERT_RULE_DEFINITIONS.map((item) => item.key) as [
  AlertRuleKey,
  ...AlertRuleKey[],
];

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
        channel: z.enum(['feishu', 'webhook']),
        minSeverity: z.enum(['warning', 'critical']),
        titlePrefix: z.string().trim().min(1).max(80),
        messageTemplate: z.string().trim().min(1).max(2_000),
        actionGuide: z.string().trim().min(1).max(500),
        dashboardUrl: z.string().trim().url().max(2_048),
        feishuWebhookUrl: z.string().max(2_048),
        webhookUrl: z.string().max(2_048),
        bearerSecret: z.string().max(512),
        feishuSignSecret: z.string().max(512),
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
    for (const field of ['feishuWebhookUrl', 'webhookUrl'] as const) {
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
  if (!next.notification.webhookUrl && !next.notification.feishuWebhookUrl) {
    const fallbackUrl = String(process.env.RDK_ALERT_WEBHOOK_URL ?? '').trim();
    next.notification.bearerSecret = String(process.env.RDK_ALERT_WEBHOOK_SECRET ?? '').trim();
    next.notification.feishuSignSecret = String(
      process.env.RDK_ALERT_FEISHU_SIGN_SECRET ?? '',
    ).trim();
    if (fallbackUrl) {
      next.notification.enabled = true;
      next.notification.shadowMode = !['0', 'false', 'off', 'no'].includes(
        String(process.env.RDK_ALERT_SHADOW_MODE ?? 'true')
          .trim()
          .toLowerCase(),
      );
      next.notification.channel =
        process.env.RDK_ALERT_FEISHU_WEBHOOK === '1' ||
        /open\.(?:feishu|larksuite)\./i.test(fallbackUrl)
          ? 'feishu'
          : 'webhook';
      if (next.notification.channel === 'feishu') {
        next.notification.feishuWebhookUrl = fallbackUrl;
      } else {
        next.notification.webhookUrl = fallbackUrl;
      }
    }
  }
  return next;
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
  try {
    const raw = JSON.parse(await readFile(alertConfigPath(), 'utf8')) as unknown;
    return normalizeStoredAlertConfig(raw);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') {
      return alertConfigSchema.parse(
        applyEnvironmentFallbacks(cloneDefaultConfig()),
      ) as AlertConfig;
    }
    console.warn(
      '[alert-config] invalid config; using safe shadow defaults:',
      error instanceof Error ? error.message : String(error),
    );
    return alertConfigSchema.parse(cloneDefaultConfig()) as AlertConfig;
  }
}

export type AlertConfigPatch = {
  global?: Partial<AlertConfig['global']>;
  notification?: Partial<
    Omit<
      AlertConfig['notification'],
      'feishuWebhookUrl' | 'webhookUrl' | 'bearerSecret' | 'feishuSignSecret'
    >
  > & {
    feishuWebhookUrl?: string;
    webhookUrl?: string;
    bearerSecret?: string;
    feishuSignSecret?: string;
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

export function mergeAndValidateAlertConfig(
  current: AlertConfig,
  patch: AlertConfigPatch,
  now = new Date(),
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
  };
  delete (next.notification as Record<string, unknown>).clearFeishuWebhookUrl;
  delete (next.notification as Record<string, unknown>).clearWebhookUrl;
  delete (next.notification as Record<string, unknown>).clearBearerSecret;
  delete (next.notification as Record<string, unknown>).clearFeishuSignSecret;
  delete (next.synthetic as Record<string, unknown>).clearPassword;
  for (const key of ruleKeys) {
    next.rules[key] = { ...current.rules[key], ...(patch.rules?.[key] ?? {}) };
  }
  return alertConfigSchema.parse(next) as AlertConfig;
}

export async function saveAlertConfig(config: AlertConfig): Promise<void> {
  const target = alertConfigPath();
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  await rename(temp, target);
}

function configuredHost(rawUrl: string): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

export function toPublicAlertConfig(config: AlertConfig) {
  const defaultWebhookUrl =
    config.notification.channel === 'feishu'
      ? config.notification.feishuWebhookUrl
      : config.notification.webhookUrl;
  return {
    version: config.version,
    updatedAt: config.updatedAt,
    global: config.global,
    notification: {
      enabled: config.notification.enabled,
      shadowMode: config.notification.shadowMode,
      channel: config.notification.channel,
      minSeverity: config.notification.minSeverity,
      titlePrefix: config.notification.titlePrefix,
      messageTemplate: config.notification.messageTemplate,
      actionGuide: config.notification.actionGuide,
      dashboardUrl: config.notification.dashboardUrl,
      webhookConfigured: Boolean(defaultWebhookUrl),
      webhookHost: configuredHost(defaultWebhookUrl),
      feishuWebhookConfigured: Boolean(config.notification.feishuWebhookUrl),
      feishuWebhookHost: configuredHost(config.notification.feishuWebhookUrl),
      genericWebhookConfigured: Boolean(config.notification.webhookUrl),
      genericWebhookHost: configuredHost(config.notification.webhookUrl),
      bearerSecretConfigured: Boolean(config.notification.bearerSecret),
      feishuSignSecretConfigured: Boolean(config.notification.feishuSignSecret),
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
