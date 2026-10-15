# 链路页面组件与使用方式

链路详情以本次运行的对话为主要阅读区。运行结果和采集覆盖状态在上方；调用瀑布、关联证据和运行上下文按需展开。运行列表与会话列表复用同一套详情和正文组件。

实现沿用项目的 TypeScript + 服务端组装 HTML + 原生 DOM 架构。浏览器 renderer 在现有页面脚本作用域内调用，不增加另一套前端运行时。

## 组件结构

| 组件 | 职责 | 实现 |
| --- | --- | --- |
| Trace workspace | 列表、筛选、分页、运行/会话切换 | `server/monitoring/observability-page-script-traces.ts`、`observability-page-script-native-sessions.ts` |
| Trace detail | 加载、刷新、失败、关闭、焦点与阅读状态 | `server/monitoring/observability-page-script-traces.ts` |
| Bound conversation | 展示权威会话绑定、本轮精确归档和此前会话记录 | `renderTraceBoundConversation`、`server/observability/run-conversation-context.ts` |
| Trace conversation | 按服务端 span 时间整理本次运行的五类正文，包含模型实际输入快照 | `server/monitoring/observability-page-script-trace-content.ts` 的 `renderTraceConversation` |
| Trace content item | 角色、序号、正文、复制、格式切换、长内容、来源 | 同文件的 `renderTraceContentItem` |
| Trace span content | 在单个 span 下复用正文条目 | 同文件的 `renderTraceSpanContent` |
| Presentation | 阅读排版、深色主题、焦点、响应式与触控尺寸 | `observability-page-trace-content-style.ts`、`observability-page-trace-workspace-style.ts` |

运行详情负责请求与身份边界；正文组件只接收已获权限的 DTO。正文从 `span.content` 读取，不从公共属性、摘要或时间相邻的候选片段推断。切换账号、租户或运行时清除阅读状态；同一运行刷新时保留展开状态、滚动和焦点。

## Props

类型与默认值见 `server/monitoring/observability-page-trace-content-types.ts`。

```ts
interface TraceContentEntryProps {
  entry: {
    kind: 'user_input' | 'model_input' | 'model_output' | 'tool_input' | 'tool_output';
    text: string;
  };
  content?: { redacted?: boolean; truncated?: boolean };
  source?: {
    spanName?: string;
    spanRef?: string;
    traceRef?: string;
    sessionRef?: string;
    runRef?: string;
    turnRef?: string;
  } | string;
  entryKey: string;
  sequence?: number;
  options?: TraceContentRenderOptions;
}
```

`entryKey` 标识当前渲染位置，必须稳定且唯一。对话汇总和单 span 详情使用不同的命名空间，避免同一份内容在两处出现时共享了展开状态。

| Option | 默认值 | 用途 |
| --- | --- | --- |
| `previewCharacters` | `1200` | 仅控制显示预览，完整已返回原文仍可展开和复制；有效范围 80–4000 |
| `formatJson` | `true` | 合法对象/数组 JSON 提供保留原值的缩进视图和原文视图 |
| `maxJsonDepth` | `24` | 过深 JSON 回退原文，避免缩进膨胀；有效范围 2–64 |
| `maxFormattedCharacters` | `24576` | 格式化长度上限，超过后回退原文 |
| `initialOpen` | 按角色 | 可覆盖单条默认展开行为；用户输入/最终回复展开，工具参数/结果和明确的模型工具调用折叠 |
| `conversationOpen` | `true` | 对话汇总默认展开 |
| `toolOpen` | `false` | 工具内容默认按需展开 |
| `showSource` | `false` | 来源说明默认折叠 |
| `showSequence` | `true` | 显示阅读顺序 |
| `copyText` | 浏览器 Clipboard API | 可注入宿主复制能力，接收完整已返回原文；Promise 失败会显示失败提示 |
| `roleLabel`、`title` | 组件内置文案 | 覆盖角色或汇总标题，按纯文本显示 |
| `loading`、`error` | 无 | 汇总组件的加载与失败状态，不展示未成功读取的正文 |

