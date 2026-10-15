# 通用视觉工程原子能力

本模块将相机点亮、采图、调优、评估和交付拆为公共原子接口，网页和 Agent 调用同一业务服务。相机、板卡与 SDK 的差异由服务端适配器和工作模式配置描述，实验和候选不预设厂商或型号。代码开发及本地协议验证不需要连接当前设备。

工作台：`/ops-observability/vision-workshop`。日志调查页有「视觉 Workshop」入口。

REST 契约 `rdk.vision-workshop.v1`，前缀 `/api/ops/observability/vision-workshop`。

MCP endpoint：`/api/ops/vision-workshop/mcp`。生产反代部署在 `/dobs` 下时，以上地址均增加 `/dobs` 前缀。

## 点亮范围与接入引导

`bringup` 启动已适配的传感器驱动和采集模式；平台当前不会根据说明书生成新 Sensor 驱动、设备树或自动编译部署。新增相机需先完成这些工程准备，再接入本模块。

工作台首先显示本实验的接入检查、缺少能力和具体下一步，区分文件导入、连接未登记、身份不匹配与最近探测失败。检查连接由显式按钮调用 probe；加载页面不会自动操作设备。新建时只有一个已登记相机可预选，设备信息自动填入并折叠，仍可明确选择文件导入。

AI 按同一设备的 probe、controls_get、controls_set、capture_frame、restore_tuning 与看图模型状态启用，准入列表与后台执行器共享。接口已配置、设备在线、实际出图和画质通过分别报告。

结果先展示目标结论、最终参数、终态新图、AI 观察与退化项。历史推荐和每轮明细折叠。恢复错误或缺少最终回读覆盖旧成功状态，终态采图失败不使用历史图替代。人工恢复成功后重新采图；配置回读、图像失败及目标结果分别记录，成功重试清除旧恢复错误。

## AI 看图调试入口

新型号接入先使用 `vision_camera_workflow`（GET `/experiments/:id/workflow`）：
按本身份实验、匹配 profile 和保存的探测、采流、参数、恢复证据返回阶段、阻塞、下一步真实工具及必要证据。
它不执行硬件；恢复未确认优先于新调参，无驱动时返回资料、时序、源码、编译及实机验证缺口。
AI 宿主按用户已授权范围调用原子工具，不把此只读流程投影当成已启动的后台任务。

`vision_camera_stream_analyze`（GET `/experiments/:id/stream-analysis`）只分析本实验 deviceRuns 和 AI Run 保存的 SDK 帧证据，
可选 runIds、expectedFps、tolerancePercent、minimumDurationSeconds。按配置、身份、重启和故障分组，不接收客户端帧或统计。
结果是帧号和时间增长率及资格限制；expectedFps 是比较目标，不能当已测外部时钟，短窗口不能证明长期稳定。

原生 `x5-hbn-isp-v2` 的 AI 决策使用当前 probe 返回的完整配置与实际可写 rules，每次最多 3 个数值 patches，
由 SDK apply_tuning、应用和独立回读完整哈希、新采图确认；缺少规则或应用能力时不降级绕过。
UVC 保留 controls values 路径。动作仍受当前 SDK 资格、字段范围、精度与恢复状态约束。
4K 原始 PNG 保留为证据；模型观察图由实际像素区域均值生成，最大 1280×720 和 1 MiB，
分别记录 sourceSha256、derivative sha256、原始和观察尺寸、方法。观察图不是精细纹理或标定质量的独立验收。

工作台默认先展示自然语言目标与「让 AI 开始调试」，手动设备、采图、参数和人工评价工具位于折叠区。开始前不要求用户填写 tuning JSON 或手工准备样本：后端在已绑定的设备上读取完整原始配置，采集实际 PNG，向看图模型提供原始、当前、最佳图像、真实控制范围和历史动作，由模型选择 adjust / keep / restore / stop。

看图调试与旧的统计参数候选分开展示和能力发现，复用已经配置的模型网关，没有新增独立模型凭据。`capabilities.aiDebug.status` 表示模型配置及所需设备原子能力是否准备好；`modelEnabled` 为 true 不能证明采图、控制与完整恢复能力齐备，实际看图和工具调用还需运行验证。模型输入标记 `camera_images_controls_and_history`，每轮来源明确为 `source:model`。AI 的 improved、sceneUsable、goalSatisfied、issue 和文字解释不写入人工评分表。画面没有可识别内容时，应停止并说明场景问题，不能仅因亮度下降就宣布调优成功。

