# Studio 账号桥与原生工作区的软件验收

本流程用于用户要求“在 RDK Studio 内完成”时补全同源调用、账号隔离和无设备软件准备。
界面、知识检索、CPU 标定与实际设备执行分别验收。插件目录可见、后端发布或匿名接口 401 都不能代替原生工作区验收。

## 账号调用链

1. 从 Studio 已认证 HTTP 上下文或 Runtime 的可信 owner 派生 SSO ID，不读取工具参数中的身份。
   Moss 工具按 Run 保存不可变身份和 lease；DSH action 从已确权的 `user:<SSO ID>` owner 派生身份。
2. Studio 只向服务端配置的 loopback d-obs 目标签发相机断言，拒绝任意 URL、重定向和客户端鉴权头。
   `RDK_VISION_BRIDGE_SECRET` 为仅服务器持有的至少 32 字节密钥；缺少密钥或真实 SSO 身份时云端关闭调用。
3. 两个头为 `x-rdk-camera-assertion` 与 `x-rdk-camera-signature`。前者是 canonical JSON 的 base64url，
   后者是以密钥对该 base64url 字符串作 HMAC-SHA256 的十六进制值。主体固定 issuer/audience，绑定
   sub、秒级 iat/exp、随机 nonce、HTTP method、排序后的 target、body kind/hash 和上传 metadata/读写 guard。
   对象键按 UTF-16 排序、数组保序；JSON 哈希取实际发送 JSON 解析后的 canonical 字节，二进制取实际字节。
4. d-obs 只接受实际 socket 来自 loopback 的断言，不信 X-Forwarded-For。验证签名、完整请求绑定和短时效，
   在 `RDK_VISION_BRIDGE_STATE_DIR` 的私有目录独占认领 nonce，跨进程和重启防重放；并行读取不能被全局遗留锁永久阻塞。
   二进制先验证签名/权限，再有界解析，最后核对实际内容。无签名的旧管理员路径保留原权限。
5. 相机专用认证只赋予相机作用域，owner 为 `sso:<sub>`。内部 MCP dispatch 通过真实请求继承私有主体，
   不能将同一断言用于平台其他操作。通用 execute 的目录与实际执行都检查相机作用域。
6. `RDK_VISION_BRIDGE_ADAPTER_OWNERS` 是服务端可信的 adapter→SSO ID 列表，缺省为空。
   过滤目录还不够：历史实验、AI start/cancel/restore、后台已捕获的 registry 和标定 apply 每次执行都核对授权。
   撤销后的恢复可能无法确认，保留 unconfirmed，不借管理员兜底。模块级任务和 adapter lease 须跨请求保持。

## 原生界面与 Runtime

- 工作区只需服务连接就能查询知识、保存无 targetId 的文件实验、导入 RAW、创建/运行 CPU 标定和导出结果。
  AI 调优与设备按钮另要求实际适配器，不因无设备把全部软件功能一起禁用。
- 账号切换时重挂工作区并清理预览、实验、结果与 Blob URL；每个异步续步再次检查身份与代次，不能让旧响应触发新 POST 或下载。
- 导出包含 public 标定任务及经过实际文件哈希校验的已完成结果；失败/未完成任务保留状态，不生成假结果。
  ZIP 项目数、总字节和 Studio 接收上限要覆盖同一完整合法图谱，不能静默截断。
- DSH 当前的 `write-low-risk` receipt 不是硬件审批 broker。知识/状态和 CPU 准备可走明确语义 action；
  不把物理写入映射成低风险动作，不将 DSH task 回退或改绑 Moss。硬件写沿原生工作区显式操作或已有同等审批边界。
- 检查实际线上 dist 是否包含相机入口。源码组件存在不能证明前端已发布。线上旧核心有独立补丁时，
  不用无法证明对应关系的旧源码整包覆盖。必要的原生 React 扩展须复用宿主同一 React/身份/语言上下文，
  对宿主集成点做固定哈希、唯一 AST 定位和实际浏览器验证；不能复制第二套登录状态或用 iframe 代替。

## 验收顺序

1. 跑协议篡改、过期/重放、并发 nonce、两账号实验/资产/任务/下载隔离、adapter 撤销、跨请求运行/取消/恢复测试。
2. Studio 签名器到实际 d-obs 路由做隔离 HTTP/MCP 联测，使用明确的测试账号和私有 state；
   用三份明确合成 RAW 运行真实 Python/NumPy BLC，核对结果和 ZIP 字节。不把此链路描述为生产 SSO 或相机验收。
3. 在实际生产 Node 下验收最新线上基线加最小 overlay。旧 live 回执无新增软件字段时，断言独立 getter、
   真正恢复帧及配置哈希，不为测试夹带整块未发布实现，也不删除核心业务断言。
4. 真实浏览器检查中英文、桌面/390 窄屏、无设备准备、下载和账号切换；有实际 SSO 时再验正常公网入口。
   保存认证方式与范围，匿名拒绝、fixture 登录和真实已登录工作流分别报告。
