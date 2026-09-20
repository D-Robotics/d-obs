# d-obs 架构证据索引

对应模型：`d-obs.structurizr.dsl`、`runtime-topology.dot`、`dataflow-ingest-alert.dot`。
置信度定义：**high** = 代码/配置/文档直接证据；**medium** = 多个间接信号一致；**low** = 命名/结构推断（已显式标注）。

## 系统与边界

| 主张 | 证据 | 置信度 |
| --- | --- | --- |
| d-obs 是独立可观测平台，自 Studio 按 D-010 抽取 | `README.md:1-6`、`docs/decisions/D-010-observability-domain-boundary.md`（状态：生效）、`package.json:6` | high |
| 跨域只经 `shared` contract / route facade | `README.md:328-333`（边界约束 D-010）、`shared/`（13 个 contract 文件） | high |
| 双进程共享一库；行动环执行由 worker 派生 | `README.md:309-310`、`package.json:8-10`、`server/monitoring/studio-alert-worker.ts` | high |

## 容器与进程

| 主张 | 证据 | 置信度 |
| --- | --- | --- |
| Web 进程入口与挂载顺序（探针摄取 → 事件 → 生态 → 公共 API → 工作台路由） | `server/main.ts:109-112` | high |
| Express + trust proxy 默认 loopback | `server/main.ts:34-40`、`server/trusted-proxy.ts` | high |
| 可选 OTLP/gRPC receiver（配置端口才启用） | `server/main.ts:125-133`、`server/observability/ai-ecosystem-grpc.ts`、`README.md:245` | high |
| 治理运行时在 Web 进程内启动，失败仅关闭 trace 域（fail-open） | `server/main.ts:116-121`、`server/observability/governance-runtime-service.ts` | high |
| 生产端口 18093、systemd 单元 `d-obs`、`/opt/d-obs/current` 软链发布 + 健康检查自动回滚 | `ops/deploy.sh:24-25`、`ops/deploy.sh:160-183` | high |
| Worker 独立进程、60s 一轮、配置文件路径 | `README.md:109-117`、`package.json:9` | high |
| 开发默认端口 47110 | `server/main.ts:114`、`README.md:32` | high |

## 摄取面

| 主张 | 证据 | 置信度 |
| --- | --- | --- |
| 探针上报双凭证域（平台 token 文件 / 租户库内 sha256），无效 401 | `server/main.ts:87-107`、`server/monitoring/external-probe-ingest.ts`、`README.md:218-226` | high |
| 租户自助注册 fail-closed（未配注册 token 即 503） | `server/main.ts:51-85`、`README.md:234` | high |
| OTLP 三通道：HTTP JSON / HTTP protobuf / 可选 gRPC | `server/observability/ai-ecosystem-routes.ts`、`ai-ecosystem-protobuf.ts`、`ai-ecosystem-grpc.ts`、`README.md:25` | high |
| 只保留低敏感 AI 语义字段，不收 prompt/completion/工具参数 | `README.md:39-42`、`shared/ai-observability-semantics.ts` | high |
| Prometheus 15s 抓取 127.0.0.1:18093/metrics | `ops/prometheus/prometheus.yml:6-9` | high |
| OTLP 指标经 Prometheus 抓取持久化（近期提交） | `git log`：f6b3b46 "feat: persist OTLP metrics through Prometheus scrape"、`server/observability/ai-ecosystem-metrics.ts` | high |
| 事件埋点摄取写 `studio_ops_events`（消毒去重） | `server/main.ts:108-109`、`server/monitoring/ops-event-ingest.ts` | high |

## 告警与投递