复制不撤销脱敏，也不补回服务端已经截断的内容。“展开长内容”只是阅读操作，和服务端 `truncated` 状态分开表达。

## 使用示例

以下调用用于现有浏览器页面脚本作用域；`parent` 是现有 DOM 容器，`detail` 是带权限的运行详情响应。

```js
// 整次运行：自动整理用户输入、模型回复、工具参数与结果。
renderTraceConversation(parent, detail, {
  title: '对话与工具内容',
  previewCharacters: 1200,
  toolOpen: false,
});

// 复用单条工具参数组件。字串是原始返回 DTO，复制时保持原样。
renderTraceContentItem(parent, {
  entry: { kind: 'tool_input', text: '{"query":"RDK X5"}' },
  content: { redacted: false, truncated: false },
  source: { spanName: 'moss.tool.invoke', spanRef: 'span-example' },
  entryKey: 'custom:tool-input:span-example:0',
  sequence: 1,
  options: { initialOpen: true, showSource: false },
});

// 在宿主已有复制能力时显式注入，不依赖浏览器权限。
renderTraceContentItem(parent, {
  entry: { kind: 'model_output', text: '已完成只读检索。' },
  entryKey: 'custom:model-output:span-example:0',
  options: { copyText: originalText => hostClipboard.writeText(originalText) },
});

// 组件可以独立展示尚未读取或失败状态。
renderTraceConversation(parent, null, { loading: true });
renderTraceConversation(parent, null, { error: '服务暂不可用，请重试。' });
```

## 状态、可访问性与边界

- 普通正文保留换行并使用阅读字体；JSON 和原文都以 `textContent` 呈现，不执行 HTML、链接或 Markdown。
- 有正文的后台刷新保持内容可读；失败标明当前内容来自上次成功读取，权限拒绝清除正文。
- 没有匹配项、没有采集正文、正文过期、数据不可用与读取失败分别表达，不转成“健康”或零值。
- 原生 `details/summary` 支持键盘；正文滚动区、复制和格式切换有可辨识名称、焦点样式及状态反馈。固定详情使用非模态 `dialog`（`aria-modal=false`），Tab 在可见控件之间循环，Escape 关闭后返回对应运行/会话入口；外部导航仍可点击。
- 新增 Trace 控件采用至少 44 px 触控高度；窄屏单列，长引用可换行，使用已有亮暗主题变量并尊重减少动态效果偏好。
- JSON 格式化需要保持数值、重复键与字符串原值。合法性验证和展示格式化分离；过深或过大的结构回退原文，避免显示膨胀。

## 验证范围

本轮使用实际 `OPS_OBSERVABILITY_HTML` 和现有脚本的本地合成 fixture 验收。预览明确标记非生产数据与凭据；未实现接口和所有写入接口返回 503。它用于界面行为验证，不代表生产接口、登录或部署验收。

2026-10-12 实际验证：

- `npm run typecheck`：exit 0。
- `node_modules/.bin/tsc -p tsconfig.json --noEmit false --outDir /tmp/dobs-ui-review-20261012/compiled`：exit 0；从编译产物组装页面，2 个内联脚本语法检查通过。
- `node --import tsx --test server/monitoring/observability-page-*.test.ts`：167/167 通过，exit 0。覆盖正文、刷新、身份切换、键盘、导航和可见面测试。
- CUA：1440 桌面、390 手机、720/721 断点往返，亮暗主题；列表与共享详情无横向溢出。实际检查复制后焦点、详情刷新保留原文视图与滚动、Tab 边界、运行/会话 Escape 返回、加载/403/503/过期/空状态、长 JSON 完整展开与恶意纯文本。
- 以上是本地 UI 优化阶段的验证记录；随后完成的生产发布与全量检查见下文。此前业务站的全量检查结果不属于本轮 UI 验证结论。