每轮还检查噪点/颗粒、文字及边缘细节、颜色和曝光回退，模型将观察写入 `assessment.regressions`，issue 可以为 noise。存在这些退化时不能同时声称 improved 或 goalSatisfied，也不应选为新的 best。AI 曾选出的 best 仍可能判断错误；操作者发现整体更差时应恢复原始配置，保留模型历史决定供复盘。已恢复后，旧 best 只作为历史推荐图展示，最终设备画面使用恢复并回读后的新采集图；新采图失败必须显示 imageError，不能用历史图片替代当前状态。

异步运行保留原始完整配置、每次实际采集的文件及哈希、模型决定、请求变化、真实回读和最终恢复状态。最多 6 次参数调整；额外的最终观察不算一次调整。运行期间独占绑定设备，网页继续读取进度；手动写入在任务结束后开放。正常结束保留经过采图和回读的最佳版本；没有可用改善时保留原始参数。停止或失败时尝试恢复原始完整配置；恢复失败明确显示 `restorationError`，不能把停止请求当作已经恢复成功。

| 请求 | 功能 |
| --- | --- |
| POST `/experiments/:id/ai-debug` | `{goal,maxRounds?}` 开始后台看图调试；返回 202 与 run，不等同于任务完成 |
| GET `/experiments/:id/ai-debug/runs` | 读取该实验的持久运行记录 |
| GET `/experiments/:id/ai-debug/runs/:runId` | 查询状态、各轮图片/判断/回读、最佳和最终设备状态 |
| POST `/experiments/:id/ai-debug/runs/:runId/cancel` | `{}` 请求停止；`cancelRequested:true` 表示等待当前操作结束与参数恢复回执 |
| POST `/experiments/:id/ai-debug/runs/:runId/restore-original` | `{}` 在任务结束后恢复本次运行前保存的完整配置，并核对实际回读；不把控制快照随意拆成普通设置请求 |

状态为 queued / running / completed / failed / canceled / interrupted。刷新或重新打开实验可以找回进度与证据；页面离开不自动停止后台任务。网页仅在可见时轮询状态，网络错误显示「任务状态未确认」并继续查询，不能制造完成结果。所有接口沿用现有身份、实验隔离和修改守卫，后台运行使用开始请求确定的身份。

## 能力与真实性

| 原子工具 | 输入与结果 |
| --- | --- |
| `vision_ai_debug_start` | 用 goal 与可选 maxRounds 启动真实图像、控制与工具调用的自主调试运行；202 仅表示已经启动 |
| `vision_ai_debug_status` | 读取 runId 的真实帧、模型判断、请求变化、实际回读和最终恢复状态 |
| `vision_ai_debug_cancel` | 请求取消后等待后台恢复回执；不会把 cancelRequested 当作完成 |
| `vision_ai_debug_restore_original` | 运行结束后恢复本次保存的完整原始配置并核对实际回读 |
| `vision_camera_probe` | 按实验选定的服务端 SDK adapter 探测相机，归档非空事实回执 |
| `vision_pipeline_validate` | 检查当前 SDK 的媒体 Pipeline，保留每项检查；失败返回实际失败状态 |
| `vision_camera_bringup` | 调用与相机及 SDK 匹配的预配置初始化/编译/启动适配，记录验证结果 |
| `vision_camera_preview_start` / `vision_camera_preview_stop` / `vision_camera_preview_frame` | 启停实际设备预览，读取实际 PNG/JPEG 帧字节；不把设备私有 URL 交给浏览器 |
| `vision_camera_controls_get` / `vision_camera_controls_set` | 读取相机支持的参数、范围和实际值，设置后回读；不支持的控制不会显示为可用 |
| `vision_camera_capture_frame` | 保存处理后的实际视频帧、相机身份、控制快照和文件哈希，与 Bayer RAW 分开归档 |
| `vision_raw_capture` | 采集场景 Raw，核对真实文件、格式和 SHA-256，保存采集信息 |
| `vision_isp_generate` | 根据保存 Raw 的统计、基础 tuning、数值参数规则和目标生成 AI 候选 |
| `vision_isp_process_raw` | 将已保存 Raw 和确切参数版本交给 SDK 处理，归档实际 PNG/JPEG 输出 |
| `vision_isp_apply` | 应用确切候选版本，要求应用和回读哈希都匹配；参数已应用不等于画质验收 |
| `vision_isp_restore` | 恢复已保存的基础配置或候选版本，同样要求真实应用与回读哈希匹配 |
| `vision_isp_tuning_get` / `vision_isp_tuning_export` | 读取实际 SDK 全模块快照及规则；导出输入效果库JSON和独立公开模块读回，未公开字段保留限制 |
| `vision_isp_tuning_load` | `{contentBase64,sha256}` 加载有界SDK JSON，不接受文件路径；存原版后SDK scene调用、独立getter并更新实际baseline |
| `vision_calibration_asset_import/list` | 导入或列举有本身份原资产哈希与ROI依据的色卡线性测量 |
| `vision_calibration_task_create/list/get/run/result` | 从拥有RAW/测量资产创建BLC/LSC/CCM/AWB任务，实际运行CPU NumPy，持久manifest、输出哈希和失败/中断状态 |
| `vision_calibration_apply_plan` / `vision_calibration_apply` | 只读计划与实际应用分开；应用从已完成任务读取可信结果，经私有SDK绑定进入setter/效果库并独立getter；画质未经验证 |
| `vision_image_evaluate` | 对已保存图像记录人工 1–5 分与说明，来源明确为 manual |
| `vision_image_compare` | 同一 Raw、同一基础参数版本下，对 PNG 输出计算客观码值统计 |
| `vision_workshop_export` | 导出候选 tuning、调优手册、版本清单、实际图像与评价 ZIP |

