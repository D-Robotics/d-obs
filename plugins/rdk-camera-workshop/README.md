# 相机点亮与 ISP 调优插件

插件把自然语言目标接到 d-obs 的真实视觉原子服务。X5/亚博 IMX415 已实际接入，
历史官方采集曾取得可辨识现场新帧，后续保存记录出现 MIPI 开流失败；这些记录不表示设备当前在线。
1.2.0 将新型号接入方法、下一步原子动作、SDK 帧计数诊断和 AI 原生 ISP 字段决策接入插件，保留团队经验与已有标定链路。
`vision_camera_workflow` 读取本实验的实际缺口和下一步工具；`vision_camera_stream_analyze` 分析本实验归档的 SDK 帧号和时间，不主动采流。
AI 原生 ISP 路径从实际完整快照及可写规则提出有界 patches，经 SDK 应用、独立回读和新帧验证；UVC 继续使用通用控制。
完整原图归档，模型接收具有来源哈希与尺寸的有界观察图，不将缩略图、参数回读或模型评价当作画质认证。
X5 已验证部分实机参数读写和恢复，但本轮没有可推荐的画质提升，也出现采集及连接不稳定；真实 RAW、模式、时钟与完整画质仍需验收。
头文件、SDK shim 与协议测试不证明硬件通过。
板端 SDK 构建、模式和独立回读限制见仓库根目录或 ZIP 内的 `docs/vision-workshop-x5-native.md`。
IMX415 的厂商 ROS 版本前提、两个接口、lane、光学条件、历史失败与恢复门禁见
[兼容性与失败恢复](skills/rdk-camera-workshop/references/imx415-compatibility-and-recovery.md)。

平台网页的接入引导和结果展示需要配套更新 d-obs 服务；ZIP 更新技能与连接器，不替换宿主界面或平台执行器。

## 两种连接路径

RDK Studio 主项目已有 `rdk-camera-workshop` 原生 companion：本地/desktop 模式通过
`RDK_VISION_WORKSHOP_URL` 连接本机 loopback d-obs。启用插件后，技能和工具进入实际对话。
此原生路径目前不支持远程 HTTPS/云账号透传，也不运行包内 stdio 配置。
不要把本地协议验证当作线上 Studio 或真机验收。

本包也提供独立 Node stdio 连接器，供支持插件 MCP 的宿主或手动添加 MCP 服务器使用：
设置 command 为 `node`，args 为解压后的 `mcp/bridge.mjs` 绝对路径。
相对路径的 `.mcp.json` 是插件扫描格式；实际启用仍以宿主工具目录为准。
若 Studio 已走原生 companion，继续使用原生路径，避免重复注册同名工具。

## 独立连接器配置

默认读取 `~/.config/rdk-camera-workshop/connection.json`，或由环境变量
`RDK_CAMERA_WORKSHOP_CONFIG` 指定仓库外私有文件。连接格式：

```json
{
  "url": "https://你的服务地址/dobs/api/ops/vision-workshop/mcp",
  "auth": { "type": "sso", "credentialFile": "/私有目录/现有会话文件" },
  "timeoutMs": 130000
}
```

`auth.type` 为 `sso` 时发送 `x-rdk-sso-session`；为 `admin` 时发送 `x-admin-token`。
配置与现有凭据文件只放在插件外，POSIX 文件使用所属用户的 0600 权限。
Windows 用文件 owner-only ACL 保护；连接器不自动验证 Windows ACL。
HTTPS 或 loopback HTTP 可以作为目标；拒绝重定向、userinfo、query/hash 和其他 API 路径。
输入最多 24 MiB，输出最多 96 MiB，覆盖单张 IMX415 4K RAW 的 Base64 回执；
服务自身限额仍生效。工具调用串行、目录查询最多四路；写入不自动重试。
配置缺失、身份无权、服务不可用或缺少工具均返回真实错误，不生成成功工具目录。

## 点亮的实际范围

