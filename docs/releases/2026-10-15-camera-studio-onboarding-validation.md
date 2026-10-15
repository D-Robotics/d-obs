# Studio 相机接入补充验证

2026-10-15。本记录补充目标 SDK 编译与真实用户的软件准备流程，不改写 [Workshop 2 已发布版本记录](2026-10-15-camera-workshop2-delivery.md)，也没有执行额外上线。当前结果不能视为“点亮 → 采图 → ISP 调优 → 画质验收”全链路通过。

## 目标 SDK 编译与静态检查

在目标环境实际已安装的 SDK 头文件和库上执行了下列命令，退出码为 0，没有替换 SDK 类型或修改系统软件包：

```sh
make syntax-check all \
  VP_SENSOR_DIR=/app/multimedia_samples/vp_sensors \
  SDK_INCLUDE=/usr/include SDK_LIBDIR=/usr/hobot/lib \
  'LDFLAGS=-L/usr/hobot/lib -Wl,-t'
```

构建产物为 AArch64 ELF `libvision_x5_native.so`，381,624 字节，SHA-256 为 `cdfee849fa66f56c174640f9cd6c5d5a1fdeb8fd8bf31352378218c80660a00c`。头文件声明的 22 个公开 ABI 符号全部存在；动态符号表共导出 24 个 `x5w_` 符号，额外两项为 extended control 的 get/set。所需动态库及实际链接文件、SDK 头文件的哈希已留存。临时构建目录已清理。

本次只编译、链接和静态检查，没有 `dlopen` 或运行生成的库，没有启动相机会话，也没有执行硬件操作。已保留 VP 源文件未来时间戳产生的 clock-skew 警告；未修改系统时钟或源文件时间。构建成功不证明 SDK 运行、出图、参数回读或恢复成功。

## 真实 SSO 用户的软件准备流程

本轮已观察到现有真实 SSO 用户在 Studio 中创建文件实验、保存验收计划、重新打开实验，以及下载实验 ZIP、delivery JSON 和调优手册；Bridge 尝试后再次重开仍显示同一计划。独立脱敏 UI 操作证明已保存，SHA-256 为 `fa5f88928df07c74ff34fbc6230d636743b2a5d3614e06b1cb5a08a665185e8c`，并绑定 DOM 文本和两张截图的实际字节哈希。该证明属于 observed UI，不能当作 HTTP 日志；本记录不推断逐请求返回码、账号标识或登录凭据。

| 项目 | 实际记录 |
| --- | --- |
| 实验 ID | `efbc74b5-3b7b-4e4e-be0b-ff8394d5be26` |
| 当前验收计划 ID | `1e443e64-1065-43ed-a342-f4b9ceb81bd5` |
| 计划范围 | 曝光与亮暗细节、色彩与白平衡、噪声/锐度/伪影，共 3 项必需的人工观察项 |
| 场景条件 | 室内基准场景；光照、照度、距离及曝光条件仍待现场补录 |
| ZIP 内容 | `manifest.json`、`handbook.md`、`calibration/tasks.json`、`delivery.json`，共 4 项 |
| ZIP SHA-256 | `cc92d8f4ea20e5b876ac68571153014d80dbf1f83a765c29e98941f9301bcb01` |
| 单独下载的 delivery.json | 与 ZIP 内同名文件字节完全一致，SHA-256 `a9be11b2745c7ca4d9717d36eeabf34ddd5c580e0e3aa393f7143cc7e36f0da2` |

单独下载的手册和 ZIP 内手册是分别生成的产物，导出时间不同；各自原始字节与哈希分别保留，不声称两者字节一致。

导出清单中没有相机会话、RAW 样本、相机帧、处理图像、参数候选、tuning 文件、设备执行、AI 调试或评价记录。适配器列表为空；`quality.status=pending`，`tuning.status=missing`，`workshopReady=false`，硬件与画质验证均为 `unverified`。验收计划保存成功只完成了准备工作，没有自动产生达标结论或可用 tuning 文件。

## 入口源码修复