这些工具都要求 `experimentId`；具体参数以 `tools/list` 的类型定义为准。`vision_workshop_capabilities` 可发现操作目录，`vision_workshop_execute` 可调用目录中的完整 REST operationId。新接口也注册进现有平台助手能力目录。

设备操作只有在服务端配置匹配的 adapter 后可执行。没有 adapter 时返回明确的 unavailable；缺失 SDK command 时不会运行替代脚本或制造成功结果。初始化寄存器序列、驱动和媒体链路由实际相机及固定版本 SDK 实现负责。配置了 adapter 不等于设备在线或已经完成点亮。

手动工具中的旧 AI 参数候选输入是 **真实样本统计和已有数值参数的投影**。有 Bayer RAW 时使用 RAW 统计；只有视频帧时使用保存的实际 PNG 输出统计，`modelInput` 为 `processed_frame_statistics_and_baseline`。默认只选择当前基础配置哈希匹配的最新最多 16 张 PNG，旧基础版本的帧不会混入新基线；可用 `{frameIds:[...]}` 明确选择匹配帧。没有匹配输入时必须重新采集。视频帧输入、RAW 输入分别保留 ID 和哈希，没有声明通用模型直接理解 Bayer 文件或已经完成专业画质标定。模型的可选 `cameraContext` 由服务器从保存的实验或选定 profile 读取实际事实，不能由生成候选的请求任意覆盖。缺失上下文时仍可生成受限候选，不推测板卡、厂商、型号、SDK、接口或模式。候选只修改数值规则允许的现有路径、范围与步长；模型失败直接报错。基础 JSON 的其他字段原样保留；数值规则并不能替代完整厂商 SDK 格式验证，仍须经实际 SDK 加载与回读。

Raw PNG 预览只用于查看采集输入，不能充当 ISP 输出。上传的处理图明确标记 uploaded；由 SDK runner 返回的图标记 runner。人工评分、客观统计、配置回读与完整画质验收分别记录。

## 相机接入知识

工作台的「相机接入知识与验收证据」折叠区按需读取审定资料；打开页面不会额外查询知识或执行硬件。
REST 契约为 `rdk.vision-knowledge.v1`，沿用本模块前缀和现有运营权限。

| 请求 / MCP 工具 | 功能 |
| --- | --- |
| GET `/knowledge` / `vision_camera_knowledge_search` | 可选 `q`（≤160 字符）、`board`、`sensorModel`（各≤100 字符）；返回知识摘要及当前适配器配置状态，无需实验 ID |
| GET `/knowledge/:knowledgeId` / `vision_camera_knowledge_get` | 读取系统/接线条件、来源与原文件哈希、调试顺序、原子操作前提/回执和能力缺口；MCP 参数为 `knowledgeId` |

两项只读操作显式注册进平台助手能力目录，也可通过 `vision_workshop_execute` 调用。
知识查询不会创建实验、探测板卡、启动预览或写入配置。`capabilities.knowledge` 提供契约与检索路径。

