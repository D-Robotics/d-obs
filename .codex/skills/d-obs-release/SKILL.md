---
name: d-obs-release
description: 发布、回滚和验收独立 d-obs 可观测服务及平台 AI 助手，处理共享脏工作区、线上基线、必要依赖闭包、模型网关客户端配置与原子版本切换。用户说“部署 d-obs”“把助手上线”“发布到生产”“让改动在线上生效”“d-obs release/deploy/rollback”时使用；普通 UI 审查或其他 RDK 平台部署使用对应技能。
---

# d-obs 生产发布

把用户已授权的改动发布成可核验、可回滚的生产版本。用户明确要求部署、上线或发布时继续完成准备、切换和验收，不因本技能再要求一次确认。仅请求审查或预检时保持只读。部署授权不扩展为修改同机其他服务、接入任意设备或发布其他会话的工作。

本技能绑定 `package.json` 名为 `rdk-d-obs` 的仓库。路径按仓库根解析；先读 [docs/deploy.md](../../../docs/deploy.md) 与 [ops/deploy.sh](../../../ops/deploy.sh)，再核对线上实际布局。手册中的历史 release、worker 归属和规则数量不能替代 live 状态。

## 1. 固定本次范围与线上基线

1. 记录 `git status --short`、源码 HEAD、本任务文件和既有 WIP。不要 reset、clean、替他人提交或把工作区全部打包。
2. 从部署文档获取连接方式，核对真实 `current`、systemd `ExecStart`、运行 PID、Node 可执行文件、端口和反代入口。默认布局如下，发现差异时使用实际值：

   | 参数 | 文档默认值 |
   | --- | --- |
   | 应用与版本目录 | `/opt/d-obs/current`、`/opt/d-obs/releases/<release-id>` |
   | 应用服务 | `d-obs.service` |
   | 源站 | `http://127.0.0.1:18093` |
   | 公网 | `https://rdkstudio.d-robotics.cc/dobs` |
   | 服务环境文件 | `/etc/d-obs.env` |

3. 下载本任务将改动的**真实线上产物**作为 baseline，并记录 canonical release 路径和逐文件 SHA256。线上可能含已发布补丁；本地 HEAD 不能直接当线上基线。
   overlay release 可能继承旧 manifest；后续发布替换了其中的文件时，旧清单不再代表当前内容。核对最新发布 manifest 与继承清单，按实际覆盖关系合并并逐项验证，记录所有基线 manifest 的哈希。current 或文件内容变化时重新下载基线并做最小补丁，保留新上线的确认、权限和登记逻辑，不能仅改旧包的 baseRelease。
4. 检查本次是否包含 `package.json` 依赖变更。依赖不变时保留线上 `node_modules`；服务器 npm registry 曾不可达，不在线上临时 `npm install`。
5. 检查发布脚本的实际副作用。共享 dirty tree 或应用 overlay 发布不要直接用 `ops/deploy.sh --allow-dirty`：脚本还打包 `ops/tools`，可能覆盖 Collector 配置、timer 或 worker。保留这些组件的原目录、配置和软链，除非本次任务明确包含它们。

长任务或可能中断的发布，把冻结源码、原始副本、baseline 哈希、overlay、manifest 和验收日志保存到本聊天可写的持久目录；系统临时目录可能在中断后消失。记录恢复路径。共享文件以 baseline 加本任务最小补丁组装；冻结后不再从正在并发编辑的整文件补拷。回写源码前逐文件核对冻结时哈希，遇到并发变化先做三方合并。需要 git 快照时使用独立临时 index，不改主 index；用户未要求时不创建正式 commit。

## 2. 从功能推导必要依赖闭包

枚举实际注册的 Express 路由与运行时 import，含动态 import。将源码可达模块与线上已有模块比较，只带本次新增或确需替换的文件。排除 type-only import、测试和无关 UI；不要通过“缺什么就把本地整目录补上”扩大发布范围。

平台助手上线已验证的核心产物为：

- `server/monitoring/observability-page-assistant.js`
- `server/monitoring/platform-assistant-routes.js`
- `server/monitoring/platform-operations.js`
- `server/monitoring/platform-operation-metadata.js`
- `server/observability/platform-assistant.js`
- `server/observability/platform-assistant-projection.js`
- `server/observability/platform-assistant-model.js`
- `server/observability/platform-assistant-redaction.js`

在**下载的线上文件**上做接线补丁，逐文件审查 diff；本次助手完整发布验证过以下五处，后续按所需功能选择：

| 线上产物 | 最小补丁 |
| --- | --- |
| `monitoring/observability-page.js` | 导入助手组件，拼入对应样式与脚本，保留既有页面内容及顺序。 |
| `monitoring/observability-signals-routes.js` | 注册助手路由；MCP 合并平台工具；沿用租户解析与请求权限。 |
| `monitoring/observability-routes.js` | 需要 SSH/RDK 能力时导入并依次注册两个日志路由。 |
| `server/main.js` | 需要日志采集时加入两项 dispose 导入与 shutdown 调用。 |
| `observability/copilot-model.js` | 优先使用专用服务客户端配置，拒绝用 masked admin 配置 Key 推理。 |