浏览器记录与命令日志位于 `/tmp/dobs-ui-review-20261012/`；截图作为本次聊天附件交付。

## 生产发布与验收（2026-10-12）

当前 d-obs release：`/opt/d-obs/releases/trace-ui-content-20261012T042330Z-poll`。生产入口为 `https://rdkstudio.d-robotics.cc/dobs/ops-observability#traces/runs`。

发布时发现后续整站发布覆盖了已验收的正文读取与原生会话能力。仅恢复 7 个此前验收的 Trace 模块，再发布 UI 组件与必要挂载补丁；后续密度样式发布完整保留。最终轮询补丁只更新两个脚本，其余 353 个文件与当时的生产基线一致，worker 和 Collector 保持原版本。

指定 UUID Run 搜索的轮询与手动刷新现在沿用相同筛选。取消在途请求保留已确认的搜索标记，迟到的旧搜索响应不能覆盖新查询；身份、租户和时间窗口变化仍清理旧状态。回归测试执行实际 `loadAll → setView → refreshTraceSearch`：旧版本 3 项失败，新版本 4 项通过。

- 最终全量 `npm test`：593/593 通过，类型检查、构建均 exit 0；依赖审计 0 漏洞，依赖声明与 lockfile 未改。
- 实际生产运行 `run-546347e5c5893790`：9 spans、完整链路，5 项正文（用户输入 1、模型输出 2、工具参数 1、工具结果 1）；工具查询 `RDK X5` 保留正常。
- 原生会话接口带权限 200、未授权 403；健康与就绪检查 200，公网和源站 HTML 一致，发布后的错误日志新增 0 条。
- CUA 正常登录读取真实数据，检查对话展开、原文复制和焦点、会话下钻与 Escape 返回、390 手机暗色和 1440 桌面亮色无横向溢出。已采集的正文可以查看，历史未采集内容仍明确显示缺失。

持久发布清单、命令退出码、候选反例、线上摘要和截图位于 `output/trace-ui-release-20261012/`。`final-production-sanitized-summary.json` 不包含正文、令牌或 locator，可用于核对本次上线。

## 对话上下文强绑定（2026-10-12，本地新增）

查询链固定为账号 + 环境 → canonical Run → canonical session → 本轮归档与此前记录。详情接口返回 `conversationContext`，以已验证 Run locator 和服务端 Run fact 为入口；账号、环境和会话不从查询参数、展示名或相邻时间推断。列表与详情使用相同 `scopedDisplayRef` 生成会话引用。

- `currentTurn` 必须由归档 `run_id` 精确匹配，且 `session_id` 与 Run fact 一致。同一 Run 对应多个归档或会话冲突时，返回 `conflict` 并隐藏关联正文。
- `history` 返回相同账号、显式环境、会话在 Run 开始前的最近 8 轮归档，按时间正序展示。它是此前会话记录，不能等同于模型实际收到的上下文。
- `model_input` 正文条目用于采集实际发送到模型的 messages/context 快照，包括保留的角色与顺序。沿用脱敏和字节限制；缺失和截断会明确显示。`#N` 是采集项阅读顺序，不是模型或会话轮次编号。
- 正文读取限 7 天，归档元数据查询限当前时间之前的 35 天，遵守删除 tombstone；旧记录缺少显式环境或 Run 标识时不猜测回填。模型输入快照也沿用现有独立正文过期策略。
- 摄取拒绝同一 Run 被重新绑定到另一个会话；同一标识域内的别名必须一致。显式 `rdk.session.id` 是客户端对话 ID，`moss.session.id`/`sessionKey` 是内部 Agent 会话键，不能互相比较或按前缀猜测转换。旧 span 缺少显式客户端绑定时，详情依照权威 Run fact 查询归档。OTLP `gen_ai.conversation.id`/`conversation.id` 只映射 session，不作为 Run ID。同 Run 的不同 Trace 保持原 trace ID。

