# 平台 AI 助手

工作台右下角的「AI 助手」可查询和操作平台功能；`/api/ops/mcp` 为外部 Agent 提供同一套能力。组合根通过 `registerPlatformOperations` 显式发布经过审核的业务目录，执行复用原 HTTP 路由的身份、租户隔离、参数校验、审计、审批和后置验证。

目录覆盖告警与维护窗口、事故、对象、SLO、运营指标、链路与会话、租户与组员、边缘设备与下行命令、SSH/RDK 日志调查、指标与日志、看板与面板库、数据库与导出、模型池与定价、接入凭据、数据闭环及证据化行动。实际操作和数量以当前身份调用 `/api/ops/observability/assistant/capabilities` 或 MCP 能力目录的结果为准。退役的直接自愈、直接进化入口不进入目录。

本轮新增的页面上下文、任务持久化、确认后接续、人工反馈参考和真实案例导出已在本地实现并进行回归验证，尚未部署生产，也未完成生产环境验收。任务状态、人工评价和独立处置验收分别记录，不能相互替代。

## 工作台使用

启用自然语言操作需要 `RDK_COPILOT_MODEL_ENABLED=1` 与可信服务端模型配置：`RDK_PLATFORM_ASSISTANT_BASE_URL`、`RDK_PLATFORM_ASSISTANT_MODEL`、`RDK_PLATFORM_ASSISTANT_API_KEY`。可以使用现有网关，例如 `http://127.0.0.1:3100/v1`、已配置的前端模型名和助手专用客户端凭据。凭据保存在服务器权限为 0600 的环境文件中。缺省字段可复用 canonical Studio 的公共网关/模型/API key 环境变量。助手通过网关 `/chat/completions` 调用模型，凭据来自服务端环境；网关 admin 配置接口中的脱敏 key 不能用于模型认证。

模型未启用或网关不可用时，页面如实显示状态；能力浏览和 MCP 仍可使用，具体数据操作是否可用由其原 API 判断。

助手模型调用使用独立的 4,096 token 输出预算与 35 秒单次时限，为推理后返回工具计划预留空间。其他副驾调用仍沿用默认预算。HTTP 200 的空正文不作为成功指令，也不会把内部推理文本当作可执行操作。

可以直接输入：

- 「查看最近一小时的错误日志，并说明主要异常。」
- 「列出在线设备，查看 X5 的最近采样。」
- 「为 checkout 请求量与错误率创建一个看板。」
- 「把告警对象 A 静默 30 分钟，原因是计划维护。」
- 「查询这次运行的链路详情。」
- 「导出这张数据库表的 CSV。」

助手会先查询实际数据、补充必要参数，再按用户明确请求调用 API。回执区展示每项操作的成功或失败状态及原 API 数据。文件通过当前身份下载；助手回执不包含附件原文。一次请求最多执行六个操作，禁止重复提交同参数变更；超时、中断或异常导致变更结果不确定时停止后续执行，并要求查询当前状态。

新版工作台将对话关联到服务端持久化任务，可在刷新或重新打开助手后从「最近任务」恢复。身份或租户切换会清除当前界面对话并丢弃旧请求的晚到回复；服务端任务仍保留在原身份作用域。旧客户端省略 `taskId` 时沿用 legacy 对话接口，其历史由客户端提供，不会因此创建可恢复任务。每轮模型历史最多十二条。模型输入中的工具结果会遮盖凭证字段及日志内的凭证；授权操作者仍可在回执中保存 API 返回的一次性 token。

查询和确认响应提供独立的安全历史摘要，保留真实对象标识与可用的签名证据，供下一轮接续操作。摘要不会发送凭据；过大的签名证据明确省略，不传入被剪断的签名。变更预览完整展示被确认参数，超过格式化长度时改用完整紧凑 JSON，超过授权容量则拒绝生成提案。缺少目标或必填参数时先澄清，不产生无法执行的确认卡。

大回执保留 `truncated` 与文本 `preview`，另提供有长度边界的 `structuredData` 摘要，使后置对象标识、数据源状态和证据字段仍可读取。采样列表包含真实数量、保留数量与截断标志，不能当作完整列表。小回执保持原 API 数据。

