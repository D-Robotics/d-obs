# 连接与自检

用于 Qoder / WorkBuddy 的本地插件。插件通过 stdio MCP 访问用户自己的 d-obs 相机服务；不包含托管后台、相机驱动、厂商 SDK 或预配置设备。

首次安装无需凭据即可调用本地 `vision_connection_status` 查看配置缺项；该工具不联系远端，不把配置有效当作服务就绪。先询问缺失的服务地址、认证类型与已有私有凭据文件位置。只接收文件路径，不让用户把 token 粘到对话、命令行或插件文件中。已有配置可直接自检；不要替用户重新配置。

在插件根目录执行 `node mcp/setup.mjs help` 查看配置用法。`configure` 接收完整 MCP URL、`sso` 或 `admin` 类型和凭据文件绝对路径。服务 URL 必须为 HTTPS，或本机 loopback HTTP，路径以 `/api/ops/vision-workshop/mcp` 结尾。使用本次服务实际支持的认证方式，不把 SSO 身份改为管理员。

默认配置为用户目录下 `.config/rdk-camera-workshop/connection.json`；`--config` 可指定其他绝对路径，自定义路径同时需要宿主 MCP 环境变量 `RDK_CAMERA_WORKSHOP_CONFIG`。连接配置与凭据均须位于插件及源码仓库外，POSIX 权限 600；Windows 需用户用 ACL 限制为本人访问。配置脚本不覆盖已有文件，也不修改宿主设置。

运行 `node mcp/setup.mjs doctor`。它执行本地配置验证、真实 stdio `tools/list`，以及服务暴露时的只读 `vision_workshop_runtime_status`；输出不含服务正文、凭据或设备地址。`connected` 只表示运行状态接口有回应，不证明设备在线、MIPI 出图、RAW/ISP 可用或画质通过。

宿主无法替换插件根目录变量或找不到 Node 时，从固定安装目录运行 `node mcp/setup.mjs client-config`，将其生成的绝对 Node/bridge 路径配置添加到宿主自定义 MCP 连接。不要覆盖其他连接；升级移动插件后重新生成。相同服务名的连接只保留一个启用实例。保留包目录以维持路径有效。

修复连接后在宿主重新加载插件，从实际工具目录选择 `vision_workshop_runtime_status` 和 `vision_camera_knowledge_search` 复查，再列出实际设备与实验。只具备知识工具时可以规划，不能报告设备接入成功。缺少 typed 工具时升级服务或报告缺口，不能使用通用 shell 旁路。
