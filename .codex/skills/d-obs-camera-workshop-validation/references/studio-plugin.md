# Studio 原生相机插件

此工作流用于相机插件开发和验收，复用 d-obs 相机原子服务。RDK Studio 仓库提供 `plugins/rdk-camera-workshop/` 包；含 manifest、产品技能、MCP 声明及薄 stdio companion。使用须具备包含原生相机桥与界面的 Studio 源码/构建版本；单独导入插件包不能替旧版宿主增加原生界面。

## 调用边界

```text
Studio 原生工作区 / 按 Run 装配的相机 MCP 工具
  → Studio 同源 /api/vision-workshop
  → d-obs 已注册的相机 REST/MCP 原子服务
  → 已配置 SDK runner 与真实设备
```

- Studio 服务端配置 `RDK_VISION_WORKSHOP_URL`，只使用已配置 loopback 目标；浏览器仅访问同源路径，不拿上游 URL、SDK token 或模型 key。旧公开外链配置接口已移除。
- 独占本机 desktop/local-dev 使用 loopback 监听和 loopback upstream；多用户形态必须具备专用签名账号桥和真实 SSO 身份，缺少时 fail closed，不转成共享匿名管理员。接入与验证见 [账号桥工作流](studio-account-bridge.md)。
- 插件状态来自实际 scanner/registry，按所选 `@bundled`、`@user` 或 `@project` ID 启停。停用后，UI 和工具均拒绝新执行。
- 工具以本次可信宿主身份装配，不进入全局用户连接池。原生 Moss 与外部 runtime 通过已有 RDK 桥提供工具，不能再附加未配置的同名 stdio 连接。
- 只读工具显式分类；AI start、控制设置、恢复、采集和通用 execute 保留 MCP 写入审批边界。Plan 模式的写入请求在传输前拒绝。
- 产品技能需真正进入原生技能匹配；目录里显示一个 skill 不证明模型能获取它。插件要求实际 adapter 就绪，不强迫先选择 Studio SSH 设备，也不把未选择 SSH 当作板端已在线。

## 原生交互验收

1. 在 **AI → 扩展中心 → RDK Camera Workshop → 打开相机插件工作区** 进入，或从设备诊断上下文进入同一个原生组件。不能用 iframe、BrowserView、外链或第二套调试页面代替。
2. 核对插件已安装/已启用、相机服务连接状态与 adapter 的实际身份/模式。创建新实验时选择器须显示“尚未保存”，不能仍显示旧实验。
3. 输入自然语言目标，启动异步 Run；观察实际图片、模型判断、请求值与回读。闭窗重开找回同一进度，模型判断不写成人工评分。
4. 新 Run 尚未采图时不能残留旧图片；历史推荐图与最终配置回读后新采图分开展示。恢复错误优先于旧 final 成功字段，不能同时宣布“已恢复”。
5. 停止按钮先显示等待恢复回执，再在 canceled 终态核对完整配置 SHA 与新采终态图。cancelRequested 不是实际恢复完成。
6. 在 Studio 点击下载成果，用 ZIP 内 manifest、每个 Run 的 original/best tuning 和 report 核对配置/图片哈希及来源。
7. 中英文切换、刷新恢复、插件中心入口和诊断信息按受影响范围验证。

## 知识补丁与两种插件包

知识改动须同时检查 d-obs 完整插件和 Studio 原生薄包。平台知识搜索返回摘要，详情 GET 才返回
`vendorPrerequisites`、`diagnosticCases` 和 `historicalObservations`；不能只更新摘要或本地技能，
让实际分发的插件继续携带旧知识。结构化条目的来源是
`server/monitoring/vision-workshop-x5-imx415-knowledge.ts`，包内 JSON 必须与完整对象深度一致。
历史实测按日期保存，不能将旧成功写成实时在线，也不能让后续失败抹掉此前成功证据。

完整包使用 `tools/package-camera-workshop.mts <output>`；Studio 薄包使用
`tools/package-camera-workshop-studio.mts --studio-source <Studio仓库> --output <output>`。
后者从实际 Studio 源目录读取 manifest、原生 `.mcp.json`、`mcp/server.mjs`、技能、reference 和
知识 JSON；保留原生 companion，不用完整包的独立 stdio bridge 替换。两个包版本独立，知识版本一致。
共享脏工作区中保留原有 native 流程和其他未提交改动，仅窄合并知识增量。

候选包须验证 ZIP CRC、SOURCE-MANIFEST 每文件 SHA/覆盖范围、相对 Markdown 引用及知识完整性。
对入包文件做内网地址、凭据、个人路径和编译二进制检查；临时诊断 bridge、私有连接配置和现场日志不入包。
Studio 还需验证原生 MCP 文件与改动前字节一致，以及实际技能扫描器能读取带宿主扩展字段的 frontmatter；
通用技能校验器不认识扩展字段时，不删除宿主字段来凑通过。

本地生成 ZIP 不会更新已运行的宿主、服务或插件中心下载。平台下载端读取
`plugins/vision-workshop-packages/` 的发布清单及平台/Studio ZIP，不自动采用本地输出目录。
不得覆盖旧版冻结发布证据来冒充新版已发布；用户要求发布时另走发布流程。

## 已保存实机证据

2026-10-13 的 [Studio 插件证据目录](../../../artifacts/studio-camera-plugin-20261013/)保存 native MCP 发现/调用、真实 Studio UI Run、取消恢复和 UI 下载验证。`run-receipt.json` 是通过 Studio 发起的新 Run；`cancel-run-receipt.json` 记录实际 canceled、restore_tuning、controls_get 与终态新采图。

本次相机仍为 S100 USB UVC；原始配置已恢复，画质没有通过完整验收。Bayer RAW、原生 SoC ISP 与多用户云桥没有实机接通，不用插件包存在来宣布这些能力可用。全部检查结果以本次证据目录的最终 validation 与日志为准。

2026-10-14 已发布 1.1.0 插件接线到实际 Studio 主备服务，见 [相机软件发布记录](../../../../docs/releases/2026-10-14-camera-isp-v2.md)。实际生产进程为 web-cloud，连接与 AI 调优返回 `vision_workshop_account_bridge_unavailable`。主备健康 200 和匿名接口 401 只证明发布及权限门禁；不能记为已登录云端相机执行验收。没有使用伪造 SSO 或匿名管理员绕过账号桥。

2026-10-15 已补齐并发布原生工作区、签名账号桥与 DSH 软件准备 action，见
[新的发布记录](../../../../docs/releases/2026-10-15-studio-camera-native.md)。上段 10-14 状态作为历史保留。
新发布已验证主备与公网资源、生产 Node 下的隔离软件闭环；真实生产 SSO 登录态和 IMX415 实机仍未验收。
