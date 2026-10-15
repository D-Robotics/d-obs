# RDK X5 端侧文本模型接入

d-obs 的「端侧大模型」模块把板端探测、Qwen 文本模型部署、CPU 性能测试和停止操作登记为持久化任务。平台管理身份、可信目标和回执；X5 上的 runner 执行固定操作。任务报告保留模型摘要、运行时版本和实测来源。配置了目标只代表接入配置存在，真实板端连接、部署和性能仍须逐项验收。

工作台入口是 `/ops-observability/edge-llm`，API 根是 `/api/ops/observability/edge-llm`。如果部署公开基址含 `/dobs`，浏览器和外部 API 请求均加此前缀；MCP 的 `operationId` 保持目录返回的原始值。模块使用运营身份，当前不向租户公开；MCP 接入约定见 [平台助手](./platform-assistant.md)。

## X5 准备与固定运行时

在真实 X5 的 Linux arm64 系统上准备 Node.js 22、Git、CMake 和 C++ 编译器。先检查 `node --version`、`uname -m`、`git --version`、`cmake --version`、`c++ --version`；Node 和编译工具安装由设备管理员按板上发行版处理。模型文件大小之外还需要运行时、KV cache、临时下载和日志空间，文件大小不能当作峰值内存需求。

示例使用独立系统用户 `rdk-edge-llm`，目录如下；所有权必须与 service 中的用户一致。

| 路径 | 用途 | 权限 |
| --- | --- | --- |
| `/opt/rdk-edge-llm/edge-llm-runner.mjs` | 从本仓库 `tools/` 安装的 runner | root 管理，用户可读 |
| `/opt/rdk-edge-llm/runtime` | 固定源码版本构建的 llama-server | 构建期间由专用用户可写，运行时只读 |
| `/etc/rdk-edge-llm/runner.json` | 本仓库示例的私有副本 | 专用用户所有，`0600` |
| `/etc/rdk-edge-llm/token` | runner Bearer token | 专用用户所有，严格 `0600`，普通文件 |
| `/var/lib/rdk-edge-llm` | 任务台账、模型和运行时日志 | 专用用户所有，`0700` |

先创建专用用户及目录，并将 `tools/edge-llm-runner.mjs`、`tools/edge-llm-bootstrap.sh` 安装到 `/opt/rdk-edge-llm/`。模型目录为 `/var/lib/rdk-edge-llm/models`，也设为 `0700`。不要让其他用户写入配置、token 或状态目录，也不要用符号链接代替这些私有文件。