不要照抄本地完整 `observability-page.js` 或 `main.js`；它们可能已包含他人尚未发布的页面或 Collector 改动。

### SSH/RDK 日志能力确属本次范围时

先核对源码：SSH 六条 REST 与 RDK 十三条 REST 是本次助手覆盖所需依赖，不是永远固定的 API 数量。生产缺少这些路由且用户要求发布完整助手功能时，连同必要后端模块发布；单纯 UI 改动不因此增加后端范围。

必要新增闭包为 `monitoring/{ssh-log-routes,ssh-log-collector,rdk-log-routes,rdk-log-capture,rdk-log-evidence}.js`。它们使用 Node 内置模块和既有 access、route-kit、agent-mcp、copilot-model；不需要新增 npm 包。仅发布此闭包，不顺带发布日志 UI、OpenTelemetry Collector、worker 或其他相邻 WIP。

主路由按顺序调用 `registerSshLogRoutes(router)`、`registerRdkLogRoutes(router)`。`main.js` 在既有 `server.close` 回调内、flush/exit 前先 await `disposeConfiguredRdkLogCaptureService()`，再 await `disposeConfiguredSshLogCollector()`，分别保留错误收敛。注册路由本身不会启动 SSH 采集。

后端需要 `ssh` 和服务账户可写的私有持久目录；可使用 `RDK_SSH_LOG_STATE_DIR=/var/lib/d-obs/ssh-logs`。目标、连接路径、密钥文件及 known_hosts 只能来自服务端真实配置。没有目标就返回 `[]` 和零 targetCount；不能把浏览器所在网络或模型 ping 当成已连接 RDK。

## 3. 修复模型通道时使用客户端凭据

网关 `/admin/config` 的上游 `apiKey` 可能是 masked 展示值。读取成功或字段非空都不能证明它能推理；使用该值曾导致真实调用 401。不要把 admin key 当 inference key，也不要从 masked 字符串猜恢复密钥。

优先使用可信服务器环境中的完整客户端配置：

- `RDK_PLATFORM_ASSISTANT_BASE_URL`：已验证网关 frontend 地址，本机部署使用实际回环 `/v1` 入口。
- `RDK_PLATFORM_ASSISTANT_MODEL`：网关公开的 frontend 模型别名。
- `RDK_PLATFORM_ASSISTANT_API_KEY`：专用服务客户端 Key。
- 按当前实现核对 `RDK_COPILOT_MODEL_ENABLED` 与 admin 配置等启用条件；`modelEnabled` 不是网络探测结果。

已有服务身份优先复用其保存的 Key；网关 create 可能重置同名身份，不能盲目重建。需要配置新服务身份时限于用户已授权的功能，使用适当限额并记录其语义。客户端经 frontend 路由调用 `/v1/chat/completions`，保留网关路由与预算机制。

共享 copilot 修复可以让 `resolveGatewayChatTarget()` 优先返回专用解析器，原 admin/config 仅作兼容 fallback，并过滤 masked Key。RDK 分析是独立通道：核对 `RDK_LOG_AI_GATEWAY_URL`、`RDK_LOG_AI_MODEL`、`RDK_LOG_AI_GATEWAY_KEY` 和 `RDK_LOG_AI_ENABLED`，不能因 copilot 修复便宣称 RDK 模型已可用。

HTTP 200 的模型响应也可能没有正式正文。已验证的故障是 DeepSeek 在 `max_tokens:1200` 下返回 `finish_reason:length`，`completion_tokens=reasoning_tokens=1200`、content 长度 0；客户端因此抛 `gateway_empty_response`，助手统一显示 model_unavailable。通过 llm_call 的 parent_span_id 关联入口，核对状态、耗时、finish_reason、token 数和正文长度，不能从 ingress 的 ok 或全局累计429推断原因。助手独立使用4096输出预算与35秒单次时限，其他 copilot 调用保留默认1200；仍拒绝空正文，不拿 reasoning_content 伪造工具计划，不自动重放平台操作。

环境变更只写本任务专用的 root-owned 0600 文件，并用本任务的 systemd drop-in 引用它。保留其他 drop-in 和 `/etc/d-obs.env` 原文；备份也用 0600。配置与凭据不进 tar、manifest、git、聊天或完整日志。只报告是否配置、调用状态和必要的非秘密模型名称。

## 4. 核验候选与 manifest

1. 运行与变更相关的类型检查和测试。助手覆盖检查必须比较注册路由与 metadata/exclusions，不把某次能力数、分组数或工具数写成永久常量。API 数量与 HTTP 200 只能说明覆盖或传输结果，不能证明自然问法得到了所需业务答案。
2. 加入日志闭包时运行 `ssh-log-collector`、`ssh-log-routes`、`rdk-log-capture`、`rdk-log-evidence`、`rdk-log-routes` 五套测试，覆盖权限、actor 隔离、有界采集、停止/恢复和脱敏证据。模型解析器、助手编排、平台 executor 和助手页面也按改动运行对应测试。
3. 对最终 overlay HTML 解析所有内嵌脚本，确认助手确实接入。源码 UI 测试不能替代线上 baseline 加补丁后组装页面的检查。
4. 生成 manifest：记录 `baseRelease`、源码 HEAD、本次 scope、所有发布文件 SHA256、被替换 baseline 文件 SHA256、模型 transport 描述。源码 HEAD 是来源信息；overlay 不等于整个线上版本对应一个 commit。
5. 打包只包含 manifest 文件清单和 manifest 自身，确认入口补丁、必要依赖均在包内。核对 tar SHA256；上传后先核对包哈希再解包，解包后逐文件核对 manifest。不要吞 stderr 或使用上一次遗留包。