首份知识 `x5-yahboom-imx415` 覆盖亚博 IMX415 与 RDK X5，保存厂商镜像/包条件、22pin 同向排线、
I²C 地址、IR-CUT/手动调焦、旧镜像限制、工具主机及 SDK 版本边界。
来源区分厂商和官方，附 PDF 页码、表格定位及此次核查文件的 SHA-256；不保存提取码、主机、token 或本机路径。

`verification.documentation=verified` 只表示资料核对，`verification.hardware=unverified` 表示本知识没有实机验收证据。
`readiness.status=adapter_unavailable` 表示当前未配置板型、Sensor、MIPI 接口一致的适配器；
`configured_unverified` 只表示配置匹配，不证明 SDK/模式正确、相机在线、RAW/ISP 已生效或画质通过。
每项 `readiness.atomics` 单独报告 `unavailable`、`configured_unverified` 或 `manual_required`，
同一组操作必须由一个匹配 adapter 完整实现，不能跨设备拼出可执行链路。

X5 原生适配器首版已实现，见 [原生原子能力与接入说明](vision-workshop-x5-native.md)。
HBN 管线/帧采集与 MANUAL CPROC 读写/恢复通过官方头文件编译及软件测试；
v2 已实现 AE/AWB、效果库与 RAW 回灌的软件调用链；目标板链接、真实 RAW 布局、SDK 模式资格与 ISP 生效仍待实机验收；
知识记录不是设备 profile，不进入新建实验的执行适配器选项，也不开放设备按钮。
BLC/LSC/CCM/AWB 离线计算已实现；实际测量条件、SDK 字段绑定与画质仍需验证。真实 RAW 回灌及模式资格通过后才开放 `process_raw`。
后续升级知识事实时保留来源和核查版本，实机成功需引用本次实验/运行回执，不能改写文档状态代替操作证据。

## 七项功能在网页中的实现

| DDC 功能 | 工作台入口与证据 | 设备前提 |
| --- | --- | --- |
| 启动已有驱动与出图验证 | 实验绑定 profile，执行探测、媒体链路检查、点亮验证；主视图展示简短事实，原始驱动输出折叠；失败记录保留 | 对应驱动与 SDK 包装器已经实现，不能从规格资料直接保证任意新相机点亮 |
| 预览与曝光控制 | 鉴权读取实际预览帧，按设备回读的范围调整控制并再次回读 | adapter 声明 preview 与 controls 操作；自动曝光/白平衡下 inactive 的手动项不可编辑 |
| 多场景 RAW 采集 | 填写实际场景后执行 capture_raw，保存 SDK 元数据与真实字节；可导入外部 RAW | 相机/SDK 能导出 Bayer RAW；仅提供 YUYV/MJPEG 的 UVC 相机不启用此按钮 |
| AI 参数候选 | 保存真实基线与数值规则，再用 RAW 或视频帧统计生成有限候选；逐项展示原值、候选值和理由 | 模型网关明确启用，实际参数路径、范围、步长与当前自动模式一致 |
| 应用与前后对比 | 应用并回读候选，同一 RAW 可在 SDK 分别处理基础/候选；视频相机应用后重新采集；并排图支持局部 ROI、适应窗口与原始像素放大，支持恢复版本 | SDK/相机实现 apply/restore；视频前后两次采集不保证同一输入，不能冒充同一 RAW 对比 |
| 评估与反复调整 | 保存人工评分、依据和剩余问题，再继续下一轮；匹配版本的同一 RAW PNG 可以保存 ROI 统计，视频帧可单独读取码值统计 | 真实结果图、参数与场景证据；统计不是校准噪声、色差、MTF 或自动达标判定 |
| 导出成果 | 可随时下载实验记录 ZIP，保存实际帧、输出图、版本清单、控制快照、执行记录及手册；完成评价并选择候选后导出 tuning | 输出格式以 adapter 为准；`uvc-controls-v1` 是 UVC 控制配置，不是 MIPI ISP 全模块 tuning |

创建或打开实验不会自动执行硬件操作。按钮仅按本实验绑定的 adapter.operations 开放。预览必须由用户点击启动；切换实验时先停止旧设备预览，离开页面前应点击停止。高频 preview_frame 与只读 controls_get 返回实际回执，不逐帧增加持久账本；写入、采集与检查会归档操作结果。失败/超时后刷新设备执行账本，写入结果未确认时不自动重试。

