# 插件中心与声明式 SDK

插件中心把数据源、面板、只读工具、诊断工作流和提示词放进一个可导入、编辑、发布和回滚的 JSON 包。入口为可观测工作台“配置与管理”中的“插件与诊断”（`/ops-observability#plugins`）。页面沿用工作台登录、账号权限与租户上下文；实际执行仍经过原业务 API 的访问校验。

这一版建立了可运行的声明式插件宿主。身份、权限、业务路由、存储适配器和模型执行循环仍由平台内核负责。插件包不能运行任意 JavaScript。启用插件的已发布提示词会加入当前账号平台助手的业务上下文，核心权限与系统规则仍由平台内核负责。

## 使用流程

相机插件模板为「相机点亮与 ISP 助手」（`camera-workshop`）。其知识、真实能力、实验账本和
readiness 面板使用受现有权限保护的 GET；助手指引引导授权后的点亮/调参使用核心视觉工具，
声明式宿主仍保持只读。知识状态、适配器配置、真机操作和画质验收分别记录。
可导入 `output/plugins/camera-workshop.json`；生成命令为
`node --import tsx tools/package-camera-workshop.mts`。不会自动安装、启用、连接板卡或上线。

RDK Studio 原生包源码位于 `plugins/rdk-camera-workshop/`，与上述 JSON 包格式不同。
包含技能与独立 Node stdio→d-obs MCP 连接器；私有连接配置留在包外。
用户主项目的现有原生 companion 目前只接本机 loopback 工作台，远程/云接入不据此宣称可用。
安装包不提供 IMX415 Sensor 驱动、真实 Bayer RAW 或 X5 原生 ISP adapter；这些仍需单独接入与实机验收。

1. 打开“模板”，选择一个真实模板；也可以“导入包”，粘贴或读取 `{manifest, config}` JSON。
2. 模板先展示能力概览和基础配置表单，支持直接填写版本及简单参数；完整 Manifest 和配置 JSON 按需展开。首次创建保存草稿即可；已安装插件的 `id` 固定。
3. 保存草稿后点击“校验并发布”。发布校验字段、引用、配置 Schema、只读来源及依赖，成功后启用该版本。失败时保留旧版本。
4. 在“运行与诊断”中查询面板、调用工具或提交只读工作流。查询显示真实数据与来源、耗时、时间等回执；没有数据、来源失败和未启用分别显示。
5. 已发布插件默认展示运行诊断，修改时展开“编辑与发布”。升级先提升 `manifest.version`，可使用显式的下一补丁版本操作，再保存并发布；预发布版本手动填写。历史中可回滚。停用中止本插件在途执行；卸载前可导出包，随后在页面明确确认。

编辑的是草稿，面板和诊断使用已发布版本。发布过的版本内容不可修改；改变配置也要提升版本。相同账号下切换插件、刷新及冲突重读会保留未保存编辑；切换账号或租户会取消在途请求并清除浏览器内存里的私有数据与未保存编辑。已保存草稿保存在服务端。未保存内容不会写入浏览器持久存储。

保存回执只确认已经提交的编辑快照，等待期间的后续输入不会被旧响应覆盖。需要放弃当前插件的本地编辑时，可明确确认“恢复服务端内容”，不影响其他插件草稿，也不会自动写入 API。

同一身份和已发布包下，刷新保留最近诊断回执、参数和展开状态，并标明上次查询时间；刷新不会自动重跑工作流。发布内容改变、停用、卸载或身份/租户切换时清除相应缓存。缓存仅在内存中有界保存，超限会明确提示未缓存。查询失败保持失败状态，不恢复成旧成功值。对象键重排不构成已发布内容变化；实际字段值和数组顺序改变仍需新版本。

发布、启停、回滚和卸载使用 `expectedRevision` 防止覆盖并发更新。出现冲突后，页面允许“刷新服务端版本并保留编辑”，用户核对当前 revision 后再保存。导出的是当前编辑包，运行回执不包含在导出文件中。

## 包格式

类型定义在 [`server/plugins/plugin-types.ts`](../server/plugins/plugin-types.ts)，验证与生命周期在 [`server/plugins/plugin-runtime.ts`](../server/plugins/plugin-runtime.ts)。`schemaVersion` 当前为 `1`。

