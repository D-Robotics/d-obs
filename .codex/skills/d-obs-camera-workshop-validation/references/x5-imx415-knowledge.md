# X5 / IMX415 资料核对

此参考固化 2026-10-13 已完成的资料定位与兼容性核查方法。
当时用户表示模组尚未接好，核查范围为 `documentation_preflight_only`；
点亮、真实 Bayer RAW、ISP 写入/回读/恢复均没有实机通过证据。

## 可复用的核查方法

1. 从[亚博 IMX415 资料页](https://www.yahboom.com/study_module/IMX415)进入厂商资料包。
   定位 `rdk-x5-imx415.pdf`、`IMX415_主板兼容性说明（必看）.xlsx` 和 `camera.py`，
   对下载文件记录 SHA-256、核查日期与原文位置；不要把网盘提取码或板卡凭据写入知识库。
2. 用 [RDK X5 硬件说明](https://developer.d-robotics.cc/rdk_x_doc/Quick_start/hardware_introduction/rdk_x5)
   交叉核对板卡接口和排线图，用 [TROS 传感器示例](https://developer.d-robotics.cc/tros_doc/quick_demo/demo_sensor)
   核对支持平台与预览组件。区分 RDK X5 和 X5 EVB 的接口说明。
3. 查实际板端 OS、kernel、TROS 包和 SDK 版本后再选择匹配的 ISP 工具包与文档。
   分开记录厂商版本要求、官方文档列举模式和实机 probe 结果；缺少实机证据时保留待验证状态。
4. 读取厂商示例脚本确认作用和副作用。此次 `camera.py` 是 ROS 预览启动脚本，
   包含 180° 旋转和宽范围 `pkill` 清理；它不是 sensor 寄存器驱动或 ISP 调参封装，不能直接当 adapter。

## 已核对的资料事实

| 项目 | 来源结论与使用边界 |
| --- | --- |
| 模组 | 亚博 Sony IMX415，MIPI CSI-2，22pin、0.5 mm 接口，默认 I²C 地址 `0x1a`，手动对焦；这些是模组资料值，连接前仍需核对实物。 |
| X5 接口 | 官方说明为两个 22pin、每口 4 lane 的 MIPI 接口，要求同向排线，接触面背对黑色卡扣。此次未从所读官方正文独立确认板端连接器间距；不要仅凭 pin 数相同认定排线兼容。 |
| 厂商前提 | 亚博指南要求官方 RDK 镜像 ≥3.5.0，TROS Humble，`tros-humble-mipi-cam` 与 `tros-humble-hobot-stereonet` 均 ≥2.4.1。这是该厂商指南的要求，不代表已检查当前板端安装。 |
| 旧镜像分支 | 兼容性资料存在可适配和不支持命令升级的旧镜像分支；本次截图没有展示两个 <3.5.0 分支各自的镜像类别。PDF 的命令升级步骤仅面向旧 ROS 镜像。先核对镜像来源及完整版本表，不能只凭版本号分类或泛化升级步骤。 |
| 预览路径 | 官方示例覆盖 RDK X5 / X5 Module，链路包含 `mipi_cam`、`hobot_codec`、`websocket`。执行时发现实际采集索引和配置，不固定索引。 |
| 图像判断前提 | 厂商说明 IR-CUT OFF 为常规可见光色彩，ON 允许红外且可能偏红。记录开关状态并完成手动对焦，再评价色彩和锐度。 |

厂商事实以资料包中 PDF/兼容性表的对应条目为依据，重新下载时核对内容是否变化。
不要把指南的最低版本要求升级成未经验证的自动安装或改写设备流程。

## ISP 文档定位与成熟度

此次已读取的官方章节入口为：

- [Sensor bringup](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/isp_tuning_guide/Camera_sensor_bringup.html)：定位硬件准备、Sensor 驱动与应用配置检查。
- [VIN 示例](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/samples/sample_vin.html)：列出 IMX415 3840×2160 RAW10、30 fps 的 2 lane / 4 lane 模式；未确认亚博模组实际开放哪些模式。
- [Hobot Player](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/isp_tuning_guide/Hobot_Player_User_Guide.html)：定位 RAW 查看与工具使用说明。
- [ISP tuning](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/multimedia_development/isp_tuning_guide/isp_tuning/isp_tuning.html)：定位 tuning_tool / Tuning Server、VTunerClient、Calibration Tool 和标定流程。

上述 URL 的 SDK 文档版本仅标识此次阅读的来源，不能推导 RDKOS 3.5.0 等于该 SDK 版本。
工具包须匹配实际板端 SDK。所读工具支持表未列 macOS；按匹配包选择支持的 Windows x64 或 Ubuntu x64 GUI，
其中 Calibration Tool 与文档中的 hbplayer 工作流要求 Windows。

官方流程提供后续验证顺序：确认 RAW 正确性、保存原始 tuning、BLC/LSC/CCM/AWB 标定、动态模块和多场景检查、导出及恢复。
这是资料中的流程定位，尚未形成已跑通的 X5 操作手册。真实 RAW 还需确认 Bayer、packing、stride、位深、lane 和模式元数据；
ROS `image_raw`、JPEG、YUYV 或普通 PNG 不能替代 Bayer RAW 证据。

## 在 d-obs 中使用知识与原子能力

核对当前平台提供的只读知识接口 `GET /api/ops/observability/vision-workshop/knowledge`（`q`、`board`、`sensorModel`）
和 `GET /api/ops/observability/vision-workshop/knowledge/:knowledgeId`，或 MCP `vision_camera_knowledge_search` / `vision_camera_knowledge_get`。
这些入口沿用平台权限检查；读取知识不赋予设备写权限，也不证明设备操作已经可用。

从实际 registry、probe 与执行回执确认每个原子能力。可以复用平台设备契约、runner、RAW 布局校验/归档、版本账本和评价导出；
X5/IMX415 原生 adapter 软件 v2 已实现 HBN Camera/VIN/ISP、RAW/NV12、34 个 SDK 接口、AE/AWB/CPROC、模块快照与恢复。
官方头文件编译与软件协议测试通过；目标板 SDK 链接、模式元数据、RAW/ISP 生效与恢复仍待实机验证。
效果库加载/导出、真实 SDK RAW 回灌以及 BLC/LSC/CCM/AWB CPU 标定任务与私有 SDK 映射已落代码；原生执行仍须实际 SDK 模式资格与字段绑定。详见 [软件原子能力](x5-native-atomics.md)。
只有验证 SDK 支持真实 RAW 回放后才启用 `process_raw`；不要用平台有接口这一事实替代适配状态。
资料结论、平台实现状态、实机操作通过和图像质量通过分别报告，当前 S100/UVC 的历史证据不能覆盖 X5/IMX415。

## 自然语言插件入口

复用 d-obs 的 `camera-workshop` 模板与 [Studio 插件包](../../../../plugins/rdk-camera-workshop/README.md)。
用 `node --import tsx tools/package-camera-workshop.mts` 生成声明式 JSON 和可打包 Studio 目录。
声明式工作流只读，后续授权动作走核心视觉工具；独立 stdio 连接器只开放审定 typed 工具。
Studio 主项目已有本机 loopback companion 和技能/对话接线；此路径不支持云账号或远程地址，
不能把另一工作区的扫描结果或软件 fixture 升级为当前线上/实机成功。
安装插件不生成 native X5 adapter；未接线或未配置时按知识和实际能力报告缺口。

## X5 / IMX415 单帧查看：2026-10-14 实机跑通

此路径使用板上官方 `hobot_vio.libsrcampy`，已成功连续读取 80 帧并保存可辨识现场 JPEG。
它证明官方 Camera→VIN→ISP→VSE 的短时采集可用，不代表 d-obs native adapter、
Bayer RAW 导出、ISP 控制写入/恢复或画质标定已通过。此次原生 sensor 为 3840×2160、30 fps，
输出为 1280×720；没有测量实际稳定帧率，也未独立验收 4 lane。

### 找回设备并核对实际接口

- 先读取保存连接，再确认本次目标；多台板卡在线时请用户选择，不以“上方”猜 CSI 编号。
- 优先使用当前可用的板端执行工具；本次工具未提供任意板端命令，使用已验证的 SSH 连接，
  保留主机密钥校验。不要为找一台板卡扫描整个公司网络，也不输出凭据。
- 读取 `/etc/board_config.json` 的当前 board 条目。此次 `camera[0]` 对应 I²C6/host0，
  `camera[1]` 对应 I²C4/host2；Camera API 的 `video_index` 是 camera 数组索引，不能把 host2 填成索引2。
- 官方 RDK X5 的靠近网口接口对应 host0，远离网口接口对应 host2。
- 查相机节点 fd 占用；先复用已有采集服务，不停无关 ROS/机器人进程。

### 先缩小识别问题，再按原生模式采集

本次 IMX415 在 I²C4 的 `0x1a` 应答，寄存器 `0x4001` 读到期望值 `0x03`。
已确认型号后，可只读这个特定地址/寄存器；不做广范围 I²C 扫描：

```bash
i2ctransfer -y 4 w2@0x1a 0x40 0x01 r1
```

`open_cam` 参数为 pipe_id、video_index、fps、输出宽、输出高、原生高、原生宽。
`raw_height/raw_width` 是原生 sensor profile 的精确筛选条件，**不是输出分辨率**。
传 `1080,1920` 会排除 IMX415 的 4K profile：chip ID 读取成功但尺寸过滤失败时，
日志可能既没有该 sensor 的 WARN，也没有 Found，最终仍报 `No camera sensor found`。
本次纠正后的调用是：

```python
from hobot_vio import libsrcampy as srcampy
import cv2
import numpy as np

cam = srcampy.Camera()
try:
    ret = cam.open_cam(0, 1, 30, [1280], [720], 2160, 3840)
    if ret is not None and ret < 0:
        raise RuntimeError("Camera open failed")
    # 采集多帧让自动曝光/白平衡有时间响应；丢帧本身不证明已收敛。
    for _ in range(80):
        frame = cam.get_img(2, 1280, 720)
        if frame is None or len(frame) != 1280 * 720 * 3 // 2:
            raise RuntimeError("Unexpected NV12 frame")
    nv12 = np.frombuffer(frame, dtype=np.uint8).reshape(1080, 1280)
    bgr = cv2.cvtColor(nv12, cv2.COLOR_YUV2BGR_NV12)
    # 保存到本次创建的临时目录，拉回本机后查看实际图像。
finally:
    cam.close_cam()
```

此板 SDK 会列出 IMX415 2 lane / 4 lane profile 并提示选择。
核对当前 SDK 的选择行为；本次以非交互脚本采集成功，不能将两个 profile 同时被检测到当成两种模式均验收。
Python 接口没有显式 sensor 名称/lane 参数；需要强制 4 lane 时，用匹配版本官方 native sample
显式选择对应 profile，不猜文档中的固定 index。

`mipi mclk is not configed` 表示设备树未配置 SoC 输出 MCLK，并不是实际时钟测量；
带本地晶振的模组仍可能正常工作，本次正是在该提示下成功采集。不要仅据此改 DT。
此次系统 `/etc/version` 为 3.1.1，hobot-spdev 为 3.0.4、mipi_cam 为 2.3.6；
已有厂商指南的最低版本要求仍须按实际模组/ROS 路线核对，不能推断旧版本所有采集路径都不可用。

短采集结束后调用 `close_cam()`，回查无残留相机 fd，再展示本次 JPEG。
图像朝向、近处失焦、遮挡或强高光应按实际画面描述；不把出图成功升级为画质通过。

源码语义可核对官方 [Python binding](https://github.com/D-Robotics/x5-hobot-spdev/blob/506ec790a80c01ebe552929e6efb572d562b3b14/src/python/vpp_python.cpp)
和 [sensor 筛选实现](https://github.com/D-Robotics/x5-hobot-spdev/blob/506ec790a80c01ebe552929e6efb572d562b3b14/src/vp_sensors/vp_sensors.c)。

### 同次 ISP 排障与平台回归

先核对实际头文件和链接库，再选择 ISP 适配器。本次旧板 `hobot-multimedia-dev 3.0.2`
没有新版 EE、2DNR、3DNR 强度 getter/setter，CPROC 使用旧 `color_process_attr` 名称。
现有平台 v2 需要新版 typed API；官方 Camera 能出图不代表 v2 已兼容。
预检中的接口名称仅用于发现明确缺口，完整源码编译和运行时 ABI 检查仍不可省略。

保留 profile 的 `rx_attr.phy` 协议类型，只把 CSI host 编号写入 VIN `mipi_rx`。
本次错误地写入 `phy=2` 得到内核范围错误；DPHY/CPHY 与 host0/2 是不同编号空间。
检查重复库路径：本次真实 HBN 库在 `/usr/hobot/lib`，`/usr/lib/libvpf.so` 是另一库。
旧板原始效果库位于 `/usr/hobot/bin/imx415_tuning.json`；归档字节和 SHA，不改原文件。

把 SDK 返回、公开参数回读、视频流恢复和图像质量分别记录。
本次效果库切换返回 0，但预期 CPROC 值没有改变；恢复场景又使 MIPI 重启失败。
曝光和关闭 2DNR/3DNR 的实际图像没有可靠清晰度改善，不能将噪点增加记为增强细节。
发生流故障后保留 `cleanupRequired/unconfirmed`，不得重复热切换或关闭时再重放。
平台已补软件回归：有效新帧须先于恢复确认，失败 fence 跨 daemon 重启保留，
AI 自动恢复至多一次；人工恢复先保存 pending 状态。停止使用不重启 live flow 的
native stop 路径，不能把会重启现场流的 replay cleanup 当成停止。

2026-10-14 19:01，只重启官方相机服务后完成 90 次成功取图并保存现场图像，随后正常关闭，原始效果库 SHA 未变。
该 Python 接口未提供独立核验的 sensor frame ID/时间戳；此历史成功不能覆盖 10-15 的失败，也不证明当前稳定出图。
这是一项单次恢复证据，不据此注册原生 v2、宣称热切换稳定或默认自动重启服务。

### 2026-10-15 用户附件复核与镜像分支

用户提供的 7 页 `rdk-x5-imx415.pdf` SHA-256 为
`ffb3b559879673f6add256d51bcc7f43eeeace54d122c695c3b7bbdcbededd9c`，
与知识条目已有厂商 PDF 哈希一致。第1/4页直接支持条件为 RDKOS >=3.5.0，
TROS Humble，`tros-humble-mipi-cam` 与 `tros-humble-hobot-stereonet` 均 >=2.4.1。
这些是厂商 ROS 路线条件，不能升级成旧版原生采集绝对无法出图的结论。

第4节依赖、系统及 miniboot 升级步骤明确面向旧版 ROS 镜像。
本次兼容性截图展示一个 >=3.5.0 支持分支与两个 <3.5.0 分支：一条为厂商提供适配，
另一条不支持且不能命令升级；截图可见单元格没有给出这两个旧镜像的具体类别。
先核对板卡镜像来源/类型及完整版本表，不能将任意 3.1.1 套入某条升级路径。
文档中的命令只是待核查方案；读资料不授权 apt 升级、改 miniboot 或烧录。

同日官方原始程序在未加载临时桥时，2-lane 与 4-lane 配置均未取到帧，
日志为 MIPI PHY stop-state 等待失败、开流 -36；重启一次相机服务后仍失败。
本轮未进行 ISP 参数写入。先解决受支持镜像/驱动组合与稳定开流，再调光学条件和 ISP；
当前版本未达厂商直接支持条件是重要排查线索，但未证明它是 -36 的唯一根因。
已纠正平台知识中的“相机尚未到手”：实际为已有历史官方新帧、后续开流不稳定，
原生适配器/RAW/恢复/画质保持未验收。

### 2026-10-15 升级镜像后的复验

用户升级并重新连接后，实际系统为 RDKOS 3.5.0、multimedia 3.0.5、
multimedia-dev 3.0.4、spdev 3.0.9，TROS mipi-cam 2.5.2 / hobot-stereonet 2.5.5。
USB 网络及带主机密钥校验的 SSH 已通。这是升级后的新观察，旧版 3.1.1 的 SDK 缺口不能沿用为当前结论。

原生 ABI 2 在板端实际编译、链接并加载成功，HBN 库来自 `/usr/hobot/lib`。
使用该板实际头文件的 backend/modules/replay 三套隔离 SDK 测试通过；不代表真实采集、控制或恢复通过。
当前官方 VP 位于 `/app/multimedia_samples/vp_sensors`，两份 IMX415 profile 新增依赖
`imx415_common.c/.h`；只把该明确的 Sensor 公共文件链接进后端，不把通用发现/GPIO 实现一起编进产品。
GCC 的 `-Wmisleading-indentation` 会拒绝旧宏写法：补明确 braces，保留 `-Werror`，不能将编译警告误记为 SDK 缺接口。
测试验证的是静态 profile 不被会话修改，应先保存实际初值，不把旧 SDK 的 flyby 默认值硬编码进断言。

此轮官方 Python 点亮未发现 Sensor；两个接口对 `0x1a` 的定向访问均报 Remote I/O。
用户断电重插后，按当前官方 IMX415 profile 分别调用两口的受控复位/探测，仍无应答。
原生后端在 `hbn_camera_attach_to_vin` 返回 `-207`；当前安装的 `hb_camera_error.h`
将 207 定义为 `HB_CAM_I2C_WRITE_FAIL`。按当前版本头文件解释，不能把它与旧版 `-36/-37` 混为同一故障。
芯片识别未通过时停止 ISP setter，不以 lane 切换、降噪/锐化或效果库重载修复无 I²C 应答。
此轮没有新图、没有 ISP 参数写入；采集句柄已关闭，不能将成功构建记为相机点亮。

官方 multimedia sample 与 `hobot_vio.libsrcampy` 可能使用不同探测实现，不能只凭共用函数名推断复位已执行。
当前 sample 的 IMX415 chip-ID callback 包含唤醒及待机操作，ID 为 `0x0514`；
旧脚本读 `0x4001 == 0x03` 的方法有版本范围。使用当前实际 header/profile 及回执，不把 SDK 版本差异误判为更换了 Sensor 型号。
板端 RTC 曾显示 2000 年，主机接收时间与 SDK/板端时间必须区分；不为了消除构建时间提示顺手修改设备时钟。

### 2026-10-15 后续重试：原生新帧恢复，持续预览仍有故障

后续同日重试在原接口恢复了 Sensor 应答；原生 ABI 2 实际取得 3840×2160 NV12，
一次连续 95 次采集成功且 frame ID / SDK timestamp 递增，临时只读预览又完成 505 张图并正常关闭。
这覆盖了“当前始终无应答”的旧观察，但不能覆盖恢复、持续运行和画质尚未验收的边界。
用户报告 IR-CUT 已 OFF，后续实拍明显粉红偏色减轻；近处文字模糊而远处较清楚，
焦点偏远只作为光学排查假设，需真实调焦前后同场景验证。不能用软件锐化宣称修复失焦。

34 个 SDK 模块定向 getter 中，24 个配置模块与 7 个诊断模块可读取；
`hdr_exposure/autofocus/rgbir` 返回 -35。安装头文件将 35 定义为 GET_CONTROL_FAIL，
不是 NOT_SUPPORT（23）。不可全局忽略 -35；私有 disabledIspModules 只按实际 SDK、
Sensor profile、模式及错误证据显式收窄范围，参与 layoutHash，核心 AE/AWB/CPROC 不可排除，
导出明确 configured_public_modules_partial，保留排除项真实错误和完整声明效果库归档。
该能力收窄与模块恢复 scope 通过软件回归，尚未证明硬件写入／恢复可用。

临时预览按有限生命周期运行。过短生命周期会使用户进入页面时服务已退出；
后续一次预览取得 168 张图后报 camera_frame_failed/-43 并正常关闭，网页因此断开。
43 在安装 HBN 头文件中为 NODE_DEQUE_ERROR，但当前桥对 get/copy/release 共用返回值，
仅凭此码不能定位具体步骤或认定线缆、取帧节奏为根因。
失败页面应清除旧图并显示真实状态；重连只能在旧句柄确认关闭后有限重建，不能无限重启、
把旧帧标作新帧或修改 ISP 以掩盖取帧故障。所有这些重试的 ISP setter 次数仍为 0。


### 2026-10-15 调焦后复验：4-lane 有界采集与 CPROC 失败恢复

对上述持续预览故障继续核查时，2-lane 配置的取帧 `-43` 与同次内核中的
MIPI CRC / PHY fatal、SIF 尺寸错误同时出现。这是关联证据，不证明 `-43` 的所有情况
都由同一硬件原因引起；仍需区分 get、copy/cache、release 等具体失败阶段。

随后在 CSI host2 使用当前 SDK 的**完整官方 4-lane profile**，其参数为
lane=4、mipiclk=2880、settle=10、config_index=1；不能只修改 2-lane profile 的 lane 字段。
一次 90 秒有界采集共 299 次成功取图，观察期间没有新增 CRC / PHY 错误；
后续只读预览取得 407 张图，恢复重建次数为 0，并正常关闭。
这些结果支持该板、模组和当次配置下的短时采集可用，不承诺永久稳定，也不代表测得实际 sensor fps。
用户已手动调焦；卡片主要文字可辨识，细字仍偏软，灯部过曝、光晕和暗部颗粒仍存在，
不能将出图或调焦完成直接记为 ISP 画质验收通过。

公开模块基线还发现 `module_control.version` 在 SDK getter 成功时仍出现越界漂移。
成功返回与字段语义有效是两项检查；此类问题须凭实际回读证据显式排除该模块的语义能力，
不能把 version 归零、伪造字段值，也不能为适配错误排除规则而捏造非零 SDK 错误码。
本轮配置基线的公开范围因此为 23 个配置模块的部分 scope；
SDK 返回错误的排除项、SDK 成功但语义无效的排除项和完整效果库字节归档应分别记录。
范围及证据需绑定实际 SDK、Sensor profile、模式和 layout，不能导出为全部模块已通过回读。

CPROC 已做两次实际受控 trial，包装层均返回 `-5`；随后以原始配置 hash、
独立 getter 和新帧确认恢复。此次没有已验证的画质改善，不能推荐候选值。
`-5` 既可能来自 SDK 错误，也可能来自 native 的 `normalized_readback_compare` 失败
所返回的 `-EIO`；在最终阶段诊断明确之前，不能断言固件拒绝了写入。
对失败保留阶段与原码，恢复确认后才能继续新的受控尝试。

同次资料核对显示，官方效果库中 `CP_1_2.state` 为 2，对应 AUTO，不能理解成 CPROC 已关闭。
CPROC 的公开 getter 提供 mode 回读，不应将 AE/AWB 模式回读尚需资格证据的限制机械套用到 CPROC。
但 SDK 接口存在、合法参数范围、实际写入回读与新帧有效仍是分开的条件。
官方文件中声明 BT.709 limited 也只证明文件配置，不能替代运行时色彩矩阵/范围资格或真实输出校验。


### 2026-10-15 最终逐模块定位：核心三模块 scope 的 CPROC 闭环

后续逐模块诊断进一步定位：前述两次包装层 `-5` 出在 `color_process` 的写入/验证路径，
不能继续将其记作 `cproc` 被固件拒绝。`cproc` 的独立 getter 实际返回 mode=1，
四个 manual 字段均与本次请求一致。模块名相近不代表同一 SDK 接口；
批量配置失败必须保留实际失败模块与阶段，不能把整体失败归到正在评价的参数。

本轮随后使用明确的私有配置 `ispConfigurationModules=[exposure,awb,cproc]`，
将可恢复配置快照限定为这三个核心模块，其余 31 个接口只作诊断并保留各自错误/语义状态。
配置范围参与 layoutHash，不能与 23 模块或全模块快照互换，也不能仅凭这个配置开放写权限。
本次实际只修改 CPROC；AE/AWB 没有模式写入资格证据，保持不写。
三个模块在快照中不等于三个模块均已完成写入验收，更不等于 23 模块完整恢复通过。

在上述明确 scope 内，中性手动参考、contrast=1.05 及恢复原始配置三次操作，
实际配置 hash 和新帧验证均通过；scene_generation=0，没有进行效果库场景切换，
journal 最终为 restored，采集后端正常关闭。这证明了本次 CPROC 写入、独立回读、
新帧和原始状态恢复的闭环，不证明效果库热切换、其他模块写入或长期稳定性。

四张现场图像的独立比较仍未证明画质改善：启动早期 original（frame 3）较亮且偏粉，
后续 neutral、contrast=1.05 与 restored（frame 728）更暗，
其中 contrast 候选与 restored 外观十分接近；文字边缘仍偏软，直射灯仍过曝并有光晕。
恢复原配置后仍存在的变暗/颗粒减少，可能来自 AE/AWB 随时间收敛，不能归功于 CPROC。
后续如需比较，应先取得稳定暖机基线，同时记录曝光、增益与白平衡实际回读，
确认多帧波动，再做同场景单变量对照；本轮结果保持“控制闭环通过，画质改善未证明”。


### 2026-10-15 最终暖机对照：保留原始 AUTO

为减少上述启动早期曝光变化的干扰，随后先完成约 20 秒、67 帧暖机；
最后 10 个样本的曝光/增益波动均不超过 2%。本次记录的四个阶段中，
实际曝光均为 23975.30898 µs、增益均为 1；这些回读只支持已观察到的曝光/增益稳定，
AWB 收敛尚未独立取得资格证据，不能据此宣称全部自动算法已收敛。

该轮三次配置操作均完成实际 hash 与新帧验证，journal 最终 restored、
scene_generation=0，后端正常关闭。独立逐张比较暖机后的 original、contrast=1.05
和 restored，未发现可靠的文字细节或噪点改善；保留并确认恢复原始 AUTO。
本轮不推荐 contrast=1.05 为改善值，结论仍为“CPROC 控制与恢复闭环通过，画质改善未证明”。


### 2026-10-15 AUTO 单叶试验与同 stateDir 显式恢复

以下实测绑定 RDKOS 3.5.0、multimedia 3.0.5 / multimedia-dev 3.0.4，
IMX415 3840×2160 linear RAW10、30 fps 的完整官方 4-lane profile。
这是 candidate native + bounded product API 验收，不代表正式插件发布、完整效果库验收或最佳参数。
各轮“完整配置 hash”均覆盖该轮显式配置 scope，不能解释为全部 34 个 SDK 接口或完整效果库字节已回读。

NR2D 在 AUTO 模式只改 `auto_attr.sigma_scale[0][0]`，由 2.0 改为 2.1；
original、candidate、restored 各归档 3 张新帧，独立回读和新帧确认原配置恢复，
原配置 hash 缩写为 `220603a1…5220ac`。候选的平面区域 temporal 指标为 0.880，
原始为 0.873；文字梯度为 3.791，原始为 3.796。这些是同次图像代理指标，
temporal 数值不是标定 SNR，不能据此宣称降噪改善；本轮没有证明画质提升，保留 2.0。

EE 在 AUTO 模式只改 `auto_attr.sharp_gain[0][0]`，由 48 改为 52。
实际 SDK 存储为 `uint16_t[20][2]`；公开单叶 descriptor 保持只读和 `NAN` 范围，
本次 `48..128` 仅是从已安装 preset 提取的私有 operator policy，
不是官方字段范围或已验证硬件安全范围，不得写入公有 schema。
候选 setter、独立回读及写后新帧曾成功，随后 capture 返回 `-43`；
第一次显式恢复虽然完成 set/read，写后新帧验证仍返回 `-43`。
此时保持 `unconfirmed`、`cleanupRequired=true`、`changed=true`，停止新调参；
原生 stop/close 已完成也不能代替配置恢复的新帧证据。

后续已实际跑通的显式恢复顺序如下，复用原私有配置、同一 `stateDir`、journal 和 SDK snapshots：

1. 重建 `Camera`，从 journal 保留原始配置和 `recoveryScope=modules`，不重取当前值作为原始基线。
   先执行 `preview_stop` 清理 fence，再 `backend.open` 初始化后端。
2. 执行 `preview_start` 取得当前流。本次 SDK 在仅 open、未 start 时 getter 返回 `-35`，
   因此必须先开流再准备恢复；这一步没有 ISP setter，也没有重放候选参数。
3. 预检 `write_intent(original, recovering=True, recovery_scope="modules", restarted=True)`
   实际返回 `modules`，并确认已安装效果库文件 hash 与原快照的声明 hash 一致。
   只凭 journal 的 modules 标记不足以跳过此检查；若 intent 变为 library，停止本流程，不能热切库。
4. 显式调用 `restore_tuning` 恢复 journal 原配置。核对请求、应用、独立回读的完整配置 scope hash，
   本次原 hash 缩写为 `2b2b049e…baf1`；再验证并归档 3 张新帧及 SDK 帧号/时间戳，不能只验 setter 返回码。
5. 核对 journal 最终 `outcome=restored`、`recoveryScope=null`，
   `unconfirmed/cleanupRequired/changed` 均为 false，最终 `closed=true`。
   本次 `sceneGeneration=0`，没有执行效果库场景切换。

重建 `Camera` 和 `start` 本身不会自动恢复 journal；`apply_full` 则会重新判断恢复 intent。
失败后只执行原生 stop/close 并保留 journal，不无限重试，也不在关闭时追加恢复：
当 `changed=true` 且 cleanup fence 已清除时，`Camera.close` 会自动再次恢复原配置，
因此显式恢复失败或 modules 预检不通过后，应采用已验证的 backend stop/close 路径，避免重复恢复或意外切库。
已确认 `restored` 后才能结束本轮恢复，并另行判断是否具备继续试验的条件。

此次 EE 故障对应的内核记录仅见 `sensor_frame_end_stop_wait` 的 FE 等待约 108 ms 超时，
没有同次新增 CRC / PHY fatal 记录；不能把先前 2-lane 的硬件错误直接套用，也不能认定 EE 写入导致故障。
候选拍摄视角有变化、仅试一个候选且出现采集故障，不能给予 EE 画质认可或推荐 52。
恢复闭环通过只证明本次恢复，不证明候选改善或连续采集稳定。

本次用户执行冷启动时，必须同时断开板卡电源和 Type-C，随后才观察到 `boot_id` 变化。
仅软重插连接不能当作完整断电；以后需核对实际 `boot_id` 与启动状态，再报告是否冷启动。
机密连接地址、token 和现场用户图片留在仓库外的私有证据目录，知识库只保存脱敏接口顺序与实测边界。

同日恢复后的只读预览补充：前 78 秒 / 262 帧无错误，但继续到第 543 帧时仍出现
`x5w_frame_failed stage=get code=-43`；这次全程 `ispWrites=0`，不能将故障唯一归因于 EE 调整。
关闭旧后端并立即重建后，`hbn_camera_attach_to_vin` 返回 `-207`；
板上 SDK 的 `hb_camera_error.h` 将 207 定义为 `HB_CAM_I2C_WRITE_FAIL`。
内核仅见 FE 等待约 109 ms 超时，尚未确定具体寄存器、底层 errno、供电、线缆或复位时序原因。
本机代码没有复用旧 ctx，成功帧均走 release；`closed=true` 只表示 API 清理完成，
不保证传感器可立即重新初始化，也不能排除 SDK 全局状态或驱动残留。
后续独立新进程采到 279 帧、无恢复重试并正常关闭，说明并非持续无法出图；
此前短时通过记录必须与后续失败一起保留，不能升级为长期稳定结论。

重新取景后另做 CPROC 对比：原始 AUTO → 手动中性配置
（bright=0、contrast=1、saturation=1、hue=0）→ 仅 contrast=1.10 → 恢复原始 AUTO。
三次写操作均有独立读回及写后新帧，最终 scope 为 exposure/AWB/CPROC 的原配置 hash
`076efebd…5f2df` 一致，journal restored、恢复标志清除、sceneGeneration=0、正常关闭。
四张实际图像没有可靠可见的文字可读性改善；候选相对中性的主句梯度约 +0.61%，
局部 P90-P10 对比约 -0.78%，均不足以推荐 1.10，保留 AUTO。
恢复图虽具有相同配置 hash、曝光及增益，局部亮度仍有变化，说明配置恢复不等于图像状态完全等效；
单帧微小统计变化不能作为调参的因果或 SNR 证据。

后续另一次零 ISP 写入预览采到 744 帧后失去新帧，USB 网络 ARP/Ping 与既有局域网连接也同时不回应。
须将“SDK 取帧/相机初始化失败”和“整板不可达”分别保留，不能一概写成 ISP 故障或已确定的供电故障。
该次连接丢失前，多个独立窗口的 SDK frame_id 对 SDK timeval 增长率约 46.435/s，
与 profile 声明的 30 fps 不一致。它目前只是计数/时序异常线索，尚未用独立硬件帧计数或时钟测量验收；
不能直接宣布实际帧率、晶振型号或时钟不匹配根因，也不据此改写 Sensor 寄存器。

### 2026-10-15 晚间：独立时序实测与未通过的候选

后续已用 VIN `fps_stats` 和 SIF `vio_delay` 独立补证：原 profile 声明 30fps，
实际 VIN 约 46.46fps，SIF 相邻 FS 为 21/22ms。停流但保留既有 camera handle，
通过 SDK 读回 VMAX=2250、HMAX=1066 及 24MHz/720Mbps 的 PLL 配置；
板上实际 sensor ELF 的 4-lane 表与官方固定版本逐项一致。
因此已超出“只有稀疏预览帧号”的证据阶段，但模组实装 INCK 仍未直接测量。

仅在私有隔离后端中验证完整 upstream 37.125MHz/891Mbps/4-lane 时序候选：
有效变化共 19 字节，RX aggregate=3564Mbps，HMAX=1100、VMAX=2250，
保留原窗口、保留位及 AE/AWB 模式，MODE operating 后等待 100ms 再启动 XMSTA。
首轮主机计数约 29.993fps、SDK 时间约 30.000fps，SIF FS 为 33/34ms。
在该候选下完成 EE 48→52→48 的写入、完整 scope 回读、9 张图和恢复，
275 次 SDK 取帧、时间戳跨度约 57.93 秒无取帧错误；没有可靠可见的文字改善。
另一次 600 秒预览却在启动时 0 帧 / get -43，内核同时出现 PHY fatal 0x10c、
boundary/sequence fatal、IPI 0x22 reset 与 SIF size 0/0。
**候选不作为默认配置，也不能宣称时钟或稳定性问题已全部修复。**

Sensor/RX 时序不能用 ISP modules journal 代替恢复：先保存独立时序 journal，
原生关闭确认后 fresh 原 backend/profile，核对 RX=2880Mbps、原时序寄存器及
严格递增的新帧号/时间戳，才能标记完整恢复。此次正常退出和一次真实失败退出均已通过。
关闭未确认时不得新建 pipeline；恢复失败保留 unconfirmed，不在 close 中无限重放。

另做 contrast=1.2 的三帧/阶段对比，颗粒更明显、文字无可靠改善，已回原值。
其首张候选近似旧参数、首张恢复近似候选，提示队列或参数反映延迟；
新帧号和 getter hash 不足以单独证明像素已经受新参数影响。
后续 EE 在写后排除 12 帧再比较，仍只属当前缓冲配置的缓解，不是通用队列资格证据。
这些是 Codex 编排的受控实机实验，不冒充模型网关自主 Agent Run 或画质验收。

脱敏实测记录见 [时序与 ISP 证据](../../../artifacts/x5-imx415-timing-20261015/hardware-evidence.json)。

随后只改变 RX settle：由 10 改为 SDK 支持的 0 默认路径，完整时钟候选其余项不变。
单次有界试验 67 次取图、SDK 约30fps、PHY计数为0，退出后 fresh 原 profile 的寄存器与新帧恢复已验证。
再次启动的临时预览在约80秒窗口内 VIN=2486帧、avg_fps=30.003，PHY/CRC/边界/顺序错误均为0。
这是新的有界进展，尚未完成冷启动/多次重开资格或长期稳定验收，不能覆盖前一次 settle10 的失败。
官方 FAQ 将0称自动计算；公开 PHY 源码的0分支保留/读取默认 settle，非零才设置 override，
同时另按 aggregate/lane 选择 HS 频率范围。不要宣称已经执行891Mbps专用自动标定；
该公开源码与板上 kernel 的二进制同一性、最终有效 settle/reset 行为仍未完全核对。
临时预览在有界时间后自动执行 Sensor 恢复、关闭、fresh原RX与新帧核验，不替换全局 sensor 库。

### 2026-10-15 文字场景：AUTO 单分量与像素稳态边界

默认 settle=0 的600秒上限预览已结束：回执1991张预览帧、0次ISP写入、closed=true，
退出后fresh原Sensor/RX完整恢复并独立取得3帧。600秒是请求上限，不是回执独立实测时长；
1991是预览取图数，不能代替VIN总帧数或证明全程30fps。

固定文字场景另保存3840×2160 NV12原始3张、0次ISP setter。随后按原始/候选/恢复各3张：
EE AUTO `sharp_gain[0][0]` 48→56，以及NR2D AUTO `sigma_scale[0][0]` 2.0→1.6，
各有2次setter（含恢复）、独立回读、配置hash及恢复后新帧；两轮独立视觉审查均无可靠文字改善。
这几轮均closed、ISP journal确认恢复，且另经fresh原profile验证Sensor/RX完整恢复；
不替换全局sensor库，不将恢复成功等同于候选有效或画质验收。

首轮NR的前两张恢复图仍可见过渡，说明固定discard12、getter hash和递增frame_id不足以证明像素已稳。
复验在每次capture前持续drain约2.028–2.130秒，实际每次8–23帧，不是每次20帧以上；
原始/候选/恢复共9张，ISP及Sensor/RX均确认恢复。独立视觉审查仍无可靠文字改善；
恢复3张的颗粒与清晰度一致，未再见上一组明显平滑过渡，保留EE48、NR sigma第1分量2.0。
每次记录实际drain时长、帧数及多帧对比；2秒只属本次缓解，`pixelConvergenceQualified=false`，
不能升级为跨SDK、缓冲配置或场景的通用等待门槛。

复用本轮方法时先确认AUTO活动增益槽与插值依据。回读第一槽变更和模式未变，不证明该槽正在参与输出；
analog gain=1也不等于total gain=1，不能单独证明活动槽或插值关系。
2.0→1.6只称sigma第1分量变化，不称“总降噪强度降低20%”。
文字左侧偏糊、右侧较清是持续观察；对焦、景深和卡面/传感器平面倾斜仍是待对照假设，
不能诊断镜头或sensor损坏，也不以数字锐化替代已丢失的细节。
收据SHA-256及分阶段恢复状态保存在上述脱敏JSON；用户原图和原始回执留在私有证据中。

### 2026-10-15 远距离文字对照与 EE64

用户确认焦环未动；物理调整时预览0次ISP写入。拉远并使卡面近似平行后，原EE48下的细笔画
比近景更可分，左糊右清的差距也减轻。这只支持光学几何影响的定性线索：物距、姿态、视场同时变化，
没有单变量物理对照，不能量化锐度收益、认定唯一焦点/景深/倾斜原因或诊断硬件损坏。

在该远景另试EE AUTO `sharp_gain[0][0]` 48→64（该系数+33.33%）。本次operator factorMax=1.34，
结合已安装preset的私有envelope执行；它不是官方推荐参数或硬件范围。候选和恢复的实际计划各恰有
一个edge_enhancement字段，没有改AE/AWB。原始/候选/恢复各3张4K图，9张metadata均记录
exposure=21592.59282052517us、reported gain=1；同一文字ROI各组内部一致，未见明显过渡。
独立视觉审查没有可靠新增笔画或可读内容，背景人员移动不纳入文字ROI，保留48、不晋升best。
ISP原hash、新帧、journal及Sensor/RX fresh原profile恢复均确认，closed=true。

另用安装的官方SDK头编译sizeof/offsetof布局，只解析已归档baseline raw：AE again/dgain/ispgain均1；
EE autoLevel=10，gain轴为1/2/4/8/16/32/64/96/128/255，sharpGain前两行均[48,48]。
这是SDK已归档配置值，没有重新读取当前硬件；即使gain和前两行相同，也未证明effective EE、活动slot
或实际插值结果，不能替代算法生效证据。解析日志及EE64收据哈希保存于脱敏JSON。
仍在运行的局部预览不写closed或完成，后续按真实退出/恢复收据更新。

### 2026-10-15 EE raw current 往返观测

另一次仅作配置观测的probe，将同一EE AUTO首系数48→64→48，实际候选/恢复计划各仅一个叶子；
9次raw SDK getter按原始/候选/恢复各3次，manual/current sharpGainUp为47→63→47，down恒47，
模式AUTO未变，AE again/dgain/ispgain均1。它增强参数采用证据，但仍没有帧applied序号、活动AUTO槽
或插值权重保证，不能标记逐帧应用认证，也不推导表值与current恒差1的通用公式。
该probe没有归档图像；恢复后两次AE曝光发生变化，不作画质ABA，也不替代此前远景9张PNG的质量评价。
ISP scoped恢复、native关闭及独立Sensor/RX完整恢复均通过；默认仍保留EE48/NR sigma首分量2.0。

[官方SDK §5.7.4](https://developer.d-robotics.cc/x5_sdk_doc_v2.0.0/en/multimedia_development/5-ISP_Tune_API_zh_CN.html#interface-description)
说明tuning JSON state2的AUTO可读取current与auto；
[EE头文件](https://github.com/D-Robotics/x5-hobot-multimedia-dev/blob/main/usr/include/isp_feature/isp_ee.h)
将manual结构说明为current配置。normalizer清零AUTO manual分支是可恢复配置hash的稳定化，不能把0当模块关闭。
分别保留raw current诊断和可恢复config hash；软件快照不能替代像素生效或最佳画质验收。
最终4K预览19:55:47以600秒上限启动，最近报告仍运行；没有退出回执前不记closed。