macOS 的 `tar -tzf` 曾隐藏 AppleDouble `._` 成员，但 Linux/Python 解包实际得到双倍文件。打包时关闭复制扩展属性，并在上传前用 `tarfile.getmembers()` 或等价实际成员读取核对：名称集合、数量、普通文件类型都与白名单严格一致。不要只靠展示列表判断包干净；发现额外成员就重新打包，不在远端放宽解包闸门。

Trace 正文样式发布时检查实际组装值 `OPS_OBSERVABILITY_TRACES_STYLE.includes(OPS_OBSERVABILITY_TRACE_CONTENT_STYLE)`。线上汇总模块可能把旧正文 CSS 内嵌成字符串，单换正文样式模块不会生效。遇到此布局，用 AST 找到以旧正文 CSS 开头的字符串 literal，将该前缀改为正文样式 import，保留其余字符串与密度样式。验证新汇总 CSS 严格等于旧汇总 CSS 只替换正文前缀后的结果；把这处接线作为必要闭包，不用本地完整汇总模块覆盖线上其他排版。

## 5. 切换前在生产 Node 下做只读候选冒烟

使用 `ExecStart` 的真实 Node。SSH shell 里的 `node` 可能是另一个版本。在服务器候选目录创建临时 Express 实例，加载 `createOpsObservabilityRouter()`，监听 `127.0.0.1` 临时端口；不要直接运行第二个 `main.js`，避免抢占正式端口或启动 ingest/gRPC 等旁路。

从服务实际 MainPID 的 `/proc/<pid>/environ` 以 NUL 分隔读取运行环境，在服务器进程内叠加本任务私有配置，不打印凭据。候选若访问日志模块，预先把 `RDK_SSH_LOG_STATE_DIR` 指到独立临时目录：capabilities 的 lazy 初始化会恢复本地采集记录，不能让第二个实例恢复写入正式采集 state。结束时 dispose 两个采集服务并关闭临时 HTTP 服务。

只做真实只读业务请求与协议负向检查：

- 匿名 capabilities 被拒绝；管理员 capabilities 的 operationId 集合与本次冻结源码期望一致，无退役/递归路由或 fallback 说明遗漏。
- MCP discovery 包含本次所需工具；工具数量从源码/manifest 推导。
- MCP 调用 `execute_platform_operation` 执行 `GET /api/ops/observability/overview`，参数 `hours=1`，读取真实 HTTP 状态和工具回执。
- 写 guard 负向测试只沿用已经 live 验证的 MCP 维护窗口拒绝请求，**不带** `x-rdk-ops-action`，应得到 `isError:true` 与 `missing_ops_action_guard`。不要把冒烟脚本扩展成任意创建、启停、发通知或执行处置。
- 发助手聊天明确只执行 `GET /api/ops/observability/copilot/status`。外层 200 不够：operations 必须有该 GET 的成功回执，reply 不含 model_disabled/unavailable/invalid_output 等失败标记。

真实模型曾在已完成工具读取后返回普通文本末轮回复。测试这个兼容路径：JSON 工具命令仍严格校验，普通文本不能伪装新工具命令或未执行变更；如允许格式纠正，应有次数上限。mock JSON 返回、模型 ping 或 capabilities 标志不能替代完整真实 chat 的工具执行与正常答复。

### 自然问法与只读执行验收

复用 [tools/platform-assistant-read-smoke.mjs](../../../tools/platform-assistant-read-smoke.mjs)，让它直接请求实际候选或生产 origin；脚本不自行启动 Express。先读取 capabilities，要求 `readOnlyExecutionSupported:true`，再发 chat。所有请求携带 `x-rdk-ops-read-only:1`；服务端须过滤写能力，并在执行器 dispatch 前再次拒绝写操作。缺少只读握手的旧服务立即退出，不能向它发送聊天；消息中的“仅查询”提示不能替代服务端约束。继续满足正常身份与 `x-rdk-ops-action` 等既有要求，模型提出或回执出现写操作都使冒烟失败，不授权实际生产写入。

当前脚本有 11 个场景：模型池精确原问法两次、带 history 的 fallback 追问，以及告警、SLO、运营指标、租户列表、日志入口、copilot 状态、平台总览和质量。两次原问法必须精确发送“目前rdkstudio背后模型池情况”，不追加只读尾巴，以验证用户真实输入。追问“看一下刚才这些模型的fallback路由现状”携带原问题与旧答复，旧答复说明未修改配置；仍要求本轮成功执行 `GET /api/ops/observability/model-pool`，不能靠 history 直接回答。