本地源码补上了 `PluginDetailDrawer → VisionWorkshopEntry → VisionWorkspace` 的实际挂载路径。17 项定向测试、前端 TypeScript 与 ESLint 通过；记录包含最初缺入口的失败反例。该修复未额外部署，也未做此次源码修复的浏览器或完整生产构建验证。已有线上入口来自先前发布的隔离前端产物。

整仓 fast 门禁未通过，原始 12 项失败及日志哈希保存在源码证明中；本记录不把定向通过等同于整仓通过。

## Bridge 配对与软件连接

首次尝试曾完成授权配对，但目标不回应 ARP/ping/TCP，SSH 未进入鉴权，Bridge 在 10 秒发现窗口后退出。USB 设备和 `en10` 仍存在，未发现本机网段冲突。当时的失败证据保留在 `attempts/attempt-20261015T085025Z`；这段历史没有被后续成功覆盖。

用户重新插线并明确授权重试后，TCP 与 strict known-hosts 的只读 SSH marker 均通过。Studio 内发起新的真实配对后，单目标 Bridge 已连接、SSH 已验证，并在 80 秒观察窗口内保持运行，超过原始发现窗口。新脱敏 Bridge 证明 SHA-256 为 `7e588ba80f182e8f464e5e8ff80fb08d6dafb1e876de526b2fcc4ab9073bf4b8`。恢复成功仅指本次观察到的网络与软件连接，不表示相机或 ISP 运行通过。

Studio UI 自动登记并选择新真实 X5 `192.168.128.10`，状态在线；原 `192.168.1.2` 记录保留离线。终端重开后显示“PTY 已就绪”；通过 Studio 实际终端执行 `uname -r` 返回 `6.1.83`，`pwd` 返回 `/home/sunrise`，当前会话工作目录由 UI 选为 `/home/sunrise`。独立脱敏 UI 证明已绑定最终终端 DOM 和[在线设备及终端截图](/Users/d-robotics/.codex/task-artifacts/studio-camera-live-20261015/studio-connection/studio-x5-online-terminal.jpg)，证明 SHA-256 为 `282ea6b97fd0a09fd7be000a20982e7e00c658957046f41bcf3dda4301453c2d`；只证明实际 observed UI，不推断逐请求 HTTP 状态。

文件夹选择器能列出已有 `/home` 目录；文件面板仍显示 `studio-default-project` 根标签和空目录提示，编辑器的项目目录绑定、文件读取和写入均未验证，不能称文件编辑流程已通过。

默认 `/userdata` 的权限拒绝曾被误报为认证失败。`WorkspaceTerminalEmbed` 与终端 helper 的源码修复现已完成：优先采用结构化终端状态，PTY 已就绪后的 `Permission denied` 按命令输出处理，真正握手阶段的认证失败仍保留。新增 25 项测试与既有 13 项终端回归共 38 项通过，前端 TypeScript 和 ESLint 通过；整仓 fast 已结束，仍有 12 项失败，未宣称整仓通过。该修复仅在源码验证，尚未部署，也未验证真实浏览器 xterm 重绘。现有会话已通过 UI 将工作目录改为 `/home/sunrise` 并重开终端；最后等待后文件面板仍是原项目根标签与空目录、没有错误提示，项目目录绑定与编辑读写继续标为未验证。没有改变网络或板卡配置。记录整理未读取私有连接、配对输入或 runtime 日志。

## 待完成项

- 编辑器项目目录绑定与文件读写仍待单独排查和验证。
- 目标 SDK 的实际加载和执行，Studio 内适配器首次接入及授权绑定尚待验证。
- 实际相机会话、新帧、RAW 采集、ISP 参数应用与独立回读尚待本次链路验证。
- 厂商候选在新会话重新加载、恢复原始配置，以及真实场景画质与稳定性验收尚未完成。

机器可核查摘要见 [补充验证证据](2026-10-15-camera-studio-onboarding-validation.json)。其中只包含脱敏结论、文件哈希、测试结果与未完成状态。本文档更新没有额外部署运行代码；本轮 Bridge 新配对按用户明确授权建立，并已验证所述单目标软件连接。网络配置和板卡配置未改变。
