# d-obs — RDK 可观测平台

面向 D-Robotics 生产环境的独立可观测平台：运营工作台、巡检告警、链路追踪、
运营指标、数据库只读资产与模型池控制面，一个独立部署、独立演进的进程。

## 组成

| 目录 | 内容 |
| --- | --- |
| `server/monitoring/` | 可观测工作台（`/ops-observability`）、告警评估与投递、自愈剧本、证据化行动环、模型池路由与探测 |
| `server/observability/` | run locator、trace 存储、治理审计（governance） |
| `server/flywheel/` | 运营指标 / 增长聚合 store |
| `server/agent-observability/` | 会话 Trace 页面 |
| `server/credits/` | 模型池网关 admin client 与凭据管理 |
| `server/evolution/`、`server/public-api/` | 进化候选治理、公共可观测 store |
| `shared/` | 版本化 contract（observability、telemetry 治理、trace 等） |
| `server/main.ts` | 独立入口：直接挂载全部 ops 路由 |

## 运行

```bash
npm install
npm start          # http://127.0.0.1:47110/ops-observability
```

### 鉴权与配置

- `RDK_CREDITS_ADMIN_TOKEN`：运营 token（`X-RDK-Ops-Token`）。未配置时 token 通道 fail-closed。
- `RDK_FLYWHEEL_ADMIN_USER_IDS`：允许的运营用户 ID 逗号表（与主站共用身份时）。
- 数据面沿用 Supabase/Postgres 连接环境变量。

### 边界约束

- 所有跨域访问经 `shared` versioned contract 或 route facade。
- 鉴权不复制：复用既有 account/owner policy adapter 语义（详见
  `docs/decisions/D-010-observability-domain-boundary.md`）。

## 致谢

初始代码源自 D-Robotics 内部机器人工作台单仓（develop @ c87e605d4）的可观测域，
按其架构决策 D-010 的边界抽取成独立项目；服务器侧能力与主仓保持同源同步。