| 字段 | 用途 |
| --- | --- |
| `id` / `version` / `label` / `description` | 稳定标识、语义版本和展示信息。id 为小写字母开头，后续支持字母、数字、下划线和连字符，最多 64 字符。 |
| `dependencies` | `[{id, version}]`，当前为精确版本依赖。宿主校验启用状态、缺失依赖与循环依赖；依赖不会自动安装。 |
| `configSchema` / `config` | 配置对象的有限 JSON Schema 及其实际值。支持类型、对象属性、数组项、必填、枚举、范围和长度。复杂 `$ref`、组合 Schema 尚不支持。 |
| `tools` | 带 `inputSchema` 的只读工具；来源为当前权限允许的平台 GET 操作，或服务端配置的 MCP 连接器。 |
| `dataSources` | 引用同包 `toolId`，可声明 `args` 和从实际结果取值的 `resultPath`。 |
| `panels` | 引用 `dataSourceId`，支持 `stat`、`table`、`line`。`valuePath` 在数据源结果中取值，`unit` 用于展示，表格 `columns` 为 `{key,label}` 数组。 |
| `workflows` | 固定顺序的只读工具步骤；每步有 `toolId`、可选 `args` 和 `label`。运行返回逐步真实回执。 |
| `prompts` | 可编辑、随版本发布的 `{id,text}` 提示词资源。启用插件的已发布提示词经过脱敏后加入当前账号平台助手的业务上下文；草稿不生效，停用后移除。 |

完整字符串 `${config.deviceId}` 表示引用配置并保留实际值类型，不能拼接任意表达式。引用用于工具默认参数、数据源参数和工作流步骤参数。`resultPath`、`valuePath` 与表格 `key` 使用点分字段路径；不允许原型、构造器等保留字段。

下面的包读取已注册设备，并把结果展示成表格。它依赖当前账号已有的设备 API 权限和真实数据服务；中心库未配置时会明确报错。

```json
{
  "manifest": {
    "schemaVersion": 1,
    "id": "device-inventory",
    "version": "1.0.0",
    "label": "设备清单",
    "description": "读取已注册设备，核对设备标识、型号和状态。",
    "dependencies": [],
    "configSchema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    },
    "tools": [{
      "id": "list-devices",
      "description": "读取已注册设备",
      "inputSchema": {
        "type": "object",
        "properties": {},
        "additionalProperties": false
      },
      "source": {
        "type": "platform",
        "operationId": "GET /api/ops/observability/devices"
      }
    }],
    "dataSources": [{
      "id": "device-rows",
      "toolId": "list-devices",
      "resultPath": "data.devices"
    }],
    "panels": [{
      "id": "inventory",
      "title": "已注册设备",
      "dataSourceId": "device-rows",
      "kind": "table",
      "columns": [
        {"key": "deviceId", "label": "设备 ID"},
        {"key": "model", "label": "型号"},
        {"key": "status", "label": "状态"}
      ]
    }],
    "workflows": [{
      "id": "inspect",
      "title": "核对设备清单",
      "steps": [{"toolId": "list-devices", "label": "读取真实清单"}]
    }],
    "prompts": [{
      "id": "inspect-guide",
      "text": "依据实际清单与回执核对状态；缺少心跳数据时不要推断设备健康。"
    }]
  },
  "config": {}
}
```

平台工具的 `operationId` 必须是当前能力目录中的完整 GET 标识，例如 `GET /api/ops/observability/devices/:deviceId/samples`。参数沿用原 API 的结构：`{"params":{"deviceId":"rdk-x5"},"query":{"minutes":60}}`。在插件中声明匹配的 `inputSchema`；不能把请求头、身份或任意 URL 当作工具参数。

平台工具保留执行器回执 `{ok,status,data}`，其中 `data` 是原 API 的 JSON 正文。因此示例设备接口的取值路径为 `data.devices`，总览为 `data.overview`，日志为 `data.logs`。MCP 工具使用其实际结果结构，不自动套用平台路径。

助手按当前账号读取已启用插件的发布提示词，最多 24 个片段、总计 12000 个字符，以明确标记的非可信业务上下文提供给模型。这些片段不能授予权限、覆盖系统规则或制造工具调用成功。插件读取失败时助手会保留平台功能，并明确插件业务说明没有完整取得。只读插件工具、数据源和诊断工作流可通过助手的真实能力目录发现与调用。

数据源查询回执形状为 `{"ok":true,"result":{"pluginId":"…","version":"…","toolId":"…","dataSourceId":"…","data":实际结果,"receipt":{"id":"…","startedAt":"…","completedAt":"…","durationMs":8,"source":{…}}}}`。`data` 已按数据源的 `resultPath` 提取，面板的 `valuePath` 继续作用于这个值。

`stat` 接受数值或数字文本，亦可展示 `value`、`count`、`total` 字段或单条时序的最新值。`table` 接受行数组，或含 `rows`、`items`、`devices` 的对象。`line` 接受 `series:[{name,points:[{ts,value}]}]`（`ts` 为毫秒时间戳）及 Prometheus 的 `result/values` 格式（时间戳为秒）。不匹配的数据不会自动转换成 0；可展开完整回执核对。表格最多渲染 200 行，趋势最多显示 16 条序列、每条最后 2000 个点，回执保留服务端实际返回的数据。

## 外部 MCP

