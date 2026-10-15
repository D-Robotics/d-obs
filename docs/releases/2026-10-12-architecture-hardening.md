# 2026-10-12 架构整改上线验收

已发布版本 `architecture-hardening-20261012-6f20758749`。Web `/opt/d-obs/current` 与 worker
`/opt/rdk-observability/current` 均指向 `/opt/d-obs/releases/architecture-hardening-20261012-6f20758749`。
生产运行时为 Node v22.19.0。

入口：https://rdkstudio.d-robotics.cc/dobs/ops-observability

## 本次整改

- 公共 Run、对象资料和幂等键使用 PostgreSQL 权威索引，Trace/质量/索引在同一事务内提交；数据库失败明确返回失败，确认数量与实际落库数量一致。
- 配置数据库时读取使用请求本地视图和 Run 主键查询；索引保留 35 天、按批次物理清理；删除墓碑、账号归属和事务屏障覆盖多 Trace/Session 片段。
- Metrics HTTP/gRPC 在数据库提交后确认，纳秒时间戳使用 BigInt 转换，避免相邻毫秒样本碰撞；连接、语句和锁等待有界。
- OTLP 按 Run 与 scopeRef 合并完整 Trace 片段，每批最多 64 spans，保留采样和配额边界。
- Worker 用专用 PostgreSQL 会话持有租约，连接丢失即停止本周期；定时器切换前等待原周期自然结束。
- 平台能力使用显式注册目录；Trace/Session 页共享 TypeScript 生命周期，切换范围和登出会取消请求并丢弃迟到结果。
- 助手变更先展示参数提案；确认令牌加密并绑定身份、租户视图和原始参数，5 分钟有效；数据库唯一 nonce 在执行前消费，重复确认不会重复产生副作用。

## 验收证据

| 验收 | 实际结果 |
| --- | --- |
| 冻结源码类型检查及编译 | 通过 |
| 全量源码测试 | 757 项，743 通过、14 个数据库用例跳过、0 失败 |
| 专用真实 PostgreSQL 集成 | 23/23 通过，无跳过；覆盖重启、并发、回滚、删除屏障、初次建表与租约丢失 |
| 最终线上基线的助手确认/UI/路由回归 | 32/32 通过；默认禁止模型自行授权的 2 项核心回归通过 |
| 数据持久化实际 JS 候选回归 | 非 PG 28/28，真实 PG 12/12 |
| 页面生命周期/能力实际 JS 回归 | 83 通过；3 个其他会话尚未上线的正文绑定专属用例跳过 |
| 隔离 PG Trace 容量 | 1,000 请求、并发 16、8,000 条确认及实际落库，0 拒绝，P95 16 ms |
| 隔离 PG Metrics 容量 | 1,000 请求、并发 16、8,000 条确认及实际落库，0 拒绝，P95 19 ms |
| 服务器候选 | 真实 Node；权限、MCP、确认负向检查及 11 个自然问法全部通过 |
| 生产源站 | healthz/readyz 200；页面脚本、权限、MCP 读取和真实 copilot/status 助手读取通过 |
| 生产公网 | 页面 200；同一组权限/MCP 检查及 11 个自然问法全部通过 |
| 生产数据库 | 10 张必要表/列与 SELECT 权限、v2 marker、读索引、nonce 主键及提案加密绑定检查通过 |
| 新版本 worker | 定时器 active；上线后 17:35、17:36、17:39 自然周期完成，ExecMainStatus=0；原状态文件保留 |
| 产物完整性 | 26 个发布文件逐项 SHA256 一致，旧 baseline 哈希保持不变 |

容量验收使用本机隔离 PostgreSQL 16.14 和最终待发布 JS。测试进程配额为
100,000/min，生产限流配置保持原值；这些结果不代表生产主机或跨主机故障场景容量。
自然问法覆盖模型池两次原问法、带历史的 fallback 追问、告警、SLO、运营指标、
租户、日志入口、copilot 状态、总览和质量，要求本轮真实只读回执及业务正文。
确认流程的实际写入和 12 并发只产生一次副作用在隔离 PG 测试。

## 发布与恢复材料

[26 文件 manifest](2026-10-12-architecture-hardening-manifest.json)。
归档 SHA256：`cab2ec4bf6aa29fc9ff5607ca45de6ab3f8fff5104a1eba6b764070bae8f844a`。
源码 HEAD 来源：`c3ef3ce9940e19cfa57b678b6ccfb3ab1941a746`；发布是线上基线加本任务 overlay。
本任务 45 个源码/测试/CI/文档改动已回写；其他会话后续的源码修改保留，未自动提交。

回滚点 Web：`/opt/d-obs/releases/assistant-query-fix-20261012-38db0c798e`。
回滚点 worker：`/opt/d-obs/releases/opsui-components-20261011-20261011-233355`。
恢复时先确认两个 current 仍归本次发布所有，暂停 timer 并排空 worker，再原子恢复
各自指针、重启 Web、验收健康，最后恢复原 timer 状态。旧版本、manifest 和本任务持久证据保留。

本任务持久证据目录：`/Users/d-robotics/.codex/visualizations/2026/10/12/01a12f13-9129-7730-a7ba-356846e5ab77/architecture-release`。
包含冻结源码、基线哈希、归档、候选/源站/公网验收、容量数据及单次发布脚本。
已把中断恢复、并发版本复检和 oneshot 排空流程补入 `.codex/skills/d-obs-release/SKILL.md`，技能校验通过。

跨主机 HA 按用户选择后续安排；第二台生产主机、PG 热备与跨主机故障切换尚未验收。
本轮完成当前环境的代码整改和上线，不将单机架构称为已实现跨主机高可用。
