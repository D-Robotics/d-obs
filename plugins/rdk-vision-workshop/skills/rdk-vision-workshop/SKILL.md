---
name: rdk-vision-workshop
description: 在 Studio 按 180 分钟方案带学员完成 X5 + IMX415 点亮、Gamma 调优、RoboGO 异步训练、A/B/C 分流、实时检测和个人成果打包。
version: 0.7.2
trigger: 视觉 Workshop,视觉 Pipeline,相机与 BPU 工作坊,继续视觉任务,相机训练部署全流程,采集基线图,三张基线图,展示基线图
risk: medium
requires_board: false
permissions: network
category: device
enabled: true
---

# 视觉 Pipeline · 180 分钟 Workshop

本课程依据 180 分钟视觉 Pipeline 课堂方案。课程执行方法见 [操作稿](references/course-runbook.md)，实机交接见 [检测交接](references/tuning-handoff.md)。

1. 用户要开始或继续时调用 `vision_course_next`。带回已有 `resume`，并更新当前实际回执。如果知道课堂开始时间，传入实际经过的 `elapsedMinutes`。用户明确彩排时可以使用彩排时钟，标注模拟时间。展示工作台时调用 `vision_course_view`，把返回的本机地址交给实际可用的 Studio 网页工具打开。用户看总课表时调用 `vision_course_plan`。
2. 工作台打开后，用 `vision_course_sync` 的空参数读取当前记录。完成实际工具操作后，用 `{patch:{evidence:{...}}}` 把本轮实际回执引用同步到工作台；确实解决的阻塞放入 `clearBlockers`。根据宿主对本地记录更新的权限执行。每轮只给学员当前一步，说明完成条件和证据。宿主有可用且已授权的工具时，从相机、GPU 或板端工具执行当前一步。实际工具缺失时指出哪项配置或操作需要用户或助教处理。不要把课程工具的规划回执当成执行回执。
3. 相机工具返回实际实验 ID 后，把 `camera:{experimentId}` 写入 `vision_course_sync` 的 `patch`。有实际相机 AI Run 后同步 `{camera:{experimentId,runId}}`。提示学员在工作台核对这轮新帧、实际回读和采集时间，再附入成果包。
4. 开场第 35–45 分钟采三种基线，第 45–50 分钟按组提交 RoboGO。收到已有 Run ID 后只查询原 Run。茶歇由助教核对，第 110 分钟个人盲选，第 120 分钟助教预检，第 130 分钟按实际产物与设备状态做 A/B/C 选择。
5. A 使用本人训练和量化产物。B 记录预置模型来源，完成本人板端操作。C 只归档已观看的演示记录。切换路径保留原 Run 和实际来源。板端模型需核对三类输出与实际 SHA-256。检测流须读取实际生效的 ISP 配置和本轮新帧。
6. 操作相机前保存原始配置。ISP 未恢复时按相机插件的恢复状态继续处理。交付时保存个人手册、tuning、媒体、实际模型来源、待完成项及终态恢复记录，并打开 ZIP 核对。传给用户的文件从真实制品取，未完成的路径保留说明。

拍照和基线图先读取 `vision_course_camera_status`。用户说「看基线图」「这几张展示给我看」时，打开工具返回的工作台链接，展示当前工位已归档的图，保持只读。用户明确要拍照时，用 `vision_course_camera` 的 `photo`。采三图用 `baseline`，传学员确认的固定场景；场景变更用 `retake`。需要实验绑定时先打开工作台关联本工位。操作后查询原状态，确定哪一项成功，再展示带原件下载的入口。工具不可用时指出缺失工具和工作台入口，禁止改用批量终端命令或自动改 AE/AWB。只读排查禁止调用烧录、写设备或修改 ISP 的工具。
