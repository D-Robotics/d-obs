---
name: d-obs-camera-workshop-validation
description: 调试与验收 d-obs 相机工作台、真实 S100/UVC 和基于实际图像的 AI 自主调试原子能力，并核对 X5/IMX415 点亮与 ISP 资料。用于“AI 自主调试相机”“沉淀相机原子能力”“S100 相机调优”“X5 IMX415 资料核对”“d-obs camera workshop validation”“AI-native camera debug”；区分视频控制、Bayer RAW/板端 ISP 与模型评价，生产发布另用 d-obs-release。
---

# d-obs 相机工作坊验收

复用本仓库的真实设备链路，留下可核对的操作、控制值、图像字节与恢复证据。
用户已授权本次相机操作时持续完成该范围内的流程，不添加逐步确认。
仅在用户要求上线时使用 [d-obs-release](../d-obs-release/SKILL.md)。

## 推进顺序与专家经验

规划相机演示、选择验证模组或排查“能发现 I²C 地址但无法出图/进入 tuning”时，
读 [点亮与 ISP 的现场经验](references/bringup-isp-field-experience.md)。
先用 USB 验证连接、实际采图、场景识别和画质问题发现，再推进 Studio 上真实 MIPI 点亮与 ISP；
现有 USB 调试回执不能自动证明识别任务或 MIPI 已通过。按本次交付目标安排阶段，不重复已验收步骤。
把专家已实际执行成功的 bringup 前置操作记录为可重放步骤；当前 bringup 只启动既有驱动，
新增 Sensor 的设备树/驱动生成与编译部署仍需单独实现、实机验证，不能借接口名称宣布完成。
先核对准确 OS/SDK/驱动/模组版本，再定位控制、RAW 与 ISP；用户提供的旧版本故障案例是排障线索，
不作为所有相机的通用最低版本。画质结论绑定同场景前后图和参数回读，对外推广以前置实机验收为依据。

## X5 / IMX415 资料核对模式

用户先核对亚博 IMX415 在 RDK X5 上的接线、版本兼容或 ISP 工具时，
读 [X5 / IMX415 知识与证据边界](references/x5-imx415-knowledge.md)。
复用厂商资料入口和官方章节定位，保留核查日期、来源与待实机确认项。
资料核对已完成不代表点亮、Bayer RAW 或板端 ISP 已验收；原生 X5 adapter v2 已落代码，
只有官方头文件编译/隔离 SDK 和协议测试通过，目标板链接与硬件仍未验收。
用户要求无相机先做原子能力时，读 [X5 原生软件原子能力](references/x5-native-atomics.md)。
平台知识检索只提供可读事实，设备操作仍按实际 registry、probe 和执行回执判断能力与权限。

## 先确定实际能力

1. 从本任务已有设备登记或保存的私有连接配置恢复板卡连接。
   只展示板型、系统、相机和依赖状态；让 SSH 客户端直接使用凭据，不打印配置全文。
2. 先只读检查 `/dev/video*`、`v4l2-ctl --list-formats-ext`、
   `--list-ctrls-menus`、进程占用及 Python/OpenCV/ffmpeg/Node 可用性。
3. 按回执区分 USB UVC 的 YUYV/MJPEG、Sensor Bayer RAW、板卡原生 ISP。
   `image_raw`、YUYV、JPEG 和普通 PNG 都不能作为 Bayer RAW 成功证据。
4. 阅读 [接口与能力说明](../../../docs/vision-workshop-atomics.md)，
   只为实际实现的操作配置 adapter；不要把平台有原子接口解释成厂商 SDK 已适配。

## 选择已经跑通的链路

板端没有 Node、但有 Python/OpenCV/v4l2/ffmpeg 时，使用：

```text
S100 Python UVC daemon（板端 loopback）
  → 私有 SSH tunnel
  → 本机 Python HTTP adapter
  → 本机 Node SDK runner
  → 本机 d-obs REST / 相机工作台
```

复用以下文件，不复制或重写一套 daemon：

- [vision-uvc-camera.py](../../../tools/vision-uvc-camera.py)：真实采集、控制读写、恢复与停止。
- [vision-uvc-http-adapter.py](../../../tools/vision-uvc-http-adapter.py)：仅连私有 loopback，核对帧哈希并写 runner 制品。
- [vision-workshop-device-runner.mjs](../../../tools/vision-workshop-device-runner.mjs)：固定 argv 的 SDK 桥接协议。
- [vision-workshop-local.mts](../../../tools/vision-workshop-local.mts)：仅监听本机的完整 REST/网页验收入口。

把脚本安装路径、设备节点、端口、token、模型 key、jobRoot、stateDir 写在仓库外的私有配置。
runner 配置用普通文件并设 `chmod 600`；私有 tunnel 不对公网开放。
模型和设备配置不同文件分别供各自进程读取，不把 token 放在命令行、链接或共享回执。
启动命令按实际安装路径调整；本机两个入口的形式为：

```bash
node tools/vision-workshop-device-runner.mjs --config /private/vision-runner.json
node --import tsx tools/vision-workshop-local.mts /private/vision-workbench.json
```