插件宿主的固定诊断工作流是 `POST /api/ops/observability/plugins/:id/workflows/:workflowId/run`，目录标记 `mutating:false`。核对实际 executor 的固定白名单和路由纯只读约束后，允许这项能力声明通过目录验收；不要因 method 不是 GET 就把整个安全目录判坏，也不能普遍把 POST 当成只读。上述自然问题场景的执行回执仍限定 GET；允许目录中的只读工作流不授权冒烟调用其他非 GET 操作。

模型池场景同时核对新 GET 回执与业务正文：只取 reply 中“平台实际执行记录：”之前的 narrative，前两次必须含模型/目标信息及健康、healthy、cooldown、half_open 或降级等实际状态；追问必须有 fallback、降级或路由内容。包含真实 `modelMapping`、`state` 等字段的结构化摘要可以通过。接口执行成功、replyLength 非零或回执附录中的关键词不能凑成内容验收。

SLO 场景必须在业务正文中包含实际 SLO 与 error budget。较大的 overview 应按字段结构压缩，保留较晚出现的 `serviceLevels`、`errorBudget` 与证据字段；不能依赖 JSON 前缀截断。模型池再次压缩时保留经过校验的原始 `sourceCounts`，`includedCounts` 只描述实际保留的条数，中文摘要明确提示部分数据；不能把压缩后的数组长度写成真实总数。
SLO 问题取得成功 overview 回执后，确定性摘要依据 `overview.serviceLevels` 的 policy、summary、objectives 和 errorBudget 补齐答复，不追加 API 调用。保留负预算；样本不足、dataAvailable=false、字段缺失和截断均明确说明。关键词存在不能代替实际预算数据，尤其要测试多次大读取后的兜底。

同一 principal 顺序执行，单请求超时 60 秒。凭据来自受控环境，或仅在服务器读取真实 MainPID 的运行环境；输出只保留 operationId、status、ok、replyLength 和错误标记，不输出正文、账号数据或 token。任何场景失败都退出非零，逐阶段记录候选与生产实际通过的场景，不从候选或少数成功请求推断生产全部通过。

候选必须使用上文独立 state 和临时 loopback 端口。公网验收用 `node tools/platform-assistant-read-smoke.mjs --origin <实际公网 base URL>` 显式定向，避免 `ASSISTANT_SMOKE_ORIGIN` 留有候选地址时让 `--public` 测错服务；远程 origin 限 HTTPS，HTTP 只允许 loopback。每次从实际 origin 的能力目录推导只读操作，不硬编码永久 API 数量。

保存冒烟的状态、退出码、operationId、HTTP 状态和错误标记，不保存完整账号数据、原始日志或 Key。未配置设备时，RDK capabilities 与空 targets 可以验收；真实采集与模型证据分析需要另外的真实证据，不能从目录存在推导成功。

### 扩展模块与真实写流程验收

需要核对其他模块时使用 [模块脚本](../../../tools/platform-assistant-module-smoke.mjs)，先用 `--list` 读取实际场景，再顺序运行。按实际目录核对分组，不把案例数当作覆盖恒量。目录存在、HTTP 200、空资源、缺参数、SSO 身份要求、仅写入模块、数据源不可用分别记录；仅成功 GET 回执与有效业务答复能算查询通过。维护旧只读脚本的模型池/SLO/历史追问回归。

按真实接口嵌套形状判断列表。对象目录已验证返回 `objects.objects`；大回执返回 `{truncated,preview,structuredData}` 时显式读取结构化摘要，坏结构不能退回猜文本。采样列表与截断回执标记部分验证，不能假称完整或空列表。学习接口 HTTP 200 不代表技能、经验、进化三源都可用，逐源比较真实 status 与业务正文。

保留 HTTP status 与安全 MIME，连续两次传输失败或429后停止，不自动重试。已验证的批量502曾全在另一会话部署停启空窗发生，nginx upstream连接拒绝；丢失状态的旧脚本把HTML502误记成JSON解析失败。先查当前服务与重启时间，再重跑稳定服务，不将这类旧记录直接归因于所有模块。

另一会话继承本任务 release 并只发布 UI 显示改动时，先逐项验证本任务全部文件与其余后端哈希、实际 PID cwd 和当前 manifest。已相同的修复无需重复切换。中断前成功的案例只有在对应实现未变且哈希一致时可保留，显式定向公网继续未完成/失败项；按阶段保存日志，报告合并结果与真实资源限制。current 已被其他发布替换时，不能回滚对方。

自然问题不能混淆两个有效接口：已验证“登记对象”会合理选择注册表，而聚合资产目录需明确合并运行目录与注册对象的总量/类型；保留两者的独立测试与严格回执要求。缺参数澄清应支持自然输入问法，纯模块描述与伪统计仍拒绝。使用完整能力目录测试澄清优先级，账号说明中的“运行”曾误触 locator 提示；主体账号标识先于附带数据类型，只有明确询问运行标识时才要求 locator。

