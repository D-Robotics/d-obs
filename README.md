# d-obs — RDK 可观测平台（独立部署）

从 RDK Studio 单仓按 **D-010（可观测域独立边界）** 抽取的可观测平台独立项目。
服务器侧能力（巡检、告警、Trace、运营指标、模型池控制面、数据库只读资产）直接复用
Studio 生产代码，不再与 Studio 前端 / composition root 耦合。

**上游**：RDK Studio（`develop`），抽取源提交 `c87e605d4`。
同步策略：上游 `server/monitoring`、`server/observability`、`shared` contract 变更后
按闭包重放抽取，本仓不长期分叉业务逻辑。

## 组成

| 目录 | 内容 |
| --- | --- |
| `server/monitoring/` | 可观测工作台（`/ops-observability` HTML + 全部页面脚本）、告警 worker/投递、自愈、行动环、模型池路由 |
| `server/observability/` | run locator、trace 存储、治理审计（governance） |
| `server/flywheel/` | 运营指标 / 增长聚合 store（运营指标视图依赖） |
| `server/agent-observability/` | 会话 Trace 页面 |
| `server/credits/`、`server/evolution/`、`server/public-api/` | 模型池网关 admin client、进化候选、公共可观测 store |
| `shared/` | 版本化 contract（studio-observability、telemetry 治理、trace 等） |
| `server/main.ts` | **独立入口**：无 Studio composition，直接挂载 ops 路由 |

## 运行

```bash
npm install
npm start          # http://127.0.0.1:47110/ops-observability
```

### 鉴权与配置（与 Studio 运行时同语义）

- `RDK_CREDITS_ADMIN_TOKEN`：运营 token（`X-RDK-Ops-Token`）。未配置时 token 通道
  fail-closed。
- `RDK_FLYWHEEL_ADMIN_USER_IDS`：允许的运营 SSO 用户 ID 逗号表（与 Studio 共用身份时）。
- 数据面沿用 Supabase/Postgres 连接环境变量（与 Studio 相同变量名）。

### 依赖边界（D-010 约束的继续生效）

- 所有跨域访问经 `shared` versioned contract 或 route facade；不引入 Studio 私有
  composition root 依赖。
- 鉴权不复制：继续复用 Studio 的 account/owner policy adapter 语义。
- 上游 ADR：`docs/decisions/D-010-observability-domain-boundary.md`（随抽取一并收录）。
