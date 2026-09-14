# d-obs — RDK 可观测平台

面向 D-Robotics 生产环境的独立可观测平台：**一个进程**提供运营工作台（Web UI）、
告警评估与投递、链路追踪、运营指标、数据库只读资产与模型池控制面，可独立部署、
独立扩缩容、独立演进。与业务站点的耦合只通过 HTTP 端点、版本化 contract 和共享数据库，
不依赖任何业务站点的 composition root。

## 能力总览

| 能力 | 入口 | 说明 |
| --- | --- | --- |
| **运营工作台** | `GET /ops-observability` | 单页工作台（服务端渲染 HTML，无前端构建）。当前态势、SLO 错误预算、事故调查、告警策略管理、通知模板、链路追踪、运营指标、数据健康、数据库目录、Skill 数据闭环、每日自我进化、系统设置、**模型池** |
| **巡检与告警** | worker 进程 | 指标/日志/拨测三类规则，每 60 秒评估，Pending→告警→恢复状态机；飞书/通用 Webhook 投递（含重试、降噪、恢复通知、影子模式） |
| **事故管理** | 工作台“事故调查” | 事故工作台、负责人、活动记录、AI 事故副驾（证据化根因假设） |
| **证据化行动环** | `/api/ops/observability/actions` | 所有变更类操作走“提案→带证据 proof→他人审批→白名单剧本执行→后置验证”闭环；不提供裸执行 |
| **自愈** | worker | 白名单剧本（nginx reload 前置校验、重启 alert-worker 等），冷却期 + 双人审批 |
| **链路追踪** | 工作台“链路追踪” | Agent 原生 Trace（Langfuse 公开看板嵌入）+ 会话 Trace（`/session-trace`，按 sessionId 重放 run/模型/工具/审批） |
| **运营指标** | 工作台“运营指标” | 按天 token 消耗、新增用户、DAU、对话次数、Agent Run |
| **数据库资产** | 工作台“数据库” | PostgreSQL 运行状态、表目录/关系图、分页预览、整表 CSV 导出、**AI 自然语言→只读脱敏 SQL**（仅 `ops_ai` 视图） |
| **模型池控制面** | 工作台“模型池” | 3100/3101 网关目标健康（成功率/P95/并发/冷却）、单目标真实探测、路由优先级（fallback 顺序+权重）、目标替换（Agent 主路由受保护） |
| **外部拨测接入** | `POST /api/ops/observability/external-probe` | 异地探针把 TLS/入口/健康数据回传，计入告警评估 |
| **公共可观测 API** | `/api/ops/observability/*` | 全部能力均有 JSON API；访问受运营鉴权保护 |

## 快速开始

```bash
npm install
npm start
# → [d-obs] observability workbench listening on http://1270.0.0.1:47110/ops-observability
```

打开 `http://127.0.0.1:47110/ops-observability`，默认进“当前态势”。
导航：左侧分组（处置与证据 / 数据与资产 / 学习与进化 / 系统配置），模型池在
“系统配置”分组；⌘K / `/` 唤起命令面板；移动端用底部 tab。

### 接入步骤（新环境，已实测）

以下步骤已在真实环境完整验证过（以强化学习平台 sim2real-web 为被观测目标）。

1. **数据面**：建库并初始化 schema：

   ```bash
   createdb d_obs
   psql -h localhost -d d_obs -f tools/init-schema.sql   # 幂等，可重复执行
   export RDK_CHAT_CREDITS_DB_URL='postgres://user@localhost:5432/d_obs'
   ```

   告警状态、事故、审计、外部拨测、run/trace 投影都会自动入库（worker 首轮也会
   自动补齐全部表）。

2. **运营鉴权**（必配，否则所有 API fail-closed）：

   ```bash
   export RDK_CREDITS_ADMIN_TOKEN='<随机长 token>'
   ```

   浏览器 API 调用会带 `x-admin-token`（timing-safe 比对）。不配置该变量时
   token 通道直接关闭（不允许匿名 admin）。

3. **外部探针接入**（把第三方服务的健康状态接进来，以强化学习平台为例）：

   ```bash
   # 生成探针 token（64 hex），并让 d-obs 指向它
   openssl rand -hex 32 > /path/to/external-probe-token
   export RDK_EXTERNAL_PROBE_TOKEN_PATH=/path/to/external-probe-token

   # 上报（RL 平台探针，检查 /healthz 和入口页）
   RDK_RL_PROBE_TARGET=http://127.0.0.1:18102 \
   RDK_RL_PROBE_REPORT_URL=http://127.0.0.1:47110 \
   RDK_RL_PROBE_TOKEN_FILE=/path/to/external-probe-token \
   node tools/rl-platform-probe.mjs
   # → [rl-probe] healthz=ok entry=ok report=202

   # 然后在工作台“告警策略→告警对象”里就能看到 external-health /
   # external-entry-asset 的状态与趋势（active 检查项自动生成事故记录）
   ```

   持续观测：把探针脚本挂到 systemd timer 或 cron（每次一条上报，状态在 d-obs 侧
   持久化并进入告警评估）。改观测目标只需覆盖 `RDK_RL_PROBE_TARGET`。

