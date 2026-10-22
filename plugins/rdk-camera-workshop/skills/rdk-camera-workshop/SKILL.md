---
name: rdk-camera-workshop
description: 在 RDK Studio 或兼容 MCP 宿主中，将新型号资料核对、适配缺口、点亮、稳定性检查、看图 ISP 调试和恢复交付串成有证据的 AI 相机流程。用于“新相机适配”“相机全流程 AI 化”“从 Datasheet 点亮相机”“自然语言相机调试”“ISP 调优”“camera bringup”，也处理已支持相机、USB 最小闭环、MIPI 失败及相关闪连排查。通用方法可复用；实际驱动和可执行能力取当前适配器与回执，不宣称自动支持任意 Sensor。不用于 YOLO 或 VLM 部署。
trigger: 相机点亮, 新相机适配, 新sensor, 相机全流程AI, Datasheet点亮, 相机调试, ISP, IMX415, MIPI, USB 闪连, RAW, camera bringup, camera tuning
version: 1.2.0
risk: medium
requires_board: false
permissions: network
category: device
enabled: true
---

# 相机点亮与 ISP 调优

使用当前运行中发现的 `vision_*` 工具；Studio 原生桥的名称前缀为
`mcp__rdk-camera-workshop__`。安装插件不安装 Sensor 驱动或原生 ISP adapter。
先检索接入知识，再读取当前设备能力，不以“资料已核对”推断相机已点亮。

用户要接入新型号、把全流程交给 AI，或继续一次跨接线/版本/模式/画质的调试时，
先读 [新 Sensor 的 AI 工作流与证据状态机](references/new-sensor-ai-workflow.md)。
它将资料与驱动开发、真实原子能力、同场景看图、恢复和交付分开推进；
已有成功证据可复用，但不能越过本次模式、采集和恢复的缺口。

X5 / 亚博 IMX415 的版本兼容、接口与 lane、旧 SDK、开流失败、恢复或 USB 网络问题，
先读 [兼容性与失败恢复](references/imx415-compatibility-and-recovery.md)。
其中实机记录是历史证据；本次状态仍取当前 probe、getter、新帧和恢复回执。

## 团队经验与阶段规划

涉及快速点亮、USB 最小闭环、相机选型/供货、未点亮素材、专家步骤沉淀、旧版本 I²C/tuning 故障、雾感/彩噪或对外演示时，先读 [点亮与 ISP 现场操作指引](references/bringup-and-isp-field-playbook.md)。知识详情中的 `teamExperience` 同步提供可检索的经验、来源和证据要求。

按目标和已有证据选择 USB 基础闭环、Studio 真实 MIPI、原生 ISP 与场景验收阶段。用户已指定阶段时从缺口继续，不强迫重跑已通过步骤。先确认目标板上的初始状态，不把供应商既有驱动的复用当 AI 从零适配。优先读取准确版本的 Datasheet/Tuning guide，避免盲目扩大调参次数。

历史版本、供货、全志对标和画质改善案例标为用户报告，需本次核实；不是官方最低版本、现有库存或本平台成功回执。标定文件缺失 warning 只有在匹配版本的默认/回退效果库和实际出图均得到证据时才可判为不阻塞。专家流程没有实际操作记录时列为待采集，不臆造自动化步骤。

## 任务范围与面向用户的结论

`bringup` 使用已适配的驱动和采集模式启动相机，不生成新 Sensor 驱动、设备树或寄存器初始化代码，也不自动编译部署。用户要求接入尚未支持的新相机时，先核对资料、电气兼容性和缺口，明确当前未覆盖的驱动开发步骤。

无驱动时仍可由 AI 形成工程任务并在用户授权的宿主开发工具中完成真实源码补丁、
匹配 SDK 构建与隔离测试，再接入适配器并实机验证。当前没有通用驱动生成/发布 API；
不自造 MCP 名称，不把私有 SSH helper 打包，也不用任意 shell 绕过设备原子接口。

先说明本次能做什么、卡在哪里及具体下一步；能力配置不表示设备在线。结束时先报告目标是否达到、当前实际参数是否确认、终态新帧和噪点/细节/颜色/曝光退化，再按需展示历史推荐与回读哈希。恢复错误优先于旧成功状态；缺少终态证据时报告未确认。


## 先确认本次可以执行什么

1. 用 `vision_camera_knowledge_search/get` 检索用户给定板型和型号。
   X5 亚博 IMX415 的知识 ID 为 `x5-yahboom-imx415`；来源事实与实机证据分开报告。
2. 读取真实 `/capabilities`：有 `vision_workshop_runtime_status` 时直接调用；否则先用
   `vision_workshop_capabilities` 发现目录，再通过 `vision_workshop_execute` 执行目录中的 GET。
   前者是运行状态，后者是操作目录，二者不能混用。