读取成功后，模型回答中的现有配置、否定句和未来建议不能当作本轮变更。疑似未验证的变更结论最多做一次独立的只读回答纠正；纠正阶段不能调用 API，失败时展示脱敏的真实查询数据，保留原操作回执。模型池的兜底答复用中文列出健康数量、目标状态、前端路由与 fallback，不依赖模型再次生成。回答校验或模型失败不会作为可信助手历史传给下一轮。较大的模型池回执先保留健康概况、目标状态、主路由和 fallback 配置再压缩，重复压缩仍保留原始数量，并说明摘要缺失。较大的总览按结构保留 SLO、错误预算与证据字段。SLO 问题在成功读取总览后，补充依据实际目标、样本、SLI 和错误预算生成的确定性摘要；缺失或不足的样本明确说明，预算为负时保留真实负值，不增加查询次数。

## 页面上下文与任务接续

工作台发送严格限定字段的 `context`：当前视图、环境、时间窗、筛选条件，以及已选事故、运行、设备、看板、数据集或采集任务的标识。字段有类型和长度限制，不接收页面 HTML、日志正文或会话正文；未知字段被拒绝。上下文只帮助解析「这个」「这次」「这台」的指代，不能充当诊断证据或操作授权。助手仍需查询实际数据；`runRef` 不能冒充原始 `runId`。显式工具参数优先，页面范围不会扩大当前身份权限，请求侧租户范围也不会由 `context.tenant` 授予。

新版工作台向 `POST /api/ops/observability/assistant/chat` 显式发送 `taskId: null` 创建任务，后续使用返回的任务 ID 续问；新任务按钮从另一个任务开始。服务端将任务隔离在认证 owner、当前 tenant 和 role 组成的 scope 内，续问使用服务端保存的安全历史，客户端不能替换已有任务历史。SSO 用户可在同一账号和 scope 内恢复任务；凭据客户端使用凭据哈希隔离。刷新登录可以读历史，但不继承旧会话的变更确认授权。

持久化任务的确认请求包含 `{taskId, token}`。服务端先认领一次性确认，再执行已确认参数，并依据真实回执继续用户原任务尚未完成的查询和验收；不会把同参数变更重新提案或执行。对于目录中已有匹配 GET 的资源，可读取变更后的实际对象；readback 保留该 GET 明确支持的查询参数，包括已显式指定的 `query.tenant`，不虚构验收端点。后续每项新变更仍需单独确认。省略 `taskId` 的 legacy 确认接口保持原有单项操作回执契约。

受理、排队、HTTP 200 或资源 readback 都不等于独立验收通过。助手只有取得对应行动 ID 的真实 `succeeded` 状态，以及非 pending、带检查时间且全部通过的 `execution.verification.checks`，才可声称该行动的后置验收通过。没有对应证据时明确保留「尚未验证」。变更超时、结果未知或执行中断时停止后续工作并记录不确定结果；恢复任务不会自动重放副作用，应先查询当前状态。

任务接口前缀为 `/api/ops/observability/assistant`：

| 接口 | 用途 |
| --- | --- |
| `GET /tasks` | 当前 scope 的最近任务、状态和计数。 |
| `GET /tasks/:taskId` | 恢复安全历史、回执及当前可用确认信息。 |
| `POST /tasks/:taskId/feedback` | `{rating:"helpful"或"not_helpful",expectedRevision}`，记录人工评价。 |
| `GET /tasks/cases?download=1` | 导出该 scope 真实任务的脱敏案例 JSON。 |

## 人工反馈与真实回归案例

「有帮助」「需改进」是操作者对结果的评价，不是诊断正确率、独立验收或模型训练标签。后续同 scope 任务可参考至多三条与当前 view、environment 匹配、已回答完成且标为 helpful 的任务步骤。它们作为非可信提示提供，仅包含目标摘要和工具调用顺序，明确没有当前证据或授权；新任务仍必须查询实时数据，不能复用旧对象、旧参数或旧结论。任务的 `completed` 表示本轮回答完成，导出统计保留 `verification: not_evaluated` 和 `validatedSuccess: null`。

`GET /api/ops/observability/assistant/tasks/cases?download=1` 导出来自实际任务记录的安全历史、回执、上下文、人工评价和状态，不是合成示例，也不证明生产效果改善。导出沿用原 owner/tenant/role 访问范围，不包含可执行确认 token 或原始凭据。