泛用 executor 的外层租户视角仅继承到目录明确声明 `query.tenant` 的操作，不能向所有接口自动注入。已实测严格数据中心接口在直接读取与无视角 MCP 下成功，但外层 `?tenant=current` 因多余参数返回 400。修复只改变内部业务 URL；保持外层授权身份、确认作用域及显式工具参数优先级，并用同一真实 SSO 对比候选和公网。

原生 Grafana 验收包含安全目录、UID 面板定义、数据源元数据和每条不同的实际 PromQL，不能以一个查询成功替代整盘。Prometheus 可能保留 dotted UTF-8 指标与标签，先读实际名称和版本，再用引用语法修复 provisioning 表达式，不能猜下划线名称或放宽平台校验。只发布目标 JSON 的确定变更，保留其他看板和 provisioning；挂载目录既有轮询能生效时无需重启容器。配置定义不等于实时指标，合法空值与被过滤的 NaN 如实报告。

复用 [原生 Grafana 只读验收](scripts/grafana-read-smoke.mjs) 的 `--origin <候选 loopback 或正式公网>` 验证三种真实问法；正式公网用 [全部 PromQL 只读查询](scripts/grafana-all-prom-read-smoke.mjs) 的 `--origin https://rdkstudio.d-robotics.cc/dobs` 验证实际发现的每条表达式，按返回数量报告，不固定看板或表达式数。两者均先验证服务端只读握手，凭据只在服务器内存读取；前者导出的函数可接受正常 SSO 会话。相同 token 的 chat 不能并行，按不同真实 principal 或串行执行。

复合问法须逐项核对成功回执。已实测模型会只查 Grafana 大盘而漏数据源，或只查视觉 Workshop 能力而漏实验列表；普通答复看似完整也算失败。一次有界纠正只允许尚未尝试的所需 GET，任何失败、重复读取、异常或最终收口仍缺项都显示查询不完整。单项、否定、明确资源详情与解释问题不应被强制额外读取；保持六次执行上限。模型首轮格式失败先保留原记录，用已知字段类型、长度、finish_reason 与 token 数诊断，不打印正文、不放宽命令结构；后续成功不能抹掉之前未复现的失败。

双人互审须验证两位现有 SSO 管理员及账户归属。显式互审配置只扩展列表、详情和审批；提案人自批与另一账号执行仍应拒绝。配置保存在专用 0600 环境文件，复用原管理员名单，不为验收创建管理员或伪造 SSO。生产没有行动资源时，只将私有空 PostgreSQL 上实际 handler 的互审、并发执行与审计算作隔离测试，不能称为生产处置已执行。

只启动router的候选不会启动治理运行时，受保护会话/Run读取可能因治理 readiness为idle返回503，而正式服务同一GET为200。不能为消除测试失败伪造readiness、移除门禁或启动第二个生产清理worker。保留这一候选环境限制，并在切换后的正式服务逐项复测真实模型与GET回执。

用新的私有loopback PostgreSQL与独立空测试库验证写流程，运行实际业务handler与确认/授权存储，禁止使用生产数据库URL。核对创建/更新/删除、租户与actor隔离、token轮换、类型校验、并发认领、审计及确认只使用一次。设备接收器用测试fixture，不运行板端脚本或运动指令。真实45秒执行超时应保留unknown并使确认永久消耗；已有完整实跑证据且逻辑未变时不要无意义重复长超时用例。测试name-pattern匹配父用例可能仍执行全部子用例，按最终实际日志报告，不能按意图声称skip。

确认后的下轮历史必须包含脱敏真实回执：保留对象ID和完整可用evidenceProof，不发送凭据，不把提案或模型文本当作已执行证据。长签名不能剪断后交给下一步；无法容纳就明确省略。UI与engine分别测试确认→带历史追问，以及大字段之前/之后的ID、proof和源状态。精确隔离验收只用最新线上baseline加最终overlay；从编译目录仅取test文件，不能把其他会话runtime夹带进来。

需要验证真实模型是否会进入统一确认机制时，运行 [提案脚本](scripts/assistant-proposal-smoke.mjs) 并显式提供候选origin。脚本先要求 `mutationConfirmationRequired:true`，顺序核对看板、租户、策略的精确提案参数与缺目标澄清，绝不调用confirm；任何非GET执行回执立即失败。它验证模型选择与确认卡，不能算生产写入通过。已验证的问题是模型看到原租户API没有draft接口便声称不能提案：在系统指令中明确所有未授权变更由助手统一生成确认卡，原业务审批与权限仍保留。模型自行写一段“草稿”不算真实平台提案。

## 6. 克隆、切换与失败恢复