5. 生产发布另按 d-obs-release：重新读取两个 current，保留并发上线内容；候选验证后才切换专用配置和主备。

本流程的软件验证不提升 ARM64 SDK 链接、相机点亮、RAW 回灌或画质验收状态。

## 已验证的复用方式

用 [compiled-software-e2e.mjs](../scripts/compiled-software-e2e.mjs) 对正式候选跑隔离软件闭环：

```sh
<实际生产Node> compiled-software-e2e.mjs --studio-root <Studio候选根> --platform-root <d-obs候选根> --python <venv/bin/python> --output-dir <新的私有目录>
```

脚本直接导入候选 JS，使用合成账号和三份合成 RAW，在独立 loopback 与临时 state 下执行真实 Python/NumPy BLC、跨账号拒绝和 ZIP 原始字节校验。只有 passed、cleanupCompleted 为 true、hardwareOps 为 0，且 candidateRoots/运行模块哈希匹配，才能记为通过。不要将合成身份发送到生产实例。

调用 Python 时保留 `venv/bin/python` 入口路径，realpath 只能用来检查目标，不能替代执行路径；venv 的 Python 通常是指向系统解释器的 symlink，解引用后执行会失去虚拟环境。此问题在实际 Node 22.16/22.19、Python 3.10、NumPy 2.0.2 下完成正反例验证。

原生扩展资源使用全新 namespace；旧 assets 原字节保留。核验所有相对 import、同一 React/Auth/UIContext、嵌套窗口焦点/关闭与账号切换，再验证真实 `/rdkstudio/` 前缀下的完整壳。避免在 immutable 的旧哈希 URL 下替换内容。

2026-10-15 线上版本及验收范围见 [发布记录](../../../../docs/releases/2026-10-15-studio-camera-native.md)。正常 Moss/DSH 聊天仍要求真实已确权板卡；无相机的软件准备使用原生工作区，不能通过伪造板卡或 SSO 放开聊天。

## 已登录账号的软件准备与续做

使用已登录 IAB 的同一账号，在原生工作区创建不绑定设备的文件实验，保存场景、照明计划与视觉验收条件；
关闭后重新打开该实验，核对已保存内容，再下载手册、交付 JSON 和真实 ZIP，检查包内记录。
2026-10-15 已用此流程保存三项视觉条件（曝光与亮暗细节、色彩与白平衡、噪声/锐度/伪影），并完成重开和下载。
保存条件是准备验收，不是填写观察结论；此次包内没有采图、候选或验收记录，硬件和画质仍为 `unverified`。
导出成功只证明软件记录与文件可取，不证明点亮、SDK 写入、恢复或画质达标。

文件实验目前不能事后绑定 adapter；接入硬件时另建绑定实际授权 adapter 的实验，保留两份实验的用途与来源。
未来的源码构建中，`PluginDetailDrawer` 已补接 `VisionWorkshopEntry`，但这次入口源码修复未额外部署；
线上入口的现状须以实际发布资产和浏览器为准。

证据：`/Users/d-robotics/.codex/task-artifacts/studio-camera-live-20261015/user-project/` 的真实导出文件，
以及 `/Users/d-robotics/.codex/task-artifacts/studio-camera-entry-source-20261015/software-proof.json` 的源码和验证范围。

## Studio Bridge 的单目标恢复

旧 Bridge 的 resume 状态只在进程内存，不能假定重启后仍能续用。新配对在用户明确授权范围内进行：
在真实 UI 固定已保存的单一目标与用户名，清空网页密码；用官方 client 的最小私有副本启用严格 known_hosts
和单目标扫描保护。wrapper 只从私有输入与已有凭据读入内存，配对码和密码不放入 OS argv、公开输出或技能。官方 runtime 日志可能含配对或恢复凭据，必须限制为私有 0600，只提取脱敏状态，不能直接回显。
若初始发现约 10 秒后因无板退出，先只读核对同一目标的 TCP、ARP、SSH；保留失败 attempts，
不扩大扫描、修改发现算法或伪造 online。本轮重插 USB 后实际 TCP/SSH 恢复，新 UI 配对经 SSH verified，
Studio 自动登记并选中新 X5 为 online，终端实际 `uname` 返回内核 `6.1.83`；这些只证明板卡连接，不证明相机可用。

默认 `/userdata` 对此次 `sunrise` 用户无权限；在 UI 选择已存在且可访问的 `/home/sunrise`，重开终端后核对 PTY ready。
权限错误被误报为 SSH 认证失败的源码修复已通过 38 项定向回归、前端类型检查与 lint，但整仓 fast 门禁仍失败，且尚未上线，不能写成已部署修复。
Bridge 后台进程需保持运行，停止会使设备离线；不要自动安装 launchd 或自启。
Files pane 目前仅验证 folder picker 可列出现有 home，编辑器读写尚未验证。

证据位于 `studio-camera-live-20261015/bridge-preparation/bridge-software-proof.json`
与 `studio-camera-live-20261015/studio-connection/ui-connection-proof.json`；旧失败尝试保留。