行动环的 `POST /api/ops/observability/actions/:id/regression` 会先将已独立验收的真实行动结果保存为不可变案例，再把案例 ID 和内容哈希绑定到行动；旧客户端提交的 marker 仅兼容接收并忽略。案例必须关联同环境、同剧本的精确 remediation run、真实步骤结果和行动验收。未知、运行中、缺少验收或缺少对应 run 的结果被拒绝，保存或绑定失败不能展示为加入成功。

绑定后可用 `GET /api/ops/observability/actions/:id/regression?download=1` 下载本账户的 action outcome snapshot，包括证据引用、执行结果、验收状态和 SHA-256 内容哈希。互审权限不扩大该案例的导出范围。此案例衡量已记录的行动结果，不衡量 diagnosis accuracy，也不自动重放剧本、更新有限 HTTP 分类规则或执行生产改动。

## 持久化与恢复边界

任务文件目录由 `RDK_PLATFORM_ASSISTANT_TASK_STATE_DIR` 指定，默认 `~/.local/state/d-obs/assistant-tasks`；每个 owner/tenant/role scope 上限为 200 个任务、16 MiB。账本使用内容哈希、原子写入、文件锁和修订号，状态损坏时拒绝继续，不重建空记录掩盖丢失。运行租约为 15 分钟；读取恢复时发现租约过期或原进程中断，将任务标为 `interrupted`，清除待执行确认，不自动重放操作。

行动回归案例目录由 `RDK_ACTION_REGRESSION_STATE_DIR` 指定，默认 `~/.local/state/d-obs/action-regressions`。每个账户和行动保存不可变案例；相同结果重复保存返回同一案例，结果变化或哈希不符拒绝覆盖。备份应包含这两个目录。当前实现是本地文件账本，不代表已有跨主机分布式调度、自动学习晋级或生产处置效果验证。

## 实际对话验收

目录覆盖检查验证已注册 API 的接线；自然语言验收另行检查用户原问法、实际操作回执和最终回答。使用 [只读验收脚本](../tools/platform-assistant-read-smoke.mjs) 串行验证 11 个场景，包括模型池原问法重复两次、带历史的路由追问、告警、SLO、运营指标、租户、日志、副驾、总览与运行质量。模型池回答须包含目标健康信息，路由追问须包含 fallback 信息；只有 HTTP 200 或执行记录不算验收成功。

```bash
# 在服务所在 Linux 主机运行；未提供凭据时从 d-obs.service MainPID 读取管理员 token，不打印凭据。
node tools/platform-assistant-read-smoke.mjs --origin https://rdkstudio.d-robotics.cc/dobs
```

客户端可在 capabilities 与 chat 请求中提供 `x-rdk-ops-read-only: 1`。capabilities 返回 `readOnlyExecutionSupported: true`，并仅列出读取操作；chat 的模型目录同样排除变更，执行器在路由调用前再次拒绝非 GET。该限制也适用于通用 MCP executor。测试脚本先确认此契约，旧版本不支持时不发送 chat；权限与 chat 原有 action 守卫仍需满足。测试输出只有场景、HTTP 状态、实际操作 ID 和错误码，不含凭据或数据正文。

这些场景覆盖主要查询流程；生产写入、真机采集、审批与处置需要各自的操作授权、真实参数和单独的验收证据。

扩展 [模块验收脚本](../tools/platform-assistant-module-smoke.mjs) 按分组覆盖查询与现有资源详情，并单独报告空资源、缺账号参数、SSO 身份要求、仅写入模块和不可用数据源。使用 `--list` 查看本次实际场景，使用 `--case` 重测指定场景。列表回执被截断时标记 `partial_verified`；学习模块逐项核对技能、经验和进化数据源的真实状态。脚本保留安全 HTTP 状态与 MIME，连续两次传输错误或限流后停止，避免重启窗口下连续发送失败请求。

看板、租户与组员、策略、设备命令和模型价格的写流程由独立空的 loopback PostgreSQL 测试库验证真实 handler、审计、持久化、授权和一次性确认。设备并发轮询使用数据库行锁认领待发命令；超时重投机制仍保留，因此这不代表设备上的物理执行恰好一次。价格与策略必须使用真实 JSON 数字和布尔值，不能将 null、字符串或数组隐式转换为 0 或启用状态。

## MCP 接入