3. 只选择当前登记且板型、Sensor、接口、SDK、模式匹配的 targetId。
   缺少原生适配器、接线或实际模式时，说明缺口并停止对应硬件操作。
   不能以 S100/UVC 成功记录覆盖 X5 MIPI、Bayer RAW 或原生 ISP。
4. 列出或读取当前身份实验。有 typed `vision_experiment_list/get/create` 则使用；否则
   用当前目录中的 GET/POST 经 `vision_workshop_execute` 执行。已有匹配 adapter 时绑定它；
   新型号尚无 adapter 时，可省略 targetId，以 title、goal 和真实已知相机信息创建未绑定实验，
   用 workflow 读取 missingAdaptation 并推进资料/工程规划。该分支不操作设备，
   不借用其他 Sensor 的 targetId；硬件执行前才必须绑定真正匹配的 adapter。
   不自行构造主机、shell、下载地址、SDK 索引或凭据。
5. 目录提供 `vision_camera_workflow({experimentId})` 时读取保存的阶段诊断与 nextActions，
   按实际缺口选原子工具。它不探测设备，历史阶段不证明当前连接或画质。
   `vision_camera_stream_analyze({experimentId,runIds?,expectedFps?,tolerancePercent?,minimumDurationSeconds?})`
   只分析本身份已归档的 SDK 帧证据；需要新的连续采集时另用已支持的相机工具取得新证据。

## 自然语言点亮与调优

- 用户要求点亮时，调用 `vision_camera_probe`、`vision_pipeline_validate` 和
  `vision_camera_bringup`；逐项读真实失败/成功检查。再启动预览并采集当前新帧。
  保存尺寸、时间、配置哈希与图像来源；没有可辨识现场图像不能报告画面正常。
- X5 HBN 首版采用 probe → bringup → pipeline_validate 新帧的顺序。
  开流前 `actual_stream_required` 是待点亮状态；获得本次点亮/调优授权后执行 bringup，
  再校验实际帧。probe 不初始化 Sensor；先点亮并取得原始快照，再提交 AI 调优 Run。
- 用户要求画面控制调优时，先核对 `controls_get` 的支持范围、可写/active 状态，
  原始配置与恢复能力。实际配置和模型具备所需能力时，用 `vision_ai_debug_start` 提交目标，
  用 status 轮询真实 Run。模型看原始、最佳与当前实际图像，不在技能中写死参数序列。
  探索预算由 `maxRounds` 显式声明（1–6，默认 4）；限时演示、课堂或受控场景按授权压缩到 1–2，
  并在目标中写明允许的调整上限，不依赖模型自行收敛。status 的 `adjustmentCount` 是实际写入轮数。
- 原生 ISP AI 路径要求实际 probe.baseline 为本次声明 scope 的完整 `x5-hbn-isp-v2` 快照、真实允许 rules，
  且适配器支持 apply_tuning。模型的 adjust 只返回 `patches:[{path,value,reason}]`，
  每轮最多三个已列入规则的数值叶子；执行器将补丁合入完整快照后应用、独立回读和采新帧。
  UVC/普通控制路径仍用 `values`，两条路径不能混用。AUTO 下只写被实际规则开放的活动表叶子，
  不以保存的 manual_attr、效果库数值或其他型号经验扩大范围、切换模式或开放 AE/AWB。
- 用户要求原生 ISP 时，先核对实际 SDK tuning schema、应用、回读和恢复；
  需要 RAW 采集/回灌的目标再核对实际 Bayer RAW 能力。
  使用实际支持的 `vision_raw_capture`、`vision_isp_generate/process_raw/apply/restore`。
  `process_raw` 需先确认 SDK 回灌支持；允许数值路径来自真实基线，不编造厂商字段。
  基线导入可用 typed `vision_tuning_baseline_import` 或目录中的 baseline 操作。
- IR-CUT 与手动调焦若未提供软件原子接口，按知识前提交给实际操作员处理。
  标定算法计算、SDK 参数应用与光学/画质验收分别记录，缺少实际测量不能互相替代。
- 先读 probe；X5 原生路径须先成功开流并取得新帧，再读取 typed controls 与保存原始快照，
  不在开流失败后硬试 getter/setter。以当前 SDK 回执确认 AE/AWB、CPROC、模块和模式支持。
  新版原生格式 `x5-hbn-isp-v2` 需要匹配的 ABI 2 库；已有 ABI 1 只支持 MANUAL CPROC。
  缺库时只进行只读预检，配置声明不代表相机、库或全部模块已验收。
- 读取每轮新帧、真实回读、停止原因、最终版本及恢复回执。模型 improved/done、
  全图变暗或统计变化不等于画质通过，不代填人工评分。
  写入回读正确也不证明像素响应或目标改善；构图变化、自动算法未稳定、只有平面/单帧时，
  分别保留比较限制，不编造 SNR。目标细节、噪点、颜色或曝光明显回退时否决候选。