1. 候选与 node_modules 可用 `cp -al` 从已核对 release 硬链克隆。**每个要覆盖的文件先 unlink，再拷贝新文件**；直接重定向、writeFile、原地编辑或普通 cp 覆盖硬链会改坏旧 release，连回滚版本也一起失效。同名继承manifest也属于硬链文件；优先用本次独有manifest名称并断言不存在，不能复用脚本直接覆写上次manifest。
2. 核对旧 release 被保护文件的哈希仍等于 baseline；候选发布文件等于 manifest；未包含本任务的文件保持原样。检查依赖和 ESM 导出，避免只上传新增 import 而漏传 helper。
3. 切换前重新读取 current 与 baseline 哈希。若另一会话已经发布，重新取得新基线并重做 overlay；不拿旧基线覆盖新版本。 同目录随机临时软链加 rename，避免遗留固定临时名称阻塞回滚。新线上已包含相同且验收一致的文件时直接完成验收，不重复发布。
4. 记录切换前 release 和本任务环境/drop-in 的恢复材料。用临时 symlink 加同目录 rename 原子切到新 release，随后重启 `d-obs.service`；系统环境更新按需要执行 daemon-reload。
5. 用有界等待检查 `systemctl is-active`、`/healthz`、`/readyz` 与源站页面。服务启动失败、就绪失败或本次必要模型/业务冒烟失败时恢复旧版本；保留具体失败证据。
6. 回滚前确认 current 仍指本任务候选，避免把他人的后续发布回滚掉。只恢复本任务改变的环境文件/drop-in，不覆写其他服务配置、数据库状态或新并发改动。重启并再次验证旧服务恢复健康。

本次范围包含 oneshot worker 时，先保存原 timer 状态并暂停 timer，等待现有周期自然结束。`systemctl is-active --quiet` 不能判断 oneshot 是否仍在执行：用 `ActiveState`，把 `activating/active/deactivating` 视为仍运行，未知状态拒绝切换。排空等待之后再次核对两个 current 与 manifest，再切换指针；失败时先恢复自己的两个指针再重启，退出时恢复原 timer 状态。给 systemctl、HTTP 探针和等待设置边界，并验收一次新版本自然定时周期。

不要把一次性 prepare、切换或 rollback 临时脚本当成通用脚本复制。重用的是参数化步骤与已验证的 guard：目标来自当前 live 读数，scope 来自 manifest，expected base/hash 不匹配便停止切换。脚本通过语法检查不能被描述为执行成功。

## 7. 以公网与真实回执收尾

### 告警卡片与历史详情

卡片来源调查先用告警键、UTC 时间和工具名查真实失败记录，再从 correlation 与对应 Run 核对 SSO、应用版本、客户端和模块。服务器的 package 版本不能代表桌面来源版本。区分失败调用次数、`occurrence_count` 合并次数、存储记录条数和按账号/环境/Run 去重的数量。

独立核对页面服务与实际评估 worker 的 `ExecStart` 和各自 `current`，二者可能加载不同 release。需要同时更新时保留两份线上基线、按各自闭包覆盖，并按第 6 节暂停 timer、排空 oneshot、原子切换和恢复定时器；不能只更新页面就声称新卡片已生效。只读生成卡片可验证字段和链接，不向真实群发送验收通知。

告警中心“没有匹配事故”时对照同一受保护 API 的 30/90 天、全部状态结果与 `first_seen_at`、`last_seen_at`、`resolved_at`；已验证旧事故重开却沿用旧首发时间会被日期过滤，恢复后也会被默认进行中筛选隐藏。新增快照表与 API 时同步实际 capability metadata 和数据库面板名单契约，不改 checker 绕过注册。

历史深链必须绑定准确发生时间。精确时间缺失返回 404，无效日期返回 400，不能改读最新窗口；租户快照与原事件详情分别沿用自己的授权边界。回填旧告警只用仍保留的原始记录，标记 `historical-reconstruction` 和真实保存时间，不能伪造当时已存快照。以匿名拒绝、带权限历史读取、恢复后详情、真实定时周期和公网回执收尾。临时候选调用 `loadAlertConfig()` 时须 await；它返回 Promise，直接传给卡片生成器会得到配置未定义错误。

### Trace 正文与 Studio 采集端同时发布时

沿真实写入路径检查闭包：模型 provider 请求捕获、native processor、归档 Run ID 传播、批次规范化、中心 `scoped-trace-ingestion` 与 schema 都要核对。只添加正文采集而中心 INSERT 仍丢弃 content，不能算上线。先使用真实线上产物比较每项前后 SHA，再在相同 Node 下跑精确候选测试；沿用既有依赖和门禁。

对话归档新增 Run/environment 字段用可空列与索引增量迁移；旧归档无标识时保持未绑定，不凭时间邻近补回。验收从正常 overview 取得 locator，再用同一身份读取 detail，核对 Run/session 引用、本轮归档、用户输入、模型输出、实际模型输入和第二轮此前记录。日志只保存状态、数量、种类与已知验收句匹配布尔值，不打印正文、账号或 token。历史正文读取成功不能代替新 producer 的真实模型验收。

只发布对话展示时，用 [Trace 只读验收脚本](scripts/trace-conversation-read-smoke.mjs) 在真实 Node 与 MainPID 环境下执行，参数为 `--base <当前 release> --origin <源站或公网> --run <可选公开 runRef>`。脚本验证实际页面接线、脚本语法、匿名和缺 guard 拒绝，并将真实受保护详情传入实际正文 renderer 核对默认可见消息。公开 `run-…` 是展示引用，`traceRunId` 只识别 canonical Run ID：先在 normal overview 按公开引用找 locator；必要时用只读事务查询最多 4 条未过期正文的 Run 元数据，再通过 canonical ID 请求正常 overview，不能把公开引用直接当精确过滤条件。查询不取正文，凭据与 canonical ID 不进日志；模型输入缺失时单独报告，不能把角色检查的空集合通过当作新上下文采集验收。