上游 Studio 集成已补齐两处接线：

1. 运行结束归档时把生命周期中的权威 `runId` 写入 `ConversationTurnRecord.runId`；HTTP `/api/telemetry/conversation` 摄取允许透传 `run_id`，账号和环境继续由服务端解析。
2. 每次模型请求创建 `model_input` 条目并附到同一 Run/session 的模型 span，例如 `createStudioTraceContentEntry('model_input', { messages: actualProviderMessages })`。必须采集实际 provider 请求；不能用归档时间线拼出快照。

本仓库新增了归档字段、中心写入和详情查询支持；Studio 对话生命周期、中心 `/api/telemetry/conversation` handler 与模型输入采集位于独立 Studio 仓库，本次同步修改了对应接线。上线先执行 `tools/conversation-trace-binding-schema.sql` 的增量迁移，再发布 d-obs 与 Studio 采集端。旧数据未采集正文无法补回。该新增能力的实际发布与验收记录见下方。

长标识也沿用精确关联：d-obs 读取保留完整的 200 字符客户端会话 ID；Studio 在生成受限元数据前，私下保存并校验完整 Moss 内部会话键。不同完整键即便前 200 字符相同，也不能挂载正文。原始校验映射不进入批次或外部追踪状态。

本次本地验证：d-obs 类型检查与全量 722 项测试通过；Studio 全量 303 个文件、1764 项单元测试通过，长会话原生链路聚焦 17 项及服务端类型检查通过。实际 Studio 合成批次经 d-obs 消费验证：6 spans、4 段模型输入，客户端对话绑定一致，内部键保持独立。Node 25 的 Vitest 验证通过 `--no-experimental-webstorage` 避免宿主原生 localStorage 干扰浏览器测试环境。

持久记录位于 `output/conversation-binding-verification-20261012/`。本次本地验证之后已按真实线上基线组装最小 overlay 发布；具体结果见下方。上游既有 `check-production-release-contract.mjs` 断言仍失败：其正则拒绝已提交 worker 重启脚本中的 deliberate-noop 分支；两个文件均未由本次改动修改。该发布门禁未标记通过。


### 具体对话正文上线（2026-10-12）

d-obs 的 `conversation-body-20261012-1800` 与 Studio 的 `conversation-body-20261012-1805` 已切换。d-obs 发布 16 项必要 JS，Studio 发布 24 项必要 JS；沿用实际线上依赖和入口安全补丁，Studio 先验证 standby 18091 再更新 primary 18090。两服务源站与公网健康通过，发布未修改 Collector、worker 或账号权限。

正文默认展开并排在运行指标前，旧上下文摘要改为运行元信息。精确 d-obs 候选 81 项、Studio 候选 71 项测试通过，UI 聚焦 58 项通过；真实保护读取验证 user_input/model_output 正文、会话与 Run 引用一致、匿名拒绝、缺少上下文 guard 拒绝、篡改 locator 拒绝。新增归档列与索引迁移成功，没有回填旧记录。

两轮真实新模型对话尚未验收：生产已有板卡门禁返回 `STUDIO_BOARD_REQUIRED`；canary 无可见板卡，当前正常网页账号板卡离线，模型未被调用。没有为验收绕过门禁。已上线的 model_input 捕获通过精确候选测试，但不能把历史正文读取成功当作新模型输入与新归档的线上验收。

持久 manifest、源站/公网回执、迁移记录与候选测试位于 `output/conversation-content-release-20261012/`。追加只读验收确认：真实分页接口和线上编译脚本均完成 40→80 条加载，精确 Run 查询返回 1 条。浏览器登录门需要正常重新登录，未因此修改鉴权。d-obs 最终 current 为 `conversation-body-browser-20261012-1820`（仅补充有界错误码 DOM 诊断属性），线上页面内嵌 2 段脚本解析通过，旧“不展示正文”提示已消失。