## 原生 ISP 与标定

选定实际实验后先读取 `vision_camera_readiness`。它只投影保存的阶段证据、缺少的操作和恢复状态，不探测当前设备。`recovery.status=unconfirmed` 时先显式恢复并核对实际回读和新帧，恢复确认后才启动新调试；历史 `observed` 不证明当前在线或画质达标。

用 `vision_isp_tuning_get/export` 保存实际 SDK getter 快照、支持范围及版本；
完整效果库与公开模块快照是不同读回范围。`vision_isp_tuning_load` 只提交 experimentId、
私有 SDK JSON 的 contentBase64 和 sha256，不传文件路径或 shell。写后必须有独立 SDK
getter/效果库回读、输入哈希及恢复证据；unknown mode、缺 SDK、未接相机或不一致保持
未就绪/未确认。候选按已声明的 float32 或 seconds-float32-us 精度量化并复查范围。

用 `vision_calibration_asset_import/list` 归档真实测量与原资产哈希，
`vision_calibration_task_create/list/get/run/result` 执行和读取 BLC/LSC/CCM/AWB 离线任务。
软件算法结果不能宣称光学标定或画质真机验收。先用 `vision_calibration_apply_plan`
检查 trusted result 的 SDK 映射和前提，再在授权与适配器支持内使用
`vision_calibration_apply`，只传 taskId 和 options，服务读取可信结果，不能提交模型伪造参数。

RAW 回灌仅在适配器声明支持时使用 `vision_isp_process_raw`。核对 RAW/tuning 哈希、
独立读回、匹配回灌输出的帧 ID/提交时间、AE/AWB manual 与 live 恢复。
旧 live 帧不能证明回灌成功，提交时间回显不能宣称 sensor 时基。

## 禁止事项

- 写工具包括 controls_set、AI debug start/restore、ISP apply/restore/tuning_load、
  calibration_asset_import、task_create/run 和 calibration_apply；保持实际宿主审批边界。
- 不伪造硬件验证、标定、独立 readback 或恢复成功；按当前证据分别报告成熟度。
- 不用板端 shell、任意路径、寄存器写入或 I²C 扫描绕过平台原子能力和授权。

## 失败、取消与交付

写操作继续遵循宿主已有权限与审批边界；本技能不授予权限，也不增加逐步审批。
超时或断连可能已经写入：先查实验 `deviceRuns` 与实际控制，禁止盲目重放。
取消后轮询到真实恢复回执；无法确认恢复时报告 unknown/failed。
配置离线恢复与恢复后的开流/新帧分别核对；配置 hash 匹配而取帧失败时保留流恢复未确认，
不清除 recovery fence，不以恢复命令返回成功或关闭句柄冒充终态画面已验证。
导出实验制品、原始与最终参数哈希、来源和未验证项。
普通 ROS `image_raw`、JPEG/PNG、NV12/YUYV 与 UVC 控制不能作为 Bayer RAW 或 X5 原生 ISP 证据。


## Workshop 交付与验收

先发现实际工具目录。新版 `vision_workshop_delivery` 读取本实验交付缺口、参数目标、验收标准和记录；无设备可先用 `vision_acceptance_plan_save` 保存场景、照明、必验项目、测量方法/单位及阈值。用 `vision_delivery_target_select` 显式选择目录返回的交付版本；保存观察记录不会暗中改选版本。

`vision_acceptance_record` 仅经明确授权记录操作者实际提供的观察或外部测量报告，并绑定本实验图像与参数哈希。不能替用户编造测量值、视觉通过意见或人工评分。模型判断、PNG 输出统计和外部录入的校准测量分别标注；`recorded_pass` 仅说明保存记录满足项目阈值，不能写成独立画质认证。

厂商候选库必须有匹配真实 SDK、模式、原模板和模块的服务端字段绑定，完整覆盖已修改字段。原归档效果库、私有快照控制配置和新生成厂商 JSON 分别说明。生成候选后经原生界面下载/归档，再用 `vision_isp_tuning_load` 的 `artifactRole: vendor_effect_library_candidate` 显式加载；缺生成回执、绑定或字节校验时停止。仅指定角色不构成通过。

核对独立 SDK 回读、本轮新帧、必要的新 SDK 会话重载及原始参数恢复。`fresh_session_reload_recorded` 仅是匹配 profile 下的 SDK 会话重载记录，不保证任意新系统/板卡无需配置。交付 ZIP 包应有 delivery.json、调优手册、实际图像与版本证据，生成的厂商候选另归档为 vendor-tuning/<id>.json；无候选不伪造文件。