真实模型验收前读取当前生产正常入口的限制。已验证的 Studio 版本在 `/api/agent/chat` 之前要求已验证板卡；canary 登录成功、synthetic 签名正确仍可能返回 `STUDIO_BOARD_REQUIRED`。先用正常身份列出可见且 connected 的既有板卡，仍由服务端验证归属和连通性。没有板卡时报告这一明确条件；不为测试移除门禁、伪造板卡或创建新权限。HTTP 403 且未启动 SSE 表示未进入模型，不能算完成两轮真实对话验收。

需要发布 Studio 必要采集闭包且用户已授权该功能上线时，核对主备各自实际服务、端口、PID cwd 与 nginx upstream。若二者共用 current，先切 current 并重启 standby，验证新 cwd 和 health 后再重启 primary，最后验收公网；失败按实际阶段恢复。保留 live 的设备、桌面计费等入口补丁，不直接上传共享源码整文件。发布后的继承整树 manifest 只描述基线，结合新 overlay manifest 的覆盖项解释当前内容。

源站成功后还要请求实际公网 `/dobs/ops-observability`，核对新页面内容及脚本、匿名 API 拒绝、带权限 API/MCP 和真实助手聊天。nginx 会剥离 `/dobs`，附件 API 相对路径需由页面已知 base 补齐；不根据任意外来 forwarded-prefix 拼下载地址。

本次功能涉及下载时验证回执只含受保护 URL/文件类型、不带 SSH/RDK 原文 preview；下载使用当前身份。工具结果发模型前脱敏，业务证据 proof 仍可用于下一步；操作超时/异常的副作用应报告 unknown，停止重复提交。

最终报告实际 current、manifest/产物哈希、源站和公网状态、真实 GET 工具回执、模型正常答复，以及尚未验证的部分。只报告本轮看到的事实；能力目录覆盖不代表所有写操作或真机采集都已实测。

写操作的答复必须对应真实阶段与权限：提案不等于批准，批准不等于提交，提交或 202 不等于完成。沿用该业务原有授权、审批和执行回执；仅查询的验收不能证明审批或执行闭环成功，模型文字也不能代替这些证据。

保留旧 release、manifest 和本任务 0600 配置备份作为回滚点。只清理本任务确定无用的临时候选；不批量删除其他会话版本，不删除 current，不自动 git commit。

## 8. 发布数据中心等私有文件状态模块时

这一节只用于包含本地元数据与真实文件资产的发布；普通页面修改无需重装备份或采集组件。

- 将新文件状态放入版本目录之外的私有持久目录，用本任务专用环境文件及 drop-in 配置。PostgreSQL 备份不包含这些文件；采用业务服务同一跨进程锁导出元数据与已校验文件的一致快照，再原子发布快照。当前数据中心使用 `tools/data-center-backup.mjs` 和专用 `d-obs-data-center-backup.timer`，按现场实际单元核对结果。
- 备份副本清除单任务采集凭据，保持线上凭据原样；恢复演练后核对资产、固定版本与闭环可读取，旧采集 token 全部失效，开放任务须重新签发。不能以公开资产 manifest 代替完整私有备份。
- 状态清单缺失或损坏且有初始化记录/实际文件时，必须拒绝继续读写并保留文件；不能按“首次空目录”重建，更不能在没有可信清单时删除所谓孤儿文件。首次空目录应先持久化空清单，再允许写文件。
- 测试真实上传与下载逐字节一致。`structuredClone(Buffer)` 会返回 `Uint8Array`，Express 的下载响应可能因此被 JSON 化；类型检查不能证明文件传输正确。同时测试重复上传、凭据轮换、终态拒绝和客户端断连后并发额度仍覆盖正在进行的归档。
- 在真实生产 Node 下运行候选产物测试，子进程和测试夹具导入 `.js` 模块，让源码环境由 tsx 解析、部署环境直接加载编译文件；不要为了让候选测试通过补拷全部源码。每次读取环境前重新取得 live MainPID：进程可重启而 current 不变，继续前仍须核对 current、PID cwd 与基线哈希。
- 大文件上传只放宽本次实际二进制入口的反代限制，保留其他路由原限制；用超出旧限制的无效凭据请求验收公网返回业务鉴权拒绝而非代理 413，不因此向生产制造测试资产。
- 用真实浏览器检查原生表单、主按钮对比度和未登录入口。DOM 夹具应保留 textarea/select 的只读属性，避免 VM 测试漏掉实际 TypeError。401/403 收敛为登录入口，读取失败不得显示伪造零值或允许使用旧账号缓存。
- 账号身份须在发送前及 JSON/blob 正文读取完后再次核对；响应头到达并不代表正文已读取。切换身份后清除旧表单、凭据与下载状态，不能把旧草稿写入新账号，也不能显示旧账号迟到的 token。
- 数据集、实验和导入桥接的容量上限要一致；使用合法实验的真实小文件测试超过常用数量边界，不能先归档全部资产再因快照上限永久失败还宣称可重试。验收记录保留申报指标与实际测量的来源差别；SDK 应用回读成功不等于真机质量改善，未配置设备适配器不能宣称已完成设备采集。