| 主张 | 证据 | 置信度 |
| --- | --- | --- |
| 事故状态机（Pending→open→escalated/reminder→resolved；unknown 不误恢复；已端到端实测） | `server/monitoring/studio-alert-state.ts`、`studio-alert-state.test.ts`、`README.md:44-56` | high |
| 6 渠道投递（飞书/钉钉/企微/Slack/Telegram/通用 Webhook）+ 影子模式兜底 | `server/monitoring/alert-notification-channels.ts`、`studio-alert-delivery.ts`、`README.md:13`、`README.md:250-251` | high |
| 维护窗口：静默不投递、事故照记、窗口后补发 | `server/monitoring/alert-maintenance-windows.ts`（+test）、`README.md:13` | high |
| 升级链：ack 超时重发、每事故 ≤3 次、确认即止 | `server/monitoring/alert-escalation.ts`（+test）、`README.md:13`、`README.md:237` | high |
| 白名单自愈（nginx reload 前置校验、重启 worker；冷却期+双人审批） | `server/monitoring/alert-remediation.ts`、`alert-remediation-runner.ts`、`README.md:17` | high |
| 心跳降级（external 检查 >3min、worker >3min） | `README.md:54-56` | high |
| 公开状态页免鉴权只读、输出脱敏 | `server/monitoring/ops-status-page.ts`（+test）、`README.md:14` | high |

## 行动环 / 模型池 / 鉴权

| 主张 | 证据 | 置信度 |
| --- | --- | --- |
| 行动环：提案→proof→他人审批→白名单剧本→后置验证；无裸执行 | `server/monitoring/observability-action-loop.ts`、`observability-action-proof.ts`、`observability-action-routes.ts`、`README.md:16` | high |
| 模型池：目标健康、单目标真实探测、路由优先级、替换（先预探测、快照回滚） | `server/monitoring/gateway-health-probe.ts`、`gateway-target-health.ts`、`server/credits/gateway-admin-client.ts`、`README.md:21` | high |
| 鉴权：admin token timing-safe、SSO 双通道、变更端点要求 `x-rdk-ops-action` 头 | `server/main.ts:42-48`、`server/monitoring/observability-access.ts`（+test）、`README.md:284-291` | high |
| SSO 中继 18090、登录双段限流、XFF 透传依赖主站 `EXPRESS_TRUST_PROXY=1` | `server/monitoring/sso-relay.ts`（+test）、`README.md:235-237`、`README.md:264-270` | high |
| 租户隔离：`tenant_id` 列过滤、`t.<tenantId>.<key>` 命名空间、停用即 401 | `server/monitoring/tenant-store.ts`（+test）、`tenant-members-store.ts`、`README.md:218-226` | high |

## 运行拓扑

| 主张 | 证据 | 置信度 |
| --- | --- | --- |
| 生产主机 47.110.142.255、root SSH 发布 | `ops/deploy.sh:24` | high |
| 发布流水线（sha256 双向校验、硬链 node_modules、健康检查失败自动回滚） | `ops/deploy.sh:112-191` | high |
| 租户探针与保留期清理由 systemd timer 驱动 | `ops/probes/tenant-probe@.service`、`tenant-probe@.timer`、`ops/retention/tenant-events-retention.*`、`tools/trim-tenant-events.mjs` | high |
| nginx 反代在生产主机上、信任回环 XFF | `server/main.ts:36-38`（注释“生产是 nginx 反代到 127.0.0.1:18093”）、`server/trusted-proxy.ts`、`README.md:239` | high |
| CI：typecheck + test + 无库冒烟启动（优雅降级契约） | `.github/workflows/ci.yml` | high |

## 低置信 / 待验证

| 主张 | 证据 | 置信度 |
| --- | --- | --- |
| `@deepseek-ai/dsh-*` 依赖用于合成探针/会话（命名与 `dsh-synthetic-probe-client.ts` 吻合，未逐行确认） | `package.json:17-18`、`server/monitoring/dsh-synthetic-probe-client.ts` | medium |
| `supabase-*.ts` / `analytics-cloud-forward.ts` 为上游云转发路径，当前部署启用状态未知 | `server/supabase-conversation.ts`、`server/analytics-cloud-forward.ts`（存在性 high；运行时是否启用 low） | low |
| 生产 PostgreSQL 为容器化 | `RDK_ALERT_POSTGRES_CONTAINER` 变量名（`README.md:253`）；仓库内无 compose/unit 文件 | low |
| nginx 配置本体 | 生产主机上，仓库无副本 | unknown |