## 实验与资产接口

| 请求 | 功能 |
| --- | --- |
| GET `/capabilities` | 模型状态、已配置 adapter、额度与原子操作目录 |
| GET/POST `/experiments` | 列出/创建当前账号实验；创建字段 title、goal、可选 board、sensorVendor、sensorModel、sdkVersion、cameraInterface、cameraMode、targetId |
| GET `/experiments/:id` | 查询 Raw、基线历史、候选、图像、评价、比较和设备执行账本 |
| POST `/experiments/:id/baseline` | `{config,rules:[{path,label,min,max,step?}]}` 导入真实基础配置与允许调参路径；网页也可重新探测并保存设备当前参数 |
| POST `/experiments/:id/samples` | 上传真实 Raw |
| GET `/experiments/:id/samples/:sampleId` | 服务端解包统计与受保护预览/下载地址 |
| POST `/experiments/:id/candidates` | `{goal?}` 生成 AI 候选，不自动应用 |
| POST `/experiments/:id/results` | 上传实际结果图并绑定 sampleId 和可选 candidateId；省略 candidateId 表示基础配置输出 |
| GET `/experiments/:id/frames/:frameId` | 鉴权读取已保存实际视频帧，和 RAW / ISP 处理结果分开存储 |
| GET `/experiments/:id/frames/:frameId/analysis` | 对实际保存的 PNG 计算码值统计；可选 `?roi=<JSON>` 指定区域；不表示同一 RAW 的前后对比 |
| POST `/experiments/:id/evaluations` | `{imageId,rating,notes}` 记录人工评价，imageId 可以是 ISP 结果或保存的视频帧 |
| POST `/experiments/:id/comparisons` | `{baselineImageId,candidateImageId,roi?}` 客观对比同一 Raw 的基础/候选 PNG |
| POST `/experiments/:id/selection` | `{candidateId}` 选择已有结果图和人工评价的候选 |
| GET `/experiments/:id/tuning` | 可用 `?candidateId=...` 指定版本，否则下载选定候选 |
| GET `/experiments/:id/bundle` | ZIP；`?includeRaw=1` 包含原 Raw，默认以清单记录大文件 |
| POST `/experiments/:id/device/:operation` | probe、pipeline_validate、bringup、preview_start、preview_stop、preview_frame、controls_get、controls_set、capture_frame、capture_raw、process_raw、apply_tuning、restore_tuning |

典型编排：创建实验 → 导入已验证基础配置 → 探测/校验/点亮 → 采集 Raw → 生成候选 → 基础/候选分别处理同一 Raw → 客观比较和人工评价 → 选择候选 → 参数应用与回读 → 导出。

UVC 编排：创建并绑定相机实验 → 探测/检查/预览 → 读取控制 → 必要时关闭自动模式并回读 → 重新探测保存实际基线 → 保存场景视频帧 → AI 生成支持范围内的候选 → 应用并回读 → 重新采集候选效果 → 人工评价并选择 → 导出控制配置、图像与手册 → 恢复原参数。该流程不声明 Bayer RAW 或板卡原生 ISP 全模块调优已经验证。

设备请求：preview_start/stop/frame、probe、pipeline_validate、bringup、controls_get 使用 `{}`；controls_set 使用 `{values:{exposureUs?,gain?,brightness?,contrast?,saturation?,gamma?,sharpness?,whiteBalanceTemperature?,autoExposure?,autoWhiteBalance?}}`，具体项以实际控制描述符为准；capture_frame 使用 `{scene?,candidateId?}`；capture_raw 使用 `{scene}`；process_raw 使用 `{sampleId,candidateId?}`；apply_tuning 使用 `{candidateId}`；restore_tuning 使用 `{baselineId?}` 或 `{candidateId?}`，空对象恢复当前基础参数，两种版本不能同时指定。

控制回执是 `{controls:{字段:{value,min?,max?,step?,writable,active?,unit?,nativeName?}}}`。布尔项没有数值范围。自动模式下 `active:false` 的手动项保持禁用，必须先关闭自动模式并应用，再以新回读和新基线调节。网页不会把请求值回显当作实际值，应用/恢复也不会自动把候选选为交付版本。

