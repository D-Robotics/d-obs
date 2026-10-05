# D-011 · 信号工程收敛开源，业务可观测自建（分层技术边界）

- **Status**: 生效
- **Date**: 2026-10-05
- **范围**: 采集、存储、查询、展示、告警五层与业务运营层的技术选型边界
- **Owner**: d-obs maintainers

## 背景

平台定位「边缘 + 云 + AI 原生综合可观测」。评估问题：对标现成开源方案
（Prometheus/Grafana LGTM 栈、SigNoz/Uptrace/OpenObserve 一体化栈、Alertmanager/Keep
告警域），哪些层继续自建、哪些层收敛到开源，避免在成熟开源层重复造轮子，也避免把
差异化层误交给通用方案。

## 证据（2026-10-05 生产实测，中心库 `pg_stat_user_tables`）

- `studio_observability_logs` = 22,360 行：日志域 7 类源真实在流；
- `studio_observability_metric_series` = 1、`metric_samples` = 1：指标域近乎自检残留；
- `studio_trace_spans` = 1,372（存量）：应用侧自 2026-09-10 起断供，转发链被
  collector 配置生成器阻塞（跨团队）；
- `studio_devices` = 1 且 `studio_device_samples` = 0：设备面未真实接入。

结论：信号工程层当前的价值瓶颈在接入方而非功能；平台的不可替代价值集中在业务
可观测与治理层。

## 决策

1. **采集与查询语言**：遵守 OTLP 与 PromQL 事实标准，不自建采集协议与查询语言。
   （既有实现一致：OTLP 三口、Prometheus exposition 兼容、PromQL 代理查询。）
2. **指标长期历史归 Prometheus**：remote-write 接收口为二期项；平台内 PG 只承担
   14 天热数据。规模后的既定平替路线为 VictoriaMetrics（PromQL 兼容，平滑迁移）。
3. **深度展示归 Grafana**：Grafana 已旁路接入（子路径、预配数据源）；平台内自研
   SVG 只承担工作台内嵌轻图表，不向全功能可视化方向投入。
4. **日志与 Trace 存储留 PG**：按保留期分区清理。引入 Loki/ClickHouse 的触发条件沿用
   架构评审第四轮门槛（日增 2,000 万样本或查询 P95 > 3s）；在此之前不预建存储抽象层。
5. **业务可观测与治理层自建，不外采**：token 成本按人归因、账号行为视角（session
   桥接归账）、Skill 数据闭环聚合、多租户告警基座、SSO/审计盖章/结案治理（升级链、
   维护窗口、分级路由、隔日回收）、RDK 设备命令面。开源栈无对应物，这是平台的存在
   理由。
6. **告警评估引擎自建、数据源向 PromQL 收敛**：策略引擎已按 PromQL 即时查询逐序列
   判定；内置规则的评估面继续向同一数据面收敛，不另起引擎。

## 被否决方案

- **整体替换为 SigNoz/OpenObserve 一体化栈**：失去决策第 5 条全部差异层；租户、SSO、
  审计、设备域仍需自建；组件数与运维面上升，与内部小团队运维成本目标相悖。
- **LGTM 全家桶自建替代**：同上，且丧失中文工作台与单进程（9 个运行时依赖）部署形态。
- **指标继续留在 PG、不接 Prometheus**：与二期定案冲突；长期历史能力与告警评估语义
  两面受损。

## 重审条件

- rdstudio 应用 OTLP 转发接入后：重审第 2 条的执行顺序与指标域形态；
- 出现真实外部生产租户，或日增样本达到第四轮门槛：重审第 4 条存储路线；
- Grafana 侧业务面板承接成熟（内部使用率过半）：重审第 3 条自研图表的存留范围。

## 权威源

`docs/architecture/architecture-review.md`（第四轮剩余差距决策记录）、`docs/open-source.md`
（协议兼容与适配层边界）、本文件证据节。