板端 daemon 的入口为 `python3 <已安装脚本路径> --config <私有相机配置路径>`。
本机 HTTP adapter 的命令形状见脚本；将 `{requestFile}`、`{jobDir}` 交给 runner 生成。
用 `/capabilities` 核对平台注册的 targetId/profile/operations 与 runner 实现一致。
本地工作台路径是 `/ops-observability/vision-workshop`；不要误当生产 SSO 验收。
Studio 原生 bridge 的 `RDK_VISION_WORKSHOP_URL` 必须指向服务端回环服务。独占本机模式
按 desktop/local-dev 边界使用；多用户云端另要求真实 SSO 与专用签名账号桥，见
[账号桥工作流](references/studio-account-bridge.md)。配置公开生产 URL 不会替代身份与账号隔离。
独立完整插件的 MCP 连接器与 Studio 原生 companion 是不同包，按各自连接要求验收。

## AI 自主调试模式

新型号、全流程 AI 化或插件原子能力编排，先读插件内的
[通用新 Sensor 工程流程](../../../plugins/rdk-camera-workshop/skills/rdk-camera-workshop/references/new-sensor-ai-workflow.md)。
用 `vision_camera_workflow` 读取实验阶段与下一步；无 adapter 可创建未绑定的资料规划实验，
不能借其他型号的 target。用 `vision_camera_stream_analyze` 分析归档 SDK 计数和时序，
不将它当实时探测或长期稳定认证。
当前 AI 执行器支持原生 `x5-hbn-isp-v2` 快照和实际 rules 的有界 patches，
UVC 继续用 controls values。原始图完整归档，模型观察图带独立哈希、尺寸与源图绑定。
新能力的软件回归与打包通过不等于新型号、当前现场或正式发布已验收。

用户要求 AI 自主调试时，先读 [原子能力与决策契约](references/atomic-tool-playbook.md)。
使用实际部署提供的后台 Agent Run；不要由外部操作员写死参数序列或代填“人工好评”。
代码和部署未提供该能力时说明缺口，不将旧 candidates 统计建议接口冒充视觉 Agent。
检查 `capabilities.aiDebug.status` 为 `available`；旧 `modelEnabled` 不能代替原子能力就绪状态。
选定真实实验后先读取 `vision_camera_readiness`，核对保存证据与 recovery；
其 GET 不探测当前设备，恢复未确认时先显式恢复并实际回读，再发起新 Run。

- 每次 Run 先重新采集当前现场画面及实际控制状态；场景可能变化，不复用旧 PNG 当本轮原图。
- 模型必须收到 ORIGINAL、BEST、CURRENT 的实际图像内容、控制描述符与历史，
  用 `camera_debug_decision` 选择 adjust/keep/restore/stop；不能仅凭亮度统计猜图。
- 保留 `source:model`、model 和 `modelInput:camera_images_controls_and_history`；
  调整后以实际回读和新帧验证，CURRENT 的 improved 与 BEST 比较。
- 按当前契约限制每次最多 3 个支持字段、最多 6 次实际调整及 1 次最终评价。
  这些是执行边界，不是预设调参顺序；模型可提前结束或报告需要检查物理场景。
- 只有可识别场景与目标细节仍保留时，模型才能认定改善或满足目标。
  更暗、单色、空白、噪点增强或只减少全图均值均不能作为成功。
  逐项记录 noise/detail/color/exposure regressions；压高光不能抵消颗粒增加或细节损失。
- 错误或取消须恢复本轮原始状态并回读；完成后可保留已评估的最佳状态，原始版本可恢复。
  模型评价不冒充人工验收，`done` 不自动代表画质通过。

视觉 Agent 已有独立实机 Run 回执，见下方证据；原子链路完成和画质验收仍分开判断。

## Studio 插件接入模式

用户要求在 Studio 内完成时，读 [Studio 原生插件调用与验收](references/studio-plugin.md)。
插件包、技能匹配、MCP 工具实际装配与原生界面须分别验证；只有目录可见或外链能打开不算完成。
复用 d-obs 调试执行器，Studio 负责原生交互、同源接口和本次运行的工具权限；不复制算法。
本机 desktop/local-dev 和多用户云部署按实际身份与配置分别核对。
需要补齐云端同源调用、无相机软件准备或 Runtime 工具时，读 [Studio 账号桥与原生工作区](references/studio-account-bridge.md)。
云端缺少真实账号桥时保持不可用；不要把候选代码和 fixture 验证写成已登录生产验收。

## Workshop 2 交付模式

要求“一份可用 tuning + 一本调优手册”或验收完整闭环时，读
[候选、验收记录与交付流程](references/workshop2-delivery.md)。
用保存的场景、实际图像和参数版本判断交付状态；操作员记录、SDK 加载回读、独立画质认证分别保留来源。

## 历史人工编排验收样例

所有 API 路径以接口文档声明的 Workshop API 前缀为准。
下列顺序用于回归检查原子接口；不作为 AI 自主调试的运行策略。

1. 创建绑定实际 adapter 的实验，记录板型、相机型号、SDK、接口和模式。
   执行 probe、pipeline_validate、controls_get，保存可恢复的原始控制快照及基线版本。