`targetId` 是服务端 adapter 的 ID，不能提交 SSH 地址、URL 或任意命令。未填写相机上下文的导入实验保持「未记录」，不存在默认相机或板卡。选择 adapter 时由后端填入并核对已声明的相机、平台、SDK、接口和工作模式；网页发送选定的 `targetId`，不会上传私有 endpoint 或自行拼接执行命令。底层执行不自动重试；超时或断开后的写入结果可能未确认，应查询账本与实际 SDK 状态，不能盲目重复提交。

相机上下文字段均为可选文本：`board` 是实际设备平台，`sensorVendor` 是相机厂商，`sensorModel` 是实际型号，`sdkVersion` 是确切 SDK 版本，`cameraInterface` 是接口，`cameraMode` 是本次经过确认的工作模式。更换相机或模式应创建具有相应 profile 的实验。型号不会自动决定 Bayer、位深、Stride、驱动或 ISP 参数字段。

## Raw 与结果图上传

大文件使用 `application/octet-stream`，同一路由的小文件也接受 `{filename?,metadata,contentBase64}`。JSON 方式限 decoded 512 KiB；大 Raw 用二进制传输。

二进制 Raw 的 `x-vision-sample` header 为 `encodeURIComponent(JSON.stringify({filename,...metadata}))`。必须填写 scene、width、height、bitDepth、bayer、packing、stride、blackLevel、whiteLevel，可选 exposureUs、gain。单帧字节数必须等于 `stride * height`。

当前实际解包支持 `unpacked16le`、`mipi-raw10`、`mipi-raw12`；Bayer 支持 RGGB/BGGR/GRBG/GBRG。真实 bitDepth、Bayer、打包和 stride 由实际 SDK 确认，不能仅依据 Sensor 名称推断。典型 3840×2160 的 16 位容器 Raw 占 16,588,800 字节，但这不是默认采集格式。以 `/capabilities` 返回的 `supportedFormats` 为准；公共契约不意味着任意 USB 视频、YUV 或其他厂商 Raw 格式已经有解包实现。

结果图的 `x-vision-result` header 为 `encodeURIComponent(JSON.stringify({filename?,sampleId,candidateId?}))`。实际文件限 PNG/JPEG，尺寸须匹配对应 Raw。基础配置输出的参数哈希由服务端固定保存，后续更新基线不会改变既有图片记录。

客观比较第一版仅支持 8 位、非交错 PNG。JPEG 仍可人工评价；进行客观比较前应保留或导出匹配的 PNG。返回亮度均值/变化、近黑/近白输出码值比例与 RGB 均值；比例、标准差和对比变化不等于校准噪声、色差、MTF 或画质总分。ROI 可选 `{x,y,width,height}`；测试环境和验收目标仍须由实验记录明确。

## 模型配置

显式设置 `RDK_VISION_AI_ENABLED=1`。专用配置 `RDK_VISION_AI_KEY`、`RDK_VISION_AI_MODEL`、`RDK_VISION_AI_URL`；对应项可以复用已有 `RDK_LOG_AI_GATEWAY_KEY`、`RDK_LOG_AI_MODEL`、`RDK_LOG_AI_GATEWAY_URL`。

模型 endpoint 只由服务器配置，接受 HTTPS 或本机 loopback HTTP。凭据不进入浏览器、MCP 能力目录或导出包。请求有超时/正文额度；并发最多 2 次候选生成。规则只允许 baseline 中已有、有限数值字段，并校验范围及重复路径；基线在生成过程中变更时拒绝保存过期候选。

## SDK adapter 接入

平台 adapter 协议：`rdk.vision-device-runner.v1`。随仓库提供 [SDK runner](../tools/vision-workshop-device-runner.mjs)，默认绑定 `127.0.0.1`，所有 HTTP 路由使用私有 bearer token。

X5/IMX415 的已实现路径是 [Python 原生服务](../tools/vision-x5-camera.py) 与 [真实 HBN C backend](../tools/vision-x5-native/README.md)，
它直接实现同一 HTTP 协议，不需再套固定 argv runner；依赖匹配板端 SDK 构建，首版调参范围为 MANUAL CPROC。
以下固定 argv 示例仍用于其他 operator-configured SDK 包装器，不作为已经部署的 X5 命令。

在能调用目标 SDK 的环境安装 Node.js 22+，使用私有配置文件启动：

```sh
chmod 600 /private/vision-sdk-runner.json
node tools/vision-workshop-device-runner.mjs --config /private/vision-sdk-runner.json
```

