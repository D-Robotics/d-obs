---
name: rdk-vision-workshop
description: 在 Studio 按 180 分钟方案带学员完成 X5 + IMX415 点亮、Gamma 调优、RoboGO 异步训练、A/B/C 分流、实时检测和个人成果打包。
version: 0.7.4
trigger: 视觉 Workshop,视觉 Pipeline,相机与 BPU 工作坊,继续视觉任务,相机训练部署全流程,采集基线图,三张基线图,展示基线图
risk: medium
requires_board: false
permissions: network
category: device
enabled: true
---

# 视觉 Pipeline · 180 分钟 Workshop

本课程依据 [飞书方案](https://horizonrobotics.feishu.cn/docx/UdhhdVXYXoPLgfxmZ32cJBSAnRb)。课程执行方法见 [操作稿](references/course-runbook.md)，实机交接见 [检测交接](references/tuning-handoff.md)。

1. 用户要开始或继续时调用 `vision_course_next`。带回已有 `resume`，并更新当前实际回执。如果知道课堂开始时间，传入实际经过的 `elapsedMinutes`。用户明确彩排时可以使用彩排时钟，标注模拟时间。展示工作台时调用 `vision_course_view`，把返回的本机地址交给 `studio_open_url`，等待宿主显示加载状态。网页工具不可用时，给出可点击的 Markdown 链接「打开课堂工作台」。仅取得本机地址时告诉学员链接已准备好。用户看总课表时调用 `vision_course_plan`。
2. 工作台打开后，用 `vision_course_sync` 的空参数读取当前记录。完成实际工具操作后，用 `{patch:{evidence:{...}}}` 把本轮实际回执引用同步到工作台；确实解决的阻塞放入 `clearBlockers`。根据宿主对本地记录更新的权限执行。每轮只给学员当前一步，说明完成条件和证据。宿主有可用且已授权的工具时，从相机、GPU 或板端工具执行当前一步。实际工具缺失时指出哪项配置或操作需要用户或助教处理。不要把课程工具的规划回执当成执行回执。
3. 相机工具返回实际实验 ID 后，把 `camera:{experimentId}` 写入 `vision_course_sync` 的 `patch`。有实际相机 AI Run 后同步 `{camera:{experimentId,runId}}`。提示学员在工作台核对这轮新帧、实际回读和采集时间，再附入成果包。
4. 开场第 35–45 分钟采三种基线，第 45–50 分钟按组提交 RoboGO。收到已有 Run ID 后只查询原 Run。茶歇由助教核对，第 110 分钟个人盲选，第 120 分钟助教预检，第 130 分钟按实际产物与设备状态做 A/B/C 选择。
5. A 使用本人训练和量化产物。B 记录预置模型来源，完成本人板端操作。C 只归档已观看的演示记录。切换路径保留原 Run 和实际来源。板端模型需核对三类输出与实际 SHA-256。检测流须读取实际生效的 ISP 配置和本轮新帧。
6. 操作相机前保存原始配置。ISP 未恢复时按相机插件的恢复状态继续处理。交付时保存个人手册、tuning、媒体、实际模型来源、待完成项及终态恢复记录，并打开 ZIP 核对。传给用户的文件从真实制品取，未完成的路径保留说明。

学员要开场、继续 Workshop、接回板卡或确认相机可用时，先打开原工位，用 `vision_course_camera_status` 读取 `cameraBinding` 和 `latestPreflight`。旧版可用 `vision_course_sync` 的 `resume.camera` 和 `vision_course_preflight({})`。工位关联以实际实验记录为准，`device_boundary` 只表示聊天的通用设备工具范围。需要检查实时相机时调用 `vision_course_preflight({run:true})`，随后用空参数查询进度。工具逐项回报服务、板卡和两帧推进。工位未关联时打开工位关联，相机未开流时由学员在相机实验点亮后重试。`vision_device_history_capacity` 表示当前实验操作记录已满，先核对 ISP 恢复和停流，再用同设备的新实验继续并保留旧归档。预检通过后才报告实时画面有本轮证据；本机记录时间和 SDK 帧时间分别读取。

课堂 Gamma 使用工位 ISP 工具。先 `vision_course_isp` 的 `save` 保存原始版本，再按已确认的学员观察目标执行 `gamma`。使用 `vision_course_isp_status` 查看实际应用、回读和前后图；学员记录保留或恢复理由。先 `revert` 取得恢复后新图，再用 `reload` 验证同一个候选。最后按课堂授权调用 `restore` 恢复并停流。候选不符合单模块要求时按失败回执说明缺项；恢复结果不明确时继续核对同一个原始快照。

拍照和基线图先读取 `vision_course_camera_status`。用户明确要拍照时，用 `vision_course_camera` 的 `photo`。要在 Studio 聊天看到照片时，把返回的 `capture.photoRequestId` 传给 `vision_course_camera_status`。`photoPreview:pending` 时稍后继续查询同一个 ID；`ready` 时图片已作为工具结果交给 Studio，直接报告拍照完成。`capture_failed` 时按回执说明拍摄失败，`request_changed` 时说明工位照片请求已变化。`studio_media_unavailable` 或 `preview_unavailable` 时报告内联不可用，并给出工作台链接；旧工位未返回请求 ID 时也提供工作台入口。

要在聊天看 ISP 调前调后图，先查询 `vision_course_isp_status`，再用已完成的 Gamma `round` 或单项 `trial` 查询指定一轮。`ispPreview:ready` 时 Studio 显示两张实拍和回读摘要。若两图或独立回读未齐，按状态说明缺项；需要查看曲线或原件时给出工位链接。

要在聊天看带框图，调用 `vision_course_detection_status`。`detectionPreview:ready` 时显示当前模型最近一张已校验的归档帧，并以帧回执为准说明类别和最高置信度。要看连续画面，打开返回的 Studio 工作台入口。查看归档不会启动检测。

用户说「看基线图」「这几张展示给我看」时，打开工具返回的工作台链接，展示当前工位已归档的图，保持只读。进入课堂基线阶段或用户要求采三图时，用 `baseline` 并传学员确认的固定场景；场景变更用 `retake`。`baselineRequested:false` 表示尚无三图采集记录。需要实验绑定时先打开工作台关联本工位。操作后查询原状态，确定哪一项成功，再展示带原件下载的入口。工具不可用时指出缺失工具和工作台入口，禁止改用批量终端命令或自动改 AE/AWB。只读排查禁止调用烧录、写设备或修改 ISP 的工具。


学员用自然语言描述暗部问题并希望先看建议时，调用 `vision_course_isp` 的 `gamma_prepare`，带上本轮号和学员原话。轮询 `vision_course_isp_status` 到候选就绪，使用返回地址打开 Studio 的 ISP 面板。候选仅表示 AI 建议。学员授权试调时，用当前候选的 ID 调用 `gamma_apply`；等待调后实拍和独立回读，再让学员描述观察与取舍。不要将模型理由写成画质结论。

学员要求从对话调节曝光、增益、对比度、锐度或白平衡时，先读当前工位 ISP 状态和 learner_options。只使用当前返回且可写的一个字段，不自行切换自动模式。将学员目标与选择理由附在 learner_apply；expected 取本次读回，候选值遵守步进及范围。没有实际图像时将理由明确表述为参数原理和待验证假设。