继续使用 `POST /api/ops/mcp`。管理员仍能使用原八个指标、日志、设备、事故关联与迭代周期查询工具；统一工具补充如下：

| 工具 | 用途 |
| --- | --- |
| `list_platform_capabilities` | 返回当前身份可发现的 operationId、分组、读写属性以及 params/query/body 参数说明；可按 group/search 筛选。 |
| `execute_platform_operation` | 根据目录中的 operationId 调用原平台 API。工具参数只包含 operationId、params、query、body；不能传入请求头、身份或任意 URL。 |

管理员使用现有 `x-admin-token` 或 SSO 身份；租户凭据只发现租户可达功能，原路由仍判断组员/owner/探针 token 各自的读写权限。租户不能调用原全局指标工具。SSO 中继与租户头沿用部署现有约定。

变更调用必须在 HTTP 请求中提供 `x-rdk-ops-action: observability`；不能放在工具参数中。跨来源请求仍由原守卫拒绝。受保护读取的 `observability-context` 由执行器设置，但不提升原身份权限。

页面当前租户视角只继承给能力目录明确声明 `query.tenant` 的操作，显式工具参数仍优先。其他接口保留自身严格参数校验；外层身份与租户权限保持原样。

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "list_platform_capabilities",
    "arguments": { "search": "维护窗口" }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "execute_platform_operation",
    "arguments": {
      "operationId": "POST /api/ops/observability/maintenance-windows",
      "body": { "minutes": 30, "reason": "计划维护" }
    }
  }
}
```

下载结果中的 `downloadUrl` 是业务根相对路径。外部客户端需使用部署的公开基址拼接（例如 `/dobs`），并带原身份凭据请求附件；工作台自动处理此前缀。HTTP 失败返回 MCP `isError: true`，不会包装成成功。

## 权限与现有边界

生产处置仍使用证据 proof → 提案 → 有权的另一操作者审批 → 白名单执行 → 后置验证。模型不能替用户自动审批建议。多用户行动域仍需 SSO 管理员；管理员 token 不能替代该身份。

行动域默认只可见本人账户。服务端可用 `RDK_OBSERVABILITY_ACTION_APPROVAL_SCOPES` 显式配置互审，例如 `{"operator_a":["studio:operator_b"],"operator_b":["studio:operator_a"]}`。键必须是真实 SSO ID，双方均须已在运营管理员名单；客户端不能授予作用域。此配置只扩展已有行动的列表、详情和审批；证据签发、新提案、重新提案、执行、后置验证、回归和完成仍限定本人账户。提案人自批仍被拒绝。配置错误或权限撤销时拒绝访问。模型池配置等原本直接写入的 API 继续沿用各自原有权限与审计流程。

原生 Grafana 可通过助手与 MCP 读取看板目录、按 UID 查看面板及 PromQL 定义、读取数据源安全元数据。接口为 `/api/ops/observability/grafana/{dashboards,dashboards/:uid,datasources}`，仅运营管理员可见；复用既有 Viewer 的回环 API，不转发调用者凭据。数据源不返回 URL、账号、密码或请求头。表达式被脱敏、过长或带模板变量时明确标为不可直接执行；实际指标继续通过现有 PromQL API 获取。原生写入遵循 `ops/grafana/` provisioning 归属，本目录只声明读取能力。

同时请求原生大盘与数据源目录，或视觉工坊的能力与实验列表时，助手必须取得分别对应的成功回执；漏项纠正仅允许尚未调用的目录。失败、异常或纠正后仍缺项时明确显示查询不完整，不重复读取，也不把定义当成实时指标。单项读取、明确不查某项和已有实验详情不会要求额外目录读取。

账号行为与事件明细返回统一 `timeWindow` 和逐源 `sourceAvailability`。活动按小时窗口筛选；注册资料标记全历史，用量按窗口覆盖的数据库自然日统计并返回日精度和时区。读取失败的兼容零值/空数组不代表没有活动；助手对每个账号分别说明范围与完整性，部分来源失败时仅根据可用来源生成确定性摘要。

新增业务路由需在 `platform-operation-metadata.ts` 添加审核过的声明和参数说明，并由组合根显式注册。`platform-operations.test.ts` 对真实路由与目录逐项核对，遗漏声明、过期说明或退役入口复活会触发回归失败。