当前点亮使用已经适配的传感器驱动与媒体模式启动设备，再检查实际出图。
X5 后端目前选择官方 IMX415 既有模式；不会根据硬件说明书生成新驱动、设备树或自动编译部署。
尚未支持的新相机按 [新型号 AI 工程流程](skills/rdk-camera-workshop/references/new-sensor-ai-workflow.md)
整理带来源的电气、时序和 SDK 资料，通过宿主已有开发工具完成驱动或 adapter 补丁、匹配头文件编译及实机验证，再进入采流与调参。
插件提供编排方法、工具和适配资料工作表；没有宣称一个通用 API 已能为任意 Sensor 自动生成并发布驱动。

## 使用与边界

可说：“检查 X5 的 IMX415 接入条件”“点亮这颗相机并预览”“改善暗部细节，保留原始配置可恢复”。
“做 ISP 调优”会先检查 Bayer RAW、原生 tuning/schema 与恢复能力；缺少实际适配器时报告缺口。
所有写入继续经过宿主和 d-obs 权限，连接器不执行 shell、下载驱动或绕过平台。
断连/超时不自动重试写入，应先查询 deviceRuns；软件测试不代表硬件或画质通过。

d-obs 插件中心另提供 `camera-workshop.json`：这是只读知识/面板/助手指引包，
不是 Studio ZIP，也不会单独赋予硬件写权限。完整执行由核心视觉工具承担。

## 包内软件与板端准备

包内 `tools/` 包含原生相机服务、只读预检、帧转换、ISP 快照/回读、离线标定算法，以及
既有 UVC/通用 runner。必须一起保留相邻 Python 文件；原生源码位于
`tools/vision-x5-native/`，以目标 X5 的真实 SDK headers/libraries 和官方传感器配置编译。
包不含 SDK、传感器寄存器表、驱动、private config、运行态 fixture 或编译后的二进制。
仅附带三份原生 C 的隔离 SDK shim 测试源码，使 `make test` 在提供匹配的官方 headers
和传感器配置后可运行；这些测试不注册平台 adapter，不访问硬件，也不证明实机通过。
离线标定需要服务器已有 NumPy；库/模块/mode 不支持时返回真实未就绪，不能用 fixture 替代。

先在当前 X5 上只读预检，记录实际 SDK/系统版本、CSI 与 I²C sysfs 事实，再按
包内 `docs/vision-workshop-x5-native.md` 的契约配置私有 daemon 和平台 adapter。
SDK 版本、模式、端口、排线和原始效果库需要实际核对；插件安装不会自动连接板卡、
编译/安装库、注册 adapter 或上线服务。`SOURCE-MANIFEST.json` 提供包内文件 SHA-256。

交付与验收工作区支持显式标准、阈值与图像/参数绑定的操作者记录、厂商候选 JSON 归档及可复用调优手册。记录满足阈值、SDK 重载记录和独立画质认证分别展示；真实效果仍以指定设备与场景验收为准。

## 团队经验已进入插件

[现场操作指引](skills/rdk-camera-workshop/references/bringup-and-isp-field-playbook.md)覆盖 USB 最小闭环、Studio 真实 MIPI、专家操作记录、相机选型与供货、验证素材起点、版本优先排障、Tuning guide、真实场景对比、告警分级与内部验收。知识详情的 `teamExperience` 与插件中心的团队经验面板提供对应检索；完整 ZIP 同时附带 `knowledge/camera-field-experience.json`，离线也可读取。

历史版本、供货与画质案例均标为用户报告，未独立复核，不修改设备准入或画质状态。新 Sensor 驱动生成、设备树生成及自动编译部署仍未实现。

可以说：“按团队经验规划这颗相机从当前状态到 ISP 验收的步骤”“I²C 有地址但 tuning 进不去，先查版本与真实链路”“根据 Tuning guide 改善雾感和彩噪，并保存前后图与恢复记录”。
