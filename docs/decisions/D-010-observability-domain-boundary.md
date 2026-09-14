# D-010 · 可观测域独立边界（先独立域，后决定是否拆仓）

- **Status**: 生效
- **Date**: 2026-09-07
- **范围**: `server/monitoring`、`server/observability`、`server/routes/public-api-observability-routes.ts`、可观测 Ops UI、相关 `shared` contracts 与 `ops` 部署资产
- **Owner**: RDK Studio architecture maintainers

## 背景

可观测能力已经同时包含采集、run/trace 持久化、告警与治理、公共 API、Ops UI、OTel/gateway
部署资产，具备独立产品域的规模。但当前它仍与 Studio 的 HTTP composition root、账号/SSO
治理、workspace owner 映射和运行时资源共享。此时直接拆成新仓库会制造双份鉴权、租户和回滚
逻辑，风险高于收益。

## 决策

1. **现在独立域，不立即独立仓库**：可观测性在单仓内保持模块化，但视为可替换的子系统；
   不再把新的采集、查询、告警或 Ops 交互逻辑塞入 Studio 通用组合根。
2. **稳定边界**：跨域调用只能经 `shared` 中版本化 contract、`server/observability` ports
   或明确的 public/ops route facade；UI 不得直接依赖 store/schema 私有实现。
3. **运行时隔离优先**：采集/投影/告警 worker 与 Studio 请求线程逐步支持独立进程和独立
   扩缩容；在完成前，必须保留同进程降级路径和统一 correlation/run locator 语义。
4. **鉴权与租户不复制**：继续复用 Studio 的 account/owner policy，通过 adapter 注入；
   独立部署候选必须先证明 token、SSO、owner 映射和 fail-closed 行为等价。
5. **拆仓库门槛**：只有同时满足以下条件，才创建独立仓库并迁移生产流量：
   - public observability API 已完成挂载、scope、OpenAPI 和兼容性测试；
   - Ops UI、collector/gateway、worker 可在无 Studio 进程时独立部署与回滚；
   - 数据 schema、保留策略、迁移和 replay/rollback 由可观测域单独负责；
   - 依赖图中不再存在对 Studio composition root 私有 middleware 或内部 store 的硬依赖；
   - 至少一个版本周期的双跑/影子流量证明指标、告警和审计事件一致。

## 分阶段执行

- **Phase 1（当前）**：冻结 contract/ports，补齐 route facade 与依赖清单；新增功能只落在域目录。
- **Phase 2**：把 collector、投影、告警调度抽成可独立启动的 worker，增加健康检查、幂等和回放门禁。
- **Phase 3**：建立独立部署拓扑和影子流量；验证鉴权、租户隔离、SLO、成本与回滚。
- **Phase 4**：评审上述拆仓库门槛，达标后再迁移仓库与生产 ownership。

## 被否决方案

- 立即复制代码到新仓库：会复制鉴权、租户、schema 和回滚责任。
- 只按目录移动文件：无法消除对 Studio composition root 和共享状态的隐式耦合。

## 适用与重审条件

本决策适用于可观测域的代码、契约、运行时装配和部署资产。 当可观测域拥有独立客户/发布节奏，或 Studio 的可用性与其 SLO 明显冲突时，提前重审拆仓库；
若上述门槛连续两个版本未推进，需由架构 owner 复盘 Phase 1 的阻塞项。

## 验证

每阶段至少运行相关 observability route/contract/tenancy 测试，并执行 `npm run verify -- --fast`；
涉及 runtime 装配时追加 `npm run verify:agent:harness`。拆仓库评审必须附依赖图、双跑对账和回滚演练证据。

## 权威源

`server/monitoring/observability-routes.ts`、`server/monitoring/observability-access.ts`、
`server/bootstrap/register-public-http-surfaces.ts`、`server/observability/run-locator.ts`、
`shared/studio-observability.ts`、`docs/design/public-observability-api-v1.md`、D-006。