本例固定 [llama.cpp v0.6.0 的源码提交](https://github.com/ggml-org/llama.cpp/commit/d81235049384534c167caea52b85a694f6103d14)，不使用浮动 `master`。以下命令由设备管理员安排在 X5 上以专用用户执行；它下载和编译运行时源码，不下载模型：

```bash
sudo -u rdk-edge-llm env \
  LLAMA_CPP_REF=d81235049384534c167caea52b85a694f6103d14 \
  RDK_EDGE_LLM_PREFIX=/opt/rdk-edge-llm/runtime \
  LLAMA_CPP_BUILD_JOBS=4 \
  bash /opt/rdk-edge-llm/edge-llm-bootstrap.sh
```

bootstrap 要求显式 commit/tag，安装后写入 `llama-commit.txt` 并打印版本。CPU 构建方式见 [llama.cpp 官方构建文档](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/docs/build.md)。当前构建选项使用 `LLAMA_OPENSSL`；旧 `LLAMA_CURL` 已弃用。禁用预构建 Web UI 的获取可避免额外的 UI 下载依赖；runner 自身通过 Node.js 下载管理员配置的模型。

## 模型配置与完整性

复制 [runner 配置示例](../ops/edge-llm/runner-config.example.json) 到私有配置路径。示例只有公开模型元数据和安装路径，不包含 token。`binary`、`modelDir`、`models[].path` 必须为绝对路径；模型路径须位于 `modelDir` 内。`port: 8086` 是 llama-server 的回环端口；`threads: 4`、`contextSize: 2048` 是初始配置，需要在板上实测后调整。

两款文件均来自 Qwen 官方 Hugging Face 仓库。下表固定文件上传提交；SHA-256 是原始模型字节的 LFS `oid`，不是 Xet hash。公开元数据于 2026-10-13 核对，尚未下载这些模型。

| 模型 | 文件 | 固定 revision | 精确字节数 | 官方证据 |
| --- | --- | --- | ---: | --- |
| Qwen2.5 0.5B Instruct Q4_K_M | `qwen2.5-0.5b-instruct-q4_k_m.gguf` | `6dd44a1fb35d11b5d1b28902876ce3cc9e882d0e` | 491400032 | [提交中的 LFS 指针](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/commit/6dd44a1fb35d11b5d1b28902876ce3cc9e882d0e)、[官方文件页](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/qwen2.5-0.5b-instruct-q4_k_m.gguf) |
| Qwen2.5 1.5B Instruct Q4_K_M | `qwen2.5-1.5b-instruct-q4_k_m.gguf` | `dd26da440ef0330c47919d1ecae0966d24022222` | 1117320736 | [提交中的 LFS 指针](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/commit/dd26da440ef0330c47919d1ecae0966d24022222)、[官方文件页](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/main/qwen2.5-1.5b-instruct-q4_k_m.gguf) |

```text
0.5B SHA-256: 74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db
1.5B SHA-256: 6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e
```

管理员可以预先把经过校验的完整 GGUF 放到示例 `path`；此时可删除该模型的 `url` 和 `redirectHosts`，离线使用。也可以保留固定 revision 的 HTTPS `url`，由用户发起 `deploy` 后按需下载。浏览器和 MCP 不接收任意模型 URL、下载域名或 shell 命令。

runner 对下载执行有界重定向，只允许配置中精确列出的 HTTPS hostname，最终仍校验 GGUF、SHA-256 和文件大小。示例允许 `huggingface.co` 和 `cas-bridge.xethub.hf.co`；后者在 [Hugging Face 官方迁移说明](https://huggingface.co/blog/migrating-the-hub-to-xet) 中有明确依据，但这两个模型本轮的实际下载链路尚未验证。若官方 CDN 更换域名，下载应拒绝，管理员核对实际目标域名后再更新精确白名单，或预先校验并放置模型。不要加入通配域名，不保存短期签名 URL，不把 runner Bearer token 传给模型 CDN。

## 私有 token 与服务

用安全随机数生成至少 24 字符的 runner token，例如由管理员在 X5 的私有目录执行以下命令，再将文件所有者设为 `rdk-edge-llm`。不要把 token 写到仓库、配置示例、浏览器或日志。

```bash
umask 077
openssl rand -hex 32 > /etc/rdk-edge-llm/token
chmod 600 /etc/rdk-edge-llm/token
chown rdk-edge-llm:rdk-edge-llm /etc/rdk-edge-llm/token
```

检查 Node.js 22 实际安装路径；[systemd 示例](../ops/edge-llm/rdk-edge-llm-runner.service) 默认用 `/usr/bin/node`，需要按设备修改后安装。启动 service 只启动控制服务，不自动下载、部署模型或执行 benchmark。手动运行时使用相同字段：

```bash
RDK_EDGE_LLM_CONFIG=/etc/rdk-edge-llm/runner.json \
RDK_EDGE_LLM_TOKEN_FILE=/etc/rdk-edge-llm/token \
RDK_EDGE_LLM_STATE_DIR=/var/lib/rdk-edge-llm \
RDK_EDGE_LLM_PORT=8876 \
node /opt/rdk-edge-llm/edge-llm-runner.mjs
```

`RDK_EDGE_LLM_PORT` 是控制端口，默认 `8876`。控制服务和由 runner 启动的 llama-server 均固定监听 `127.0.0.1`；推理强制 CPU。runner 只管理自己启动的子进程，已被占用的推理端口会被拒绝。

## d-obs 到板端的可信连接

在 d-obs 主机上由运维维护 SSH 隧道，映射到 X5 控制服务。核对 SSH host key，使用专用 SSH 身份；下面仅是连接模板：

```bash
ssh -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18876:127.0.0.1:8876 \
  <ssh-user>@<x5-host>
```

这样 d-obs 请求自身的 `127.0.0.1:18876`，再经 SSH 到板端回环端口。另一种方式是在可信入口使用证书可验证的 TLS 代理，并固定服务端配置的 HTTPS URL；代理转发到 X5 的回环端口。不要把控制服务改为裸 HTTP LAN 监听。

在 d-obs 服务端通过私有环境配置适配器。以下 token 只是占位符，实际值来自私有凭据注入，须与板端 token 相同：

```bash
RDK_EDGE_LLM_ADAPTERS='[{"id":"x5-lab","label":"X5 CPU 文本模型","board":"X5","url":"http://127.0.0.1:18876","token":"REPLACE_WITH_PRIVATE_RUNNER_TOKEN_24_CHARS_MIN"}]'
```

TLS 连接可将 `url` 改为固定的 `https://runner.example.internal`。平台只接受回环 HTTP 或 HTTPS；不给客户端传地址、端口或凭据的能力。`RDK_EDGE_LLM_STATE_DIR` 在 d-obs 主机上表示平台任务台账目录，在 X5 上表示 runner 状态目录；两者位于各自主机，均使用私有目录，不能共用一个台账。

## 平台 API 与 MCP 操作

使用当前运营身份调用 API。变更请求必须携带 HTTP 头 `x-rdk-ops-action: observability`；只读执行会拒绝变更。凭据传递沿用部署现有 SSO/API 接入方式，不放到任务 JSON 中。

| 方法与路径（相对 API 根） | 用途 |
| --- | --- |
| `GET /capabilities` | 发现服务端配置的目标和固定操作 |
| `GET /targets/x5-lab` | 读取 runner 真实目录、运行时可用性和当前部署健康 |
| `POST /jobs` | 登记 `probe`、`deploy`、`benchmark` 或 `stop` |
| `GET /jobs` | 读取当前账号的任务 |
| `GET /jobs/<job-id>` | 查询同一任务 ID，并更新真实回执 |
| `GET /jobs/<job-id>/report` | 下载该账号的 JSON 证据报告 |

首次接入先发 `probe` 并查询完成回执，再读取目标目录。`deploy` 和平台层 `benchmark` 必填 `modelId`，必须使用目标目录返回的 ID；`probe` 和 `stop` 不传 `modelId`。部署成功且目录显示同模型 ready 后才发 benchmark。切换模型须先执行 stop 并核对其回执。

```json
{"targetId":"x5-lab","operation":"probe"}
```

```json
{"targetId":"x5-lab","operation":"deploy","modelId":"qwen2.5-0.5b-instruct-q4_k_m"}
```

```json
{"targetId":"x5-lab","operation":"benchmark","modelId":"qwen2.5-0.5b-instruct-q4_k_m"}
```

```json
{"targetId":"x5-lab","operation":"stop"}
```

外部 Agent 使用 `POST /api/ops/mcp`，先通过目录发现准确的 operationId：

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_platform_capabilities","arguments":{"search":"edge-llm"}}}
```

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "execute_platform_operation",
    "arguments": {
      "operationId": "POST /api/ops/observability/edge-llm/jobs",
      "body": {"targetId":"x5-lab","operation":"deploy","modelId":"qwen2.5-0.5b-instruct-q4_k_m"}
    }
  }
}
```

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"execute_platform_operation","arguments":{"operationId":"GET /api/ops/observability/edge-llm/jobs/:id","params":{"id":"REPLACE_WITH_RETURNED_JOB_UUID"}}}}
```

部署命令不会发布 d-obs、更新系统软件或执行板端运动。平台注册任务使用 `rdk.edge-llm.v1`，板端协议使用 `rdk.edge-llm-runner.v1`；后者的 `/catalog`、`/jobs`、`/jobs/:id` 均需 runner Bearer token，由平台适配器调用。

## 未知结果与重启

HTTP `202` 只代表任务已登记。`submitting`、`queued`、`running`、`unknown` 都不等于完成。收到任务 ID 后查询同一 ID；超时、断连或回执丢失时也只查询，不重新提交 deploy/benchmark。

runner 重启会把未完成的旧任务标为 `unknown`，当前部署重新视为未确认，不自动重放旧任务、加载模型或恢复 benchmark。保留原状态目录和报告；不要删台账或生成新 ID 来掩盖不确定结果。查询失败和 runner 不可达应保留错误，不填充成功指标。

原任务持续未知时，界面的「恢复设备状态」提交固定 `stop` 操作；API 使用前面的 stop 请求即可，客户端不传 `abandonJobIds`。平台只允许恢复已是 `unknown` 且没有发送仍在进行的旧任务，并在内部绑定精确的旧任务 ID 集。runner 先持久化这些 ID 的拒绝重放记录，只停止自己拥有的模型进程，再确认推理端口已释放。端口仍被其他进程占用时恢复失败，运维须查明进程归属，runner 不会杀掉其他服务。

平台验证 stop 回执中的旧 ID 集与 `inferencePortAvailable: true` 后，旧任务标记为 `superseded`，其 `outcome` 仍为 `unknown`，并保留原证据。停止恢复成功后重新读取目标目录，再由用户显式提交新的 deploy；旧任务不会重放。恢复操作自身超时也查询其原任务 ID，直到真实回执确认。

## 性能报告与板端验收

`qwen-text-smoke-v1` 使用固定中文提示词，先做一次应用层预热，再记录三个测量案例；生成上限为 96 token。它是性能与文本输出可用性检查，报告中的 `accuracyEvaluated: false` 表示没有评估模型精度。

首字延迟 `ttftMs` 来自 runner 的单调时钟，从发出流式请求到收到首个有效文本内容；整体请求耗时 `totalMs` 含预填充、生成和协议开销。token 数只采用运行时 `usage`/`timings`，缺失时明确留空。运行时生成速度与包含 TTFT 的请求平均速度分开报告，以 `rateDefinition` 为准。服务端 `prompt_ms` 是 prompt 计算耗时，不能代替 TTFT；不要用字符数换算 token。计时字段见 [llama-server 官方协议](https://github.com/ggml-org/llama.cpp/blob/v0.6.0/tools/server/README.md)。

benchmark 显式关闭 prompt cache，固定单并发、线程数和上下文；应用层预热不代表操作系统页面缓存、温度或 CPU 频率一致。比较性能时必须保留模型 SHA、运行时源码版本、线程/上下文配置、实际输出 token 数和各案例结果，不以一次烟测声称精度通过、长期稳定或 BPU 加速。

真实 X5 验收需保存 probe、目录、deploy 和 benchmark 报告，确认架构/设备身份、完整模型摘要、健康状态和非空输出；再验证 stop、runner 重启以及连接中断时的真实行为。当前交付是可接入模块与配置示例，板端最终结论仍等待真实设备连接和上述证据。任何模拟 runner 或本机测试都不能替代 X5 性能报告。
