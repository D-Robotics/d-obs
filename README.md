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
| **外部拨测接入** | `POST /api/health/external-probe-report` | 异地探针把 DNS/TLS/健康/入口数据回传，计入告警评估 |
| **租户组员与账号登录** | 工作台登录屏 / 租户管理面板 | 主站账号密码登录（SSO 中继），组员按租户获得隔离只读视图，owner 管理组员与角色（[docs/tenant-members.md](./docs/tenant-members.md)） |
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

## 已验证的告警状态机（端到端实测）

以下闭环在真实环境驱动过一轮（RL 平台探针 + worker 双进程 + shadow 通知）：

- **worker 内部规则**：连续 2 轮失败（`openAfter=2`）→ incident `open` + 通知落库
  （影子模式 `delivered=false, channel=unconfigured`）→ 连续 2 轮成功
  （`resolveAfter=2`）→ incident `resolved` + 恢复通知记录。
- **external 拨测规则**：探针上报 `active=true` 检查项 → ingest 即刻 `open`
  critical 事故；恢复上报后事故 `resolved`。worker 不参与 external 状态机，
  探针侧自算 ok/active。
- **心跳降级**：external 检查项超过 3 分钟未上报 → 总览上该检查降级为
  critical（“异地拨测心跳超过 3 分钟未上报”）；worker 超 3 分钟未运行 →
  看板顶部 Telemetry 状态变“可能过期”。

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

   之后工作台“模型池”里的探测/路由/替换才可用；不配则模型池面板只读降级。

### 浏览器打开（独立部署）

**与业务站同源部署时（推荐）：已在业务站登录的账号直接打开工作台即可**——
主站会话 Cookie（`rdk_sso_session`，`Path=/; HttpOnly`）会随请求到达 d-obs，
服务端转发主站 `/api/sso/me` 验证后解析出身份，无需二次输入密码。账号登录
（`/api/ops/auth/login`）也会把主站下发的 `Set-Cookie` 透传回浏览器，使 d-obs
登录同时成为主站登录态。详见 [docs/tenant-members.md](./docs/tenant-members.md)。

免登不可用（跨源/桌面/未配中继）时，仍可用带 token 的入口地址打开工作台：

```text
http://<host>:<port>/ops-observability?ops-token=<RDK_CREDITS_ADMIN_TOKEN 的值>
```

token 会一次性写入 sessionStorage（随后从地址栏移除），后续 API 请求自动带上
`x-admin-token`。注意：行动环（evidence-proof 行动队列）要求 SSO 账号身份且在
`RDK_FLYWHEEL_ADMIN_USER_IDS` 白名单内，admin-token 直连下该模块显示"当前账号没有
运营配置权限"，属预期降级——告警、事故、规则、模型池、数据库面板不受影响。


## 多团队租户（自助接入 + 数据隔离）

一支团队 = 一个租户：自带探针 token（库里只存 sha256 哈希，明文只在创建响应里
出现一次）、独立的 external 检查/事故/通知数据（`tenant_id` 列过滤，检查 key
命名空间化为 `t.<tenantId>.<checkKey>`）、只读的工作台视图。平台管理员
（admin token）看全部租户数据并管理租户生命周期。

### 接入流程（团队自助）

1. 平台管理员在部署环境配置注册 token（不配 = 自助注册关闭，fail-closed）：

   ```bash
   export RDK_TENANT_REGISTRATION_TOKEN='<任意强随机串>'
   ```

2. 团队自助注册租户（一次性拿到探针 token，请立即保存）：

   ```bash
   curl -X POST http://<d-obs-host>:<port>/api/ops/tenants/register \
     -H 'content-type: application/json' \
     -H 'x-registration-token: <注册 token>' \
     -d '{"tenantId":"team-alpha","displayName":"强化学习平台组"}'
   # → {"ok":true,"tenant":{...},"probeToken":"<64-hex>","probe":{...}}
   ```

3. 部署探针（以 `tools/rl-platform-probe.mjs` 为例，租户模式加
   `RDK_RL_PROBE_AS_TENANT=1`，token 文件里放探针 token）：

   ```bash
   RDK_RL_PROBE_TARGET=http://<被观测服务> \
   RDK_RL_PROBE_REPORT_URL=http://<d-obs-host>:<port> \
   RDK_RL_PROBE_TOKEN_FILE=/path/to/tenant-token \
   RDK_RL_PROBE_AS_TENANT=1 \
   node tools/rl-platform-probe.mjs
   ```

   请求头自动切换为 `x-rdk-tenant-probe-token`；探针上报走
   `/api/health/external-probe-report`，租户身份命中的检查项写入
   `t.<tenantId>.<key>` 命名空间，故障直接 open 事故、恢复即 resolved。

4. 团队用只读工作台（token 一次性注入 sessionStorage）：

   ```text
   http://<host>:<port>/ops-observability?tenant-token=<探针 token>
   ```

   租户视图收敛到总览：只显示本租户的检查/事故/通知；平台业务信号
   （events/runs/SLO/Trace/进化面板）不进入租户视图；变更类端点一律 403
   （`tenant_read_only`）。

### 平台管理员租户管理