- 整合主控制台工作区时，以实际线上 SSR 与脚本为准。已验证 dirty 源码可能提供尚未上线的 `incidentCenterContext`，而 live 页面只导出 `OPS_OBSERVABILITY_HTML`、路由只导出 `createOpsObservabilityRouter`；不要从本地名字推断运行接口。新增独立身份 fingerprint helper，并用同一主体在原生浏览器验证免登恢复、两个工作区跳转和旧片段链接迁移。
- 采集 driver 回执要显式投影严格协议字段，不能展开原 SSH session 对象。已验证多余 id/target/source 字段会使真实运行被标成中断。实际执行后丢失启动回执须显示未知/中断并保守占用并发额度，不自动重放；重启恢复只检查已登记的上游并完成先前授权的归档。
- 归档幂等不能依赖用户可填写的 tags/description。使用服务端确定的 run+role 标识、真实内容哈希和固定快照；归档成功而运行回执落盘失败后重试须匹配同一内容，内容变化拒绝静默返回旧资产。备份遵循 collection→data 固定锁顺序，损坏采集清单使完整备份失败。
- 已有云日志桥的配置只开放有界轮询、发送、批量和队列参数，保留私有来源、端点、凭据与游标。API 写期望版本；实际 daemon 应用后发布带版本、参数、更新时间的回执。界面分别展示期望/实际参数，过期或失败回执不得仅因版本相同宣称当前生效。发布独立 daemon 时另核对其真实脚本哈希，原子替换脚本及 helper，保留旧脚本与单元配置供回滚。
- 在真实 shell 上检查响应式工作区。已验证 grid 默认的 auto 最小宽度会被可滚动子导航撑开；根容器使用 `minmax(0,1fr)`，子导航设最小宽度零与最大宽度100%。原生浏览器检查390、720/721和桌面宽度、明暗主题、真实原生参数表单及模块到资产的完整跳转。
- 工作区接入后同时验证主控制台全局刷新与自身刷新，持续任务需要有界自动读取。定时回调避开表单焦点、打开对话框与busy状态，隐藏/身份重置清定时器，已排队回调再次检查visible/loaded/auth，权限失效停止自动重试。真实页面可能有多段内联script；遍历并解析全部脚本，再按特征定位主应用脚本检查接线，不能把首个主题脚本当作主应用缺功能。


## Studio 相机双服务切换

相机账号桥同时变更 Studio 主备和 d-obs 时，可复用 [成对发布控制器](scripts/paired-release-controller.py) 与 [隔离测试](scripts/paired-release-controller.test.py)。先生成实际 live baseline 和最小 payload/manifest，再执行 prepare；正式候选在实际生产 Node 下完成模块及成对 HTTP/Python/ZIP 证明后才执行 activate。控制器的两份 proof 必须绑定同一对候选根、manifest、文件哈希和测试日志；可要求前端保留与 namespace 浏览器 QA 证据哈希。

prepare 不生成密钥、不切 current；新增 namespace 的基线检查允许不存在的父目录，但不能创建基线目录或穿越 symlink。`cp -al` 后每个覆盖目标须先 unlink。activate 只创建任务专用的私有账号桥配置与三个 drop-in，按 d-obs、Studio standby、primary 顺序核验 actual PID/cwd/Node/health。失败或手工 rollback 只恢复仍属本任务的 current 和配置；保留原始软链文本，遇到后续发布拒绝覆盖。15 项控制器隔离测试与本次真实 prepare/activate 已执行通过；回滚路径仅隔离测试通过，没有为验收而操作生产回滚。

编译产物测试的证明须把测试时的 runtime inventory 与本次 manifest 逐项比较，再填写 proof；只验证候选路径及 `passed` 自报字段不足以绑定实际字节。前端 QA 及下载包分别绑定各自的真实哈希，任何文档或 ZIP 修改后生成新候选并重跑对应正式门禁，保留已冻结旧候选。

Node 22 模块测试已遇到：断言全部通过，但旧生产 `sso.js` 在导入时启动的 `startSsoSessionExpirySweep` 60 秒 interval 保持进程存活，新源码的 unref 行为不能代表线上基线。先记录创建调用栈与 active resources；隔离测试可复用 [精确维护 timer fixture](scripts/studio-test-import-timers.mjs)，通过环境指定测试镜像 compiled dist 和实际 sso.js SHA，并在测试 after hook 调用其生命周期 finish。它只清理匹配函数、文件路径、SHA 和 delay 的该 interval，不清未知 timer、不强制退出、不改生产 SSO。子进程独立进程组、有界 timeout、实时落日志，外层 deadline 长于内层；超时后清理本任务残留组，保留失败证明。