2. 启动预览并核对真实出图。帧文件、采集时间、controls 和 tuningHash 来自同次快照。
3. 手动数值控制若 `active:false`，先单独关闭对应自动模式并实际回读。
   例如先应用 `autoExposure:false`，随后回读曝光范围；不要同时假定失活项可写。
4. 重新 probe 并保存实际基线，再用 capture_frame 归档基础画面。
   自动模式下失活项不能进入 AI 的数值规则；完整控制配置仍保留其当前值。
5. 调用 candidates 生成真实模型候选。确认 source/model/modelInput 与允许路径，
   记录模型是否仅收到 processed-frame 统计和基线；不要声称模型分析了 Bayer RAW。
6. apply_tuning 后使用实际 v4l2 回读生成 readbackHash，与 appliedHash 比较。
   使用完整控制状态及约定的键顺序序列化计算 SHA-256，不能只对 patch 求哈希。
7. 调参后重启采集流并丢弃前 5 帧，再归档新的 candidate capture_frame。
   核对新帧的 tuningHash 等于已确认配置；不能给旧队列帧重新标注候选版本。
   丢弃帧只解决旧队列，不证明自动曝光或白平衡已收敛；必要时观测多个新帧。
8. 读取真实帧统计并记录人工评价，再选择候选、下载 tuning 和实验 bundle。
   UVC 成果格式是 `uvc-controls-v1`，不是板卡 ISP 全模块 tuning。
9. 恢复保存的原始基线版本并实际回读，停止预览和 daemon/tunnel/本机服务。
   shutdown 必须先设 closing 栅栏，拒绝新执行，避免关闭时并发请求重新启动相机。

写入超时或断开后先查实验设备账本和实际控制状态；结果未确认时不盲目重放。
采集中配置变化、帧哈希不符或回读不符时保留失败证据，修正后重跑对应步骤。
不要用 fixture、旧图、请求值回显或固定成功文本替代实机回执。

## 验证与证据

改动涉及设备协议、采集或恢复时，运行相应现有验证：

```bash
python3 tools/vision-uvc-camera.test.py
npm run test:vision-workshop
npm run typecheck
```

X5 改动另跑 preflight/frame/camera/isp/calibration 的 `.test.py` 与 `vision-x5-camera-http.test.mjs`；
提供匹配官方头文件/VP 配置后跑 native Makefile `syntax-check test`。
X5 v2 增加 34 个 typed SDK 接口、私有模块快照、效果库加载/导出、AE/AWB、RAW 回灌及四类离线标定。
以实际 getter、modeReadbackEvidence、数值范围/私有策略与 SDK 绑定判断准入；缺少条件明确失败。
AE/AWB/HDR 的 SDK 2.0 mode getter 未公开保证，未经资格证据不开放模式/手动数值或 RAW 回灌。
完整效果库字节与公开模块读回范围分开记录，BLC 等没有公开 getter 的字段不能声明全值读回通过。

对网页检查实际预览、控制禁用/回读、候选结果绑定、评价/选择、下载和恢复状态。
测试文件通过与板端验收分别报告；共享工作区的无关失败不纳入自己的提交。
共享结果只记录相机能力、实验/制品 ID、配置哈希与检查结果，不写内部主机地址或 token。

2026-10-13 实测证据保存在
[s100-camera-20261013](../../artifacts/s100-camera-20261013/hardware-acceptance.json)：

- RDK S100 的 Integrated_Webcam_HD 通过 USB UVC 输出 MJPEG/YUYV。
- 真实 qwen3.6-plus 候选经实际控制写入、回读、新帧归档、评价选择、ZIP 导出和原参数恢复。
- Bayer RAW 和板卡原生 ISP 均未验证；USB 相机内部处理不等于 S100 ISP。
- 状态为 `passed_camera_workflow_quality_unverified`：闭环跑通，不能据此承诺画质提升。
  实际帧码值统计、画面可读性和校准噪声/色差/MTF 验收须分别记录。
- [保存帧的独立审查](../../artifacts/s100-camera-20261013/quality-audit.json)发现旧 before/after
  仍近乎绿白渐变、缺少可辨识场景；微弱变暗不能升级为画质成功。

2026-10-13 两次 qwen3.6-plus 视觉 Agent 实机 Run 均 completed：

- [第一次](../../artifacts/s100-ai-native-20261013/run-receipt-first.json)：3 次真实写入、4 次模型决策；
  模型 BEST 增加颗粒、整体更差，被独立视觉复核否决；随后 UI restore-original 实际回读确认恢复。
- [第二次](../../artifacts/s100-ai-native-20261013/run-receipt-second.json)：sharpness 2→4，1 次写入、2 次决策；
  无可靠改善，模型自主 stop，平台恢复原始配置并实际回读、新采终态帧。
- 当前保存的终态为原始配置，回读/终态帧 tuningHash 与 original 一致；
  goalSatisfied=false、visualVerification=unverified，没有明显画质提升，不能推荐调参值。
- 正常无改善恢复和 UI 原始恢复已实机验证；取消/故障恢复仍仅有 fixture 覆盖。