```bash
# 列出租户（含最近上报时间）
curl http://<host>:<port>/api/ops/observability/tenants -H 'x-admin-token: <admin token>'

# 创建（也可走自助注册）、轮换探针 token、停用/启用
curl -X POST .../tenants -d '{"tenantId":"x","displayName":"y"}'
curl -X POST .../tenants/<tenantId>/token
curl -X POST .../tenants/<tenantId>/status -d '{"status":"disabled"}'
```

停用后该租户 token 立即失效（上报 401、工作台 401）；轮换后旧 token 失效、
新 token 立即可用。所有租户管理操作进入配置审计流。

### 隔离语义（已实测）

- 探针上报：平台探针（token 文件）与租户探针（库内哈希）两个凭证域互不
  通用；无效/停用 token 一律 401。
- 数据：`studio_alert_checks/incidents/notifications` 按 `tenant_id` 过滤；
  租户 A 故障不污染租户 B 视图；平台业务表（agent_run_records、
  studio_ops_events 等）不按租户查询，租户视图恒为空。
- 事故操作：租户视图只读；管理员对命名空间 key 的操作按
  `t.<tenantId>.` 前缀推导归属校验。

### 配置参考

| 变量 | 必填 | 作用 |
| --- | --- | --- |
| `RDK_CHAT_CREDITS_DB_URL` | ✅ | 中心 PostgreSQL 连接串（数据面真源） |
| `RDK_CREDITS_ADMIN_TOKEN` | ✅ | 运营 token（`x-admin-token` 头） |
| `RDK_TENANT_REGISTRATION_TOKEN` |  | 租户自助注册 token（`x-registration-token` 头；不配 = 注册端点关闭，fail-closed） |
| `RDK_SSO_RELAY_BASE_URL` |  | 主站 SSO 中继地址（生产 `http://127.0.0.1:18090`）。配了才有账号登录与**同源 Cookie 免登**；不配 = 登录端点 503 fail-closed，token 入口不受影响 |
| `RDK_SSO_RELAY_LOGIN_RATE_MAX` |  | 登录端点**按客户端地址**的限流上限（默认 20 次/15 分钟） |
| `RDK_SSO_RELAY_LOGIN_ACCOUNT_RATE_MAX` |  | 登录端点**按目标账号**的限流上限（默认 10 次/15 分钟），挡单账号爆破 |
| `RDK_TRUST_PROXY` |  | 反代信任范围。默认 `loopback`（只在直连对端是回环时采信 X-Forwarded-For，匹配同机 nginx）；`0`/`off` 关闭；也可填 CIDR 列表。影响登录限流按真实客户端 IP 计数 |
| `PORT` |  | HTTP 端口，默认 `47110` |
| `RDK_DATA_DIR` |  | 本地状态/配置目录（默认数据布局） |
| `RDK_GATEWAY_ADMIN_URL` / `GATEWAY_ADMIN_KEY` |  | 模型池网关 admin API 地址与密钥（默认 `127.0.0.1:3100`） |
| `RDK_ALERT_INTERNAL_HEALTH_URL` |  | internal-health 检查目标 |
| `STUDIO_LANGFUSE_PUBLIC_DASHBOARD_URL` |  | Langfuse 公开看板 URL，配置后 Agent Trace 面板嵌入它 |
| `RDK_OBSERVABILITY_ENVIRONMENT` |  | 环境标注（production/dev），写入事件投影 |
| `RDK_EXTERNAL_PROBE_TOKEN_PATH` |  | 平台外部探针 token 文件路径（默认 `/var/lib/rdstudio-alert-worker/external-probe-token`） |
| `RDK_FLYWHEEL_ADMIN_USER_IDS` |  | SSO admin 用户 ID 逗号表（与业务站共用身份时用）。**不配 = 任何 SSO 账号都不是管理员，行动环对所有人 403** |

### 鉴权语义（与上游同源，独立部署可用）

- 请求带 `x-admin-token` 且与 `RDK_CREDITS_ADMIN_TOKEN` 常量时间相等 → 通过。
- token 缺失或错误：多用户部署一律拒绝；单用户本地部署允许匿名本地运营
  （`deploymentAllowsAnonymousLocalOperator`）。
- 变更类端点额外要求 `x-rdk-ops-action: observability` 头（误用浏览器直发会被 400 拦截）。
- 浏览器工作台 401/403 时会展示“需要运营账号登录”引导；admin-token 直连模式下
  行动域的 403 只降级行动模块，不再遮蔽整个看板。

### 运维命令

```bash
npm run typecheck            # tsc --noEmit 全闭包类型检查
npm test                     # 核心回归测试（告警状态机、鉴权、租户、探针上报）
npm start                    # 工作台 + 全部 JSON API（含模型池探测/路由/替换）
npm run worker               # 告警评估循环（另开一个进程）
npm run worker:check-config  # 校验告警配置
```

测试用 Node 内置 test runner（`node --import tsx --test`），零额外测试框架
依赖；覆盖告警状态机（Pending→open→escalated/reminder→resolved、unknown
不误恢复）、运营鉴权 fail-closed 语义、租户 ID/token 规则、探针上报解析，
以及"数据库不可用时不崩溃"的回归。CI（`.github/workflows/ci.yml`）在每次
push/PR 时跑 typecheck + test + 无数据库冒烟启动。

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