私有配置示意 A：Sony IMX415 / RDK X5 仅作为一种接入案例，既不是默认值，也不是这台设备已验证的证据。命令路径与模式须替换为实际 SDK 包装器和真实配置：

```json
{
  "token": "REPLACE_WITH_A_PRIVATE_RANDOM_TOKEN_OF_AT_LEAST_24_CHARACTERS",
  "board": "RDK X5",
  "sensorVendor": "Sony",
  "sensorModel": "IMX415",
  "sdkVersion": "YOUR_VERIFIED_SDK_VERSION",
  "cameraInterface": "MIPI CSI-2",
  "cameraMode": "YOUR_VERIFIED_CAMERA_MODE",
  "host": "127.0.0.1",
  "port": 49381,
  "jobRoot": "/private/vision-sdk-jobs",
  "commands": {
    "probe": {
      "argv": ["/opt/camera-sdk/adapter", "probe", "{requestFile}", "{jobDir}"]
    }
  }
}
```

只配置已实现的操作。`argv[0]` 必须为固定的绝对可执行路径；操作通过 spawn argv 执行，客户端不能指定 command、shell、路径或 URL。允许占位 `{jobDir}`、`{requestFile}`、`{rawFile}`、`{tuningFile}`，仅指向 runner 创建的私有任务文件。`process_raw` 的 Raw 字节在 `{rawFile}`，tuning 在 `{tuningFile}`；request.json 保留元数据、原始哈希与操作上下文。

SDK 包装器必须在 `{jobDir}/result.json` 写实际结果，stdout 不是成功证据：

| 操作 | result.json 内容 |
| --- | --- |
| probe | `{facts:{...},evidence?}`，facts 必须非空 |
| pipeline_validate / bringup | `{passed:boolean,checks?,evidence?}`；失败不能写成通过 |
| capture_raw | `{filename,metadata,artifactFile:"capture.raw"}`；runner 读取真实文件并计算 SHA-256 |
| process_raw | `{filename,mimeType,artifactFile:"result.png",rawHash,tuningHash,readbackHash}`；返回与输入 Raw 尺寸一致的真实 PNG/JPEG，哈希须来自实际输入、已应用参数及独立 SDK 回读，并分别匹配请求 Raw 与 tuning 哈希，不能直接回显请求补齐证据 |
| apply_tuning | `{appliedHash,readbackHash,evidence?}`；两个哈希来自实际应用及回读的配置，不得直接回显请求冒充读取 |
| restore_tuning | 与 apply_tuning 相同，从对应保存版本执行真实写入和回读 |
| preview_start / preview_stop | `{running:boolean,...}`；返回实际启动/停止状态 |
| preview_frame | 返回实际 PNG/JPEG artifactFile；平台传输已核验帧字节，不公开设备 URL |
| controls_get / controls_set | 返回 controls 描述符与实际回读值；不支持或未激活的字段不能写成可操作 |
| capture_frame | `{filename,mimeType,artifactFile,scene?,controls?,tuningHash?,capturedAt?}`；真实视频帧独立归档，不标记为 RAW |

artifactFile 仅能引用任务目录中的普通文件，拒绝绝对路径、越界和符号链接。退出码非零、缺失 result.json、超时、断开或额度超限都会使操作失败。每个 SDK runner 串行使用设备；平台另有跨请求的 adapter 使用锁。

runner 私有配置必须声明实际 `board`、`sensorModel` 与 `sdkVersion`；`sensorVendor`、`cameraInterface` 和 `cameraMode` 可选，未声明不推测。相同 SDK 的不同相机模式可使用不同 profile ID，包装器须执行和回执自己声明的模式。

平台服务器私有环境配置 `RDK_VISION_DEVICE_ADAPTERS` 为数组。以下同时展示上述案例 A 和另一厂商案例 B 的配置形状；案例 B 的平台、模式和 SDK 也必须替换并实际实现，不是开箱支持声明：

