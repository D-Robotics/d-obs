# RDK 日志调查：面向网页和 Agent 的原子能力

入口：**边缘设备 → RDK 日志调查**，深链 `/ops-observability#devices/logs`。
生产入口保留 `/dobs` 前缀。设备接入沿用 [SSH 采集配置](ssh-log-collection.md)。

## 一次调查

1. 输入问题，例如“X5 相机启动后 ISP 超时”。
2. 检测设备，确认实际型号、系统、内核和日志读取权限。
3. 生成 `x5-isp@1.0.0` 或 `runtime@1.0.0` 计划，查看推荐来源和缺失证据。
4. 开始最多三源的采集组，复现时添加标记；停止会保存各源尾部输出。
5. 用模型分析，点击引用回到原文；也可选择明确标识的“证据整理”模式。
6. 下载 JSON 问题包，包含版本快照、模板、标记、各源状态、原始记录及脱敏证据。

`x5-isp` 优先实际可读的媒体 logcat、内核和应用来源；`runtime` 优先系统、
内核和应用来源。`logcat` 和 `dmesg` 是固定内置读取命令，需要实机探测；
不会假设所有 RDK 镜像都有相同工具，也不会假设 ISP 应用的服务名或文件路径。
实时 logcat/dmesg 从设备现有缓冲区开始，历史行数选项不限制这两个实时来源。
读取、探测和分析不会更改设备日志等级或执行修复动作。

## AI 原生接口

REST 契约 `rdk.log-investigation.v1`，前缀 `/api/ops/observability/rdk-logs`：

| 请求 | 行为 |
| --- | --- |
| GET `/capabilities`、`/profiles`、`/targets` | 模型启用状态、版本模板、设备清单 |
| POST `/targets/:id/probe` | 真实 SSH 只读检测 |
| POST `/plan` | `{targetId, question, profileId?, sourceIds?}` 生成计划 |
| POST `/captures` | 计划字段加 `lines?`、`durationSeconds?` 开始采集 |
| GET `/captures`、`/captures/:id` | 当前身份的采集组及增量原文 |
| POST `/captures/:id/markers` | `{label}` 记录复现位置 |
| POST `/captures/:id/stop` | 停止所有来源 |
| GET `/captures/:id/evidence` | 后端构建的有界、脱敏证据 |
| POST `/captures/:id/analysis` | `{question?, mode:"model"或"evidence"}` 分析 |
| GET `/captures/:id/bundle` | 下载包含原文的 JSON 问题包 |

增量读取使用 `?cursors=<URL编码的JSON>`，其中每个键是本组 sessionId，值是
上一轮返回的 cursor。返回 `streams[{session,records,cursor,hasMore}]`；原文
`record.text` 保留换行和长记录。`receivedAt` 是平台接收时间，不是设备事件时间；
多源输出不保证严格时钟同步。

MCP endpoint：`/api/ops/rdk-logs/mcp`，使用 JSON-RPC 2.0。工具包括
`rdk_logs_list_targets`、`rdk_logs_probe`、`rdk_logs_plan`、
`rdk_logs_start_capture`、`rdk_logs_list_captures`、`rdk_logs_read_capture`、
`rdk_logs_mark`、`rdk_logs_stop_capture`、`rdk_logs_evidence`、
`rdk_logs_analyze`、`rdk_logs_bundle`。
Agent 可按 **探测 → 计划 → 采集 → 取证 → 分析 → 补采或导出** 编排。
网页和 MCP 使用同一业务服务、来源白名单、资源限制及账号隔离。
工具不会提供任意 shell 执行或自动处置能力。

沿用运营管理员 SSO 或 `x-admin-token`；所有 POST（包括 MCP）还需
`x-rdk-ops-action: observability`。浏览器同源校验沿用平台规则。
生产反代下 REST 和 MCP endpoint 都加 `/dobs` 前缀。

## 模型与证据

模型使用现有服务器模型网关。`RDK_LOG_AI_ENABLED=1` 启用；未显式设置时沿用
`RDK_COPILOT_MODEL_ENABLED`。配置专用服务凭据 `RDK_LOG_AI_GATEWAY_KEY` 和网关模型别名
`RDK_LOG_AI_MODEL`；`RDK_LOG_AI_GATEWAY_URL` 默认使用既有网关地址的 `/v1` 路径。
请求经过模型网关的鉴权、限额与路由；不会用管理接口返回的脱敏上游密钥直连模型。
远程网关必须使用 HTTPS，本机环回地址可用 HTTP。凭据只保存在服务器环境配置。
专用服务身份的网关限额由全平台日志分析共享；日志读取权限仍按当前 SSO 账号隔离。
浏览器不提交任意证据让后端背书：后端只读取当前账号保存的日志，重组分片，
生成最多 120 条摘录，再做凭据/私钥脱敏。模型收到的是有界摘录与版本上下文，
原文保留在平台后端，不整包送模型。一次扫描最多 32 MiB 或 100,000 行。

模型返回的假设必须引用真实 `rlog:<sessionId>:<seqFrom>-<seqTo>`。
服务端剔除不属于本次证据的引用；没有有效引用、模型错误或未配置都显式报错。
输出包含分析 ID、模型名、生成时间和证据摘要哈希。证据整理模式 `source=evidence`
与真实模型模式 `source=model` 分开显示，规则命中仅作为错误候选。
日志是非可信输入，模型不得遵循日志里的指令，也不会执行建议动作。

## 保存和部署

采集组元数据位于 `RDK_SSH_LOG_STATE_DIR/rdk-captures`，默认与 SSH 原文目录
同根。元数据默认最多 16 MiB、200 组、100 次探测，结束后保留 24 小时；
探测计划仅复用同账号最近 60 秒的检测。原文的 10 MiB/次、50 MiB总预算、
4路并发和30分钟时长限制沿用 SSH 采集器。失败来源会回收组内其他连接，
平台关服会统一结束采集。没有目标配置时显示真实接入空态。

生产建议设置 `RDK_SSH_LOG_STATE_DIR=/var/lib/d-obs/ssh-logs` 并使用持久磁盘。
平台服务器必须能 SSH 到板子；云端平台无法凭浏览器的局域网连接直接访问 X5。
版本发布和模型联通验证可以先完成，真机日志验收需要实际可达的目标配置。
