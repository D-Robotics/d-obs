# RDK 相机接入与 ISP 调试助手（预览版）

用于 Qoder / WorkBuddy 的 Skill + stdio MCP 插件。支持相机接入资料检索、OS/SDK 版本排障、已适配相机点亮、预览、控制调试，以及适配器实际开放的 RAW、ISP、标定与恢复操作。

需要 **Node.js 22+、用户自己的 d-obs 相机服务和该服务的访问权限**。服务端必须已登记实际开发板与相机 adapter；插件不会自动部署后台或添加硬件。没有设备仍可阅读随包知识和规划步骤。

## 安装

- Qoder：扩展 → 插件 → 添加插件/导入插件，选择本次 `qoder-…-plugin.zip`，或按客户端版本导入解压后的插件目录。Qoder CLI 也可安装本地插件目录。
- WorkBuddy：使用 `workbuddy-…-marketplace.zip`，按客户端支持的 ZIP/目录方式添加自定义市场后安装。也可把市场目录独立托管为 Git 仓库，再在“添加插件市场”填写仓库地址。不要把仅包含单插件的 ZIP 当作市场 ZIP。
- 客户端入口随版本不同，若导入不受支持，解压单插件包并用下述绝对路径 MCP 配置和宿主技能导入入口分别加载；此方式需要保留解压目录。

包根目录的 `DISTRIBUTION.json` 记录目标宿主和验证边界。安装后还需配置连接；本包未携带访问凭据。

首次安装即可调用本地 `vision_connection_status` 查看配置缺项。未配置或远端失联时只有本地诊断工具可用；它不会报告服务已连接或相机在线。

## 连接与自检

1. 由原服务提供访问凭据，保存为插件及源码仓库之外的私有文本文件（POSIX `chmod 600`；Windows 使用本人私有 ACL）。不要把凭据发到对话中。
2. 在插件根目录运行 `node mcp/setup.mjs help`。随后按实际 URL/认证类型/私有文件路径运行 `configure`。默认写入用户目录 `.config/rdk-camera-workshop/connection.json`，只创建新文件，不覆盖旧配置。
3. 运行 `node mcp/setup.mjs doctor`。成功只表示服务连接，不代表相机或 ISP 已通过验收。
4. 宿主找不到 Node 或不支持插件根目录变量时，运行 `node mcp/setup.mjs client-config`，将生成的本机绝对路径 JSON 添加到宿主的自定义 MCP 连接，保留其他连接。不要重复启用同名插件 MCP。
5. 重新加载插件，输入：“检查相机服务连接，列出实际设备与可用能力，再规划 USB 采图闭环。”

配置例子和错误处理见 [连接与自检](skills/rdk-camera-workshop/references/host-connection.md)。`--config` 指定的自定义配置路径还需通过 MCP 的 `RDK_CAMERA_WORKSHOP_CONFIG` 环境变量传入。服务只能是 HTTPS 或本机 loopback HTTP，完整 MCP 路径以 `/api/ops/vision-workshop/mcp` 结尾；代理前缀可保留。

## 使用

可说：“先核对 X5 IMX415 的版本和点亮前提”“连接这颗已支持的相机并保存新帧”“依据 Tuning guide 排查雾感和彩噪，保存前后图与恢复证据”。从资料、运行能力、实际设备依次核对；写入遵循宿主及服务端权限。超时后先查真实状态，不盲目重放写操作。

随包 `knowledge/` 提供离线资料；团队经验保留用户报告来源。USB UVC 控制不等于板卡 ISP；新 Sensor 驱动/设备树生成、寄存器表生成和自动编译部署未实现；X5 原生适配器软件测试不等于实机 ISP 验收。画质结论需要本次场景新图、参数回读与恢复证据。

包内 `tools/` 为可选板端适配源码，安装插件不执行它们。厂商 SDK、第三方 Datasheet/Tuning guide 全文、私有配置、真实凭据与实机图像均不随包发布。软件许可证见 [LICENSE](LICENSE)，资料引用及报告的经验不代表其第三方内容被重新授权。`SOURCE-MANIFEST.json` 记录包内文件校验值。