4. **告警投递**（可选，不配则只评估入库不外发）：在工作台“告警策略→通知模板”里
   配置飞书 Webhook 或通用 Webhook；或用 shadow 模式先影子验证。

5. **告警 worker**（独立进程，持续评估）：

   ```bash
   npm run worker                # 前台持续运行（每 60s 评估一轮）
   npm run worker:check-config   # 只校验配置
   ```

   独立部署时用 `RDK_ALERT_CONFIG_PATH` 指定配置文件（默认 production 路径
   `/var/lib/rdstudio-alert-worker/config.json`，本地开发 `~/.rdk-studio/alert-config.json`）。

6. **模型池（可选）**：如果模型网关（D-Robotics 模型路由网关）与 d-obs 同机或可达：

   ```bash
   export RDK_GATEWAY_ADMIN_URL='http://127.0.0.1:3100'
   export GATEWAY_ADMIN_KEY='<网关 admin key>'
   ```

   之后工作台“模型池”里的探测/路由/替换才可用；不配则模型池面板只读降级。### 配置参考

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `RDK_CHAT_CREDITS_DB_URL` | ✅ | 中心 PostgreSQL 连接串（数据面真源） |
| `RDK_CREDITS_ADMIN_TOKEN` | ✅ | 运营 token（`x-admin-token` 头） |
| `PORT` |  | HTTP 端口，默认 `47110` |
| `RDK_DATA_DIR` |  | 本地状态/配置目录（默认数据布局） |
| `RDK_GATEWAY_ADMIN_URL` / `GATEWAY_ADMIN_KEY` |  | 模型池网关 admin API 地址与密钥（默认 `127.0.0.1:3100`） |
| `RDK_ALERT_INTERNAL_HEALTH_URL` |  | internal-health 检查目标 |
| `STUDIO_LANGFUSE_PUBLIC_DASHBOARD_URL` |  | Langfuse 公开看板 URL，配置后 Agent Trace 面板嵌入它 |
| `RDK_OBSERVABILITY_ENVIRONMENT` |  | 环境标注（production/dev），写入事件投影 |
| `RDK_EXTERNAL_PROBE_TOKEN_PATH` |  | 外部探针 token 文件路径（默认 `/var/lib/rdstudio-alert-worker/external-probe-token`） |
| `RDK_FLYWHEEL_ADMIN_USER_IDS` |  | SSO admin 用户 ID 逗号表（与业务站共用身份时用） |

### 鉴权语义（与上游同源，独立部署可用）

- 请求带 `x-admin-token` 且与 `RDK_CREDITS_ADMIN_TOKEN` 常量时间相等 → 通过。
- token 缺失或错误：多用户部署一律拒绝；单用户本地部署允许匿名本地运营
  （`deploymentAllowsAnonymousLocalOperator`）。
- 变更类端点额外要求 `x-rdk-ops-action: observability` 头（误用浏览器直发会被 400 拦截）。
- 浏览器工作台 401/403 时会展示“需要运营账号登录”引导。

### 运维命令

```bash
npm run typecheck            # tsc --noEmit 全闭包类型检查
npm start                    # 工作台 + 全部 JSON API（含模型池探测/路由/替换）
npm run worker               # 告警评估循环（另开一个进程）
npm run worker:check-config  # 校验告警配置
```

进程模型：`npm start`（Web 服务）+ `npm run worker`（评估循环）双进程，共享同一
数据库。行动环/自愈的执行由 worker 按白名单剧本派生，不阻塞 Web 进程。

## 目录结构

| 目录 | 内容 |
| --- | --- |
| `server/monitoring/` | 工作台页面与页面脚本、路由、告警、投递、自愈、行动环、模型池 |
| `server/observability/` | run locator、trace list store、治理审计 |
| `server/agent-observability/` | 会话 Trace 页面 |
| `server/flywheel/` | 运营指标 / 增长聚合 store |
| `server/credits/` | 模型池网关 admin client 与凭据管理 |
| `server/evolution/` | 每日自我进化（候选治理） |
| `server/public-api/` | 公共可观测 store |
| `shared/` | 版本化 contract |
| `server/main.ts` | 独立入口 |

更多运维细节（API 清单、告警规则语义、行动环流程、故障排查）见
[docs/operations.md](docs/operations.md)。

## 边界约束（D-010）

- 跨域访问只经 `shared` versioned contract 或 route facade；不引入业务站点
  composition root 依赖。
- 鉴权不复制：复用 account/owner policy adapter 语义，token 与 SSO 双通道。
- 详见 `docs/decisions/D-010-observability-domain-boundary.md`。

## 致谢

初始代码源自 D-Robotics 内部机器人工作台单仓（develop @ c87e605d4）的可观测域，
按其架构决策 D-010 的边界抽取成独立项目；服务器侧能力与主仓保持同源同步。