连接器由部署管理员在服务端环境中配置。插件包只引用 `connectorId` 和 `toolName`，不接收任意 URL、凭据或进程命令。

```json
{
  "evidence": {
    "url": "https://mcp.example.com/mcp",
    "readOnlyTools": ["inspect_device"],
    "credentialEnv": "EVIDENCE_MCP_TOKEN"
  }
}
```

将上面 JSON 配置为 `RDK_PLUGIN_MCP_CONNECTORS`，令 `EVIDENCE_MCP_TOKEN` 持有实际 bearer token。敏感值只保留在服务器环境中；连接器目录只显示 ID、配置是否就绪与工具白名单。

插件工具来源声明为：

```json
{"type":"mcp","connectorId":"evidence","toolName":"inspect_device"}
```

宿主执行 `initialize`、读取工具清单，并要求工具同时位于服务端白名单、声明 `readOnlyHint:true`、没有 `destructiveHint:true`。工具注释本身不能授予权限。连接器支持 Streamable HTTP 的 2025-03-26、2025-06-18 和 2025-11-25 协议版本，以及 JSON 和请求内 SSE 响应。连接器会限制响应大小、执行时间和分页，并在操作结束后尝试释放 MCP 会话。HTTPS 为默认要求，HTTP 仅允许 loopback；私网目标需显式服务器主机白名单 `RDK_PLUGIN_MCP_PRIVATE_HOSTS`。

本版不支持 stdio 子进程、后台 SSE 恢复、sampling、roots、elicitation，也未实现 2026 无状态传输。外部 MCP 未配置时显示未配置/不可用，不会伪造可调用工具。

## API 与部署

REST 根路径：`/api/ops/observability/plugins`。所有端点均受身份访问控制，插件的服务器状态按已解析的运营身份隔离；端点沿用已有租户权限。插件接口不为未登录或仅具租户只读权限的身份开放业务工具。

| 方法与后缀 | 请求 / 行为 |
| --- | --- |
| `GET /capabilities` | 宿主协议、适配器、生命周期、安全连接器目录。 |
| `GET /catalog`、`GET /` | `{plugins, templates}`，空清单只代表请求确实成功。 |
| `GET /:id` | `{plugin}`，包含 revision、草稿、发布版本、历史和启停状态。 |
| `POST /draft` | `{manifest,config,expectedRevision?}`，首次创建省略 revision，已有插件必填。 |
| `POST /:id/publish` | `{expectedRevision}`；校验保存的草稿后激活该版本。 |
| `POST /:id/enabled` | `{enabled,expectedRevision}`。 |
| `POST /:id/rollback` | `{version,expectedRevision}`，恢复历史版本与配置。 |
| `DELETE /:id` | `{expectedRevision}`；依赖约束不满足时拒绝。 |
| `GET /:id/data/:sourceId` | 可选 `args` query 为 JSON 对象；执行真实数据源。 |
| `GET /:id/tools/:toolId` | 可选 `args` query 为 JSON 对象；执行只读工具。 |
| `POST /:id/workflows/:workflowId/run` | `{args}`，固定发布版本按序执行，只读但仍要求操作保护头。 |

所有 POST、DELETE 需要工作台已有的 `X-RDK-Ops-Action: observability`，不能通过插件参数制造凭证或绕开原权限。服务关闭调用插件与 MCP 的释放函数，取消在途执行。

`RDK_PLUGIN_STATE_DIR` 指定持久化状态目录；默认位于服务用户的 `~/.local/state/d-obs/plugins`。状态按账号隔离，写入使用锁和原子替换。生产发布应让该目录位于可持久化的共享运行目录中，不能放在会被版本切换删除的 release 内；按现有运维策略备份。

当前限制：每个身份最多 32 个已安装插件，每个插件最多 20 个发布版本，包最多 128 KiB；工具、数据源、面板分别最多 32 个，工作流最多 16 个且每个最多 16 步。插件工作流只读，暂不支持写操作审批、条件分支、脚本执行、自定义前端代码、市场分发、自动依赖安装、跨账号共享和任意 Agent 运行时替换。要扩展采集器、模型适配器或物理设备动作，仍需内核或专门审批机制。

## 验证

页面测试运行实际内联脚本、DOM 和 fetch 行为，覆盖创建/发布/启停、回滚/卸载、参数提交、真实面板渲染、JSON 错误、版本冲突、来源失败、XSS 文本、只读状态和跨账号/租户迟到响应。宿主与 MCP 的测试覆盖持久化、依赖、并发修订、生命周期、只读来源和协议边界。

```sh
node --import tsx --test server/monitoring/observability-page-plugins.test.ts
node --import tsx --test server/plugins/*.test.ts server/monitoring/plugin-*.test.ts
npm run typecheck
```

这些命令描述可重复的验证流程；是否通过及生产验收结果以当次实际运行记录为准。
