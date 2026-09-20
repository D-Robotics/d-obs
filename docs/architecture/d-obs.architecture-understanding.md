# d-obs 架构总览（当前状态）

- **场景**：system-modeler（当前状态建模）
- **受众**：RDK Studio 架构/运维/开发
- **日期**：2026-09-20（基于 main @ 9a6d74c）
- **范围**：本仓库全部代码、部署资产与文档；不包含 RDK Studio 主站内部实现

## 这个系统是什么

d-obs 是面向 D-Robotics 生产环境的**独立可观测平台**：一个仓库、**双进程**（Web 服务 + 告警评估 Worker）共享**一个 PostgreSQL**，提供运营工作台、告警评估与投递、链路追踪、运营指标、数据库只读资产、模型池控制面。它从 RDK Studio 单仓按架构决策 **D-010**（`docs/decisions/D-010-observability-domain-boundary.md`，状态：生效）抽取为独立域，与业务站点只通过 HTTP 端点、版本化 contract（`shared/`）和共享数据库耦合。

## 阅读顺序

1. **系统上下文 + 容器视图**：`d-obs.structurizr.dsl`（用 Qoder 的 Structurizr DSL 查看器打开，或粘到 Structurizr Playground）
2. **运行拓扑（生产）**：`runtime-topology.dot`（`dot -Tsvg runtime-topology.dot -o runtime-topology.svg` 预览）
3. **数据流（摄取→评估→投递）**：`dataflow-ingest-alert.dot`
4. 证据与置信度：`d-obs.evidence.md`
5. 结论与维护方式：`overview.summary.md`

## 关键结构（L2 容器 → L3 模块）

| 容器 | 入口 | 内部模块（L3） |
| --- | --- | --- |
| Web 服务进程 | `server/main.ts`（`npm start`，生产端口 18093） | `server/monitoring/`：工作台 SSR 页面与脚本、路由、告警策略/投递/升级链/维护窗口、自愈剧本、行动环（提案→proof→审批→执行→验证）、模型池探测与路由、数据库目录、租户、SSO 中继、状态页、探针摄取<br>`server/observability/`：OTLP HTTP(JSON/protobuf) 路由、可选 gRPC receiver、trace store/outbox、run locator（AEAD 密封）、治理运行时（保留策略、tombstone 重放、审计、删除）<br>`server/public-api/`：公共观测 API v1<br>`server/flywheel/`：运营指标（token/天、DAU、对话、Agent Run）<br>`server/credits/`：网关 admin client、凭据管理<br>`server/evolution/`：每日自我进化候选治理 |
| 告警评估 Worker | `server/monitoring/studio-alert-worker.ts`（`npm run worker`） | 规则评估（指标/日志/拨测 + internal-health、磁盘、systemd、nginx 日志、PG 容器、公网健康、网关目标健康文件）、事故状态机、升级链、维护窗口、6 渠道投递、白名单自愈、行动环后置验证 |
| 中心 PostgreSQL | `tools/init-schema.sql` + `tools/unified-observability-schema.sql` + `tools/telemetry-governance-schema.sql` | 告警检查/事故/通知、租户（探针 token 只存 sha256）、ops 事件、run/trace 投影、审计、保留策略 |

**进程模型要点**：Web 与 Worker **不直连**，只通过 PostgreSQL 交换状态；行动环/自愈的执行由 Worker 按白名单剧本派生，不阻塞 Web 进程（README「进程模型」）。

## 关键边界与设计约束

- **D-010 边界**：跨域只经 `shared` 版本化 contract 或 route facade；鉴权不复制（复用主站 account/owner 语义，adapter 注入）；运行时隔离优先（当前已达成双进程）。
- **Fail-closed 姿态**：admin token 未配置 = 全部 API 拒绝；租户注册 token 未配 = 自助注册关闭；locator/审计密钥缺失按环境决定抛错或拒绝受保护读。
- **租户隔离**：数据按 `tenant_id` 列过滤 + 检查 key 命名空间 `t.<tenantId>.<key>`；两个探针凭证域（平台 token 文件 vs 库内哈希）互不通用；租户视图只读。
- **隐私边界**：OTLP 只保留低敏感 AI 语义字段，不接收 prompt/completion/工具参数。

## 假设与不确定项（低置信，待验证）

- `@deepseek-ai/dsh-host-apiproxy`、`@deepseek-ai/dsh-session` 两个依赖的具体角色（推测用于合成探针与会话，置信度 medium，见证据表）。
- `server/supabase-*.ts`、`server/analytics-cloud-forward.ts` 疑为上游云转发残留，当前部署是否启用未验证。
- 生产 PostgreSQL 的具体部署形态（裸进程 vs 容器；`RDK_ALERT_POSTGRES_CONTAINER` 指向容器化检查，但本仓库内无 compose/单元文件证据）。
- nginx 配置本体在生产主机上，仓库内只有行为性证据（README、`trusted-proxy.ts` 注释、`ops/prometheus/prometheus.yml` 抓取 18093）。