```json
[
  {
    "id": "x5-imx415",
    "label": "X5 / IMX415",
    "board": "RDK X5",
    "sensorVendor": "Sony",
    "sensorModel": "IMX415",
    "sdkVersion": "YOUR_VERIFIED_SDK_VERSION",
    "cameraInterface": "MIPI CSI-2",
    "cameraMode": "YOUR_VERIFIED_CAMERA_MODE",
    "operations": ["probe"],
    "url": "http://127.0.0.1:49381",
    "token": "SAME_PRIVATE_RUNNER_TOKEN"
  },
  {
    "id": "example-ov5647",
    "label": "案例 B / OmniVision OV5647",
    "board": "YOUR_ACTUAL_BOARD",
    "sensorVendor": "OmniVision",
    "sensorModel": "OV5647",
    "sdkVersion": "YOUR_OTHER_VERIFIED_SDK_VERSION",
    "cameraInterface": "MIPI CSI-2",
    "cameraMode": "YOUR_OTHER_VERIFIED_CAMERA_MODE",
    "operations": ["probe"],
    "url": "http://127.0.0.1:49382",
    "token": "OTHER_PRIVATE_RUNNER_TOKEN"
  }
]
```

SDK 操作能力列表必须与 runner 实现一致。远程 endpoint 需 HTTPS，或使用已有 SSH tunnel 连接 loopback HTTP。地址、token、命令和 SDK 文件路径不对客户端公开。仓库没有内置各厂商的寄存器初始化、特定 SDK 驱动生成或完整 ISP 全模块适配；这些由对应 SDK 包装器实现。

新增相机时新增匹配的 **adapter / mode / format / 参数 schema**，公共原子契约及编排保持不变。已经实现的 Raw 布局可以复用真实解包器；新布局必须新增实际解包实现，或由 SDK 导出已经支持的布局，不能仅写一个格式名称就宣称支持。ISP 模块以真实基础 tuning 与允许修改的 JSON Pointer、数值范围声明；厂商专有 XML、二进制格式和完整参数校验需由适配层处理。没有对应 SDK 和驱动，不会自动支持所有相机。

## 保存、身份与交付

`RDK_VISION_STATE_DIR` 指定持久目录，默认 `~/.local/state/d-obs/vision-workshop`。元数据原子落盘，Raw/图像读回校验 SHA-256。额度包含文件与元数据；单 Raw 最大 64 MiB、每实验 128 MiB，具体以 capabilities.limits 为准。不可变候选保留各自基础配置和 Raw 版本；更换基础配置会清除当前选定状态。

沿用运营管理员 SSO 或 `x-admin-token`，所有 POST 需要 `x-rdk-ops-action: observability` 与既有同源守卫。`x-rdk-ops-read-only:1` 禁止修改。账号身份由请求确定，不能从 body 覆盖；所有实验、样本、回执和下载按身份隔离。共享运营令牌仍意味着共享账号，Workshop 分组应配置独立身份。

ZIP 包包含 manifest.json、handbook.md、选定候选的 candidate_tuning.json、实际结果图与视频帧；可选择包含 Raw。AI 自主运行独立保存 `ai-debug/<runId>/original_tuning.json`、`best_tuning.json` 和 `report.json`，不要求手动选择候选，不创建人工分数。配置字节保留对应 SHA-256，报告保存模型判断、回退项、真实图像哈希、请求与回读以及最终恢复状态，不复制私有 adapter/model 配置或任意原始 SDK 回执。没有选定候选仍可导出实验记录，不会捏造最终 tuning。手册包括基础版本、场景、视频帧控制回读、每轮人工评价或 AI 判断和设备操作状态，区分 UVC 控制配置与 RAW / ISP 复现条件。已恢复的旧 best 明确标记为历史推荐；目标未达成和恢复/采图失败分别记录。即使选定候选或参数回读匹配，视觉验收仍为 unverified，直到另行完成动态画质和项目验收。

## 本地验证

```sh
npm run typecheck
npm run test:vision-workshop
```

本地测试使用真实字节、文件和 HTTP 协议、明确的测试模型与不同相机上下文的 SDK fixture；不能据此宣称任何具体相机的真机或真实模型质量已验证。


X5 v2 软件、SDK 模式资格、原生回灌与静态标定接入细节见 [X5 原生说明](vision-workshop-x5-native.md)。
效果库原始 JSON 最多 16 MiB；其 Base64 HTTP/MCP 请求使用独立 24 MiB parser，其余应用 JSON 保持原预算。
完整 tuning/baseline 的公开配置不接受原生 SDK binary 结构；服务器私有 snapshotId 绑定编译 layout、SDK、模式和 CSI。
大型 SDK LUT 的完整数值保存在实验 baseline；deviceRuns 保存配置摘要、真实配置哈希及字段目录，避免重复完整LUT超过账本预算。
RAW 回灌回执必须含实际 rawHash、tuningHash、readbackHash，三个值不匹配不归档图像。
