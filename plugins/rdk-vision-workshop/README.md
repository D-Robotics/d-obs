# 视觉 Pipeline · 180 分钟 Workshop

在 Studio 逐步完成 X5 + IMX415 点亮、Gamma、RoboGO 异步训练、A/B/C 分流和个人成果归档。依据 [飞书课程方案](https://horizonrobotics.feishu.cn/docx/UdhhdVXYXoPLgfxmZ32cJBSAnRb)。

1. 解压，在 Studio AI 能力的扩展中心从目录导入插件。选择包含 plugin.json 的目录。
2. 若宿主没有自动注册 MCP，从实际安装目录运行 `node mcp/studio-config.mjs`。在 Studio 设置的 MCP 服务导入配置，保留其他服务。检查工位预检与状态查询，拍摄、ISP 操作和 `vision_course_sync` 按 Studio 的审批权限执行。
3. 在 Studio 输入“开始 180 分钟视觉 Workshop，打开课堂工作台，一步步带我完成”。助手用 `vision_course_next` 和 `vision_course_view`，再用宿主网页入口打开返回的本机工作台。
4. 工作台每次展示当前一个动作、完成条件和 Run 状态。学员从 RoboGO 或相机工具核对本人的真实回执，再添加到当前工位。助手可以用 `vision_course_sync` 让工作台显示已实际取得的回执引用。用「设定进度」可以标记彩排时间，实际课堂用「开始计时」。Gamma 对照从相机工具添加现场图片，按提示在选图和写理由后揭晓。
5. 在「本工位相机实验」关联 Camera Workshop 的实际实验。工作台沿用该相机插件的本机私有连接配置，可查看帧时间、ISP 实际回读和相机 AI Run。点击「附入成果包」可保存帧与对应回执；有同一 Run 的前后实拍和匹配回读时，可直接打开对照。归档帧按采集时间核对，关联实验不会启动采集或调参。
6. 保存进度 JSON 可以在另一轮继续。添加实际文件后下载个人成果 ZIP，打开检查手册、清单、附件、完成路径和待完成项。浏览器重新打开时需重新选择附件。

「当前一步」直接带学员进入对应页面。连接预检可写入本工位服务和设备回执。保存原始 ISP 后完成两轮 Gamma。第 1 轮从示范目标跟做，第 2 轮填写自己的目标。每轮单独保存相机实拍、独立回读和取舍。用同一份期初配置开始两轮，保留候选后先恢复期初配置。讲师可在工位切换曝光、增益、对比度、锐度和白平衡的既有实机对照。

关联相机实验后，可以在 Studio 桌面聊天里说「用视觉 Workshop 拍一张，直接显示在对话里」。插件等本轮照片归档后把实拍交给聊天。新版 Studio 自动提供本机媒体目录。手动注册课程 MCP 的旧版 Studio 可在 MCP 配置中将 `RDK_VISION_COURSE_STUDIO_MEDIA_DIR` 指向当前 Studio 数据目录下的 `agent-downloads`（绝对路径），再重新连接课程 MCP。已在运行的旧工位需要在导出进度并结束实验后重开，才能返回本轮拍照请求 ID。

也可以说「把第 1 轮 Gamma 调前调后实拍放在聊天里」或「显示本组最近一张带框检测图」。Gamma 和单项 ISP 都使用该轮归档和独立回读。带框图附当前帧的类别、框数和最高置信度，连续取景留在板端检测工作台。并排对照需要支持对照图的 Studio 版本。

工位可在训练卡记录 RoboGO 原 Run 及其状态回执。参加者已有外部训练产物时，组织者可给课程 MCP 配置 `RDK_VISION_COURSE_TRAINING_RECEIPT`，指向本组 `vision-course-x5-evidence-v1` 回执，工作台在读取时标明训练来源。训练回执与 RoboGO 平台任务分别记录。

组织者可以把课程板端运行目录同步到本机，设置 `RDK_VISION_COURSE_BOARD_ARCHIVE`。B 可配置独立的 `RDK_VISION_COURSE_PRESET_BOARD_ARCHIVE`，工作台按已登记的预置 SHA-256 核对该目录。学员读取相应板端结果，核对模型、帧、ISP 和恢复，再保存到成果包。运行和同步方法见[板端操作说明](device/README.md)。

Camera Workshop 默认从用户配置目录的 `connection.json` 读取服务设置。若使用自定义位置，可给 Studio 中课程 MCP 设置环境变量 `RDK_CAMERA_WORKSHOP_CONFIG`，值为该私有文件的绝对路径。凭据保留在相机插件的私有文件中。

MCP 打开的本机工作台跨对话保留，重新调用 `vision_course_view` 可返回同一工位。工作台闲置 8 小时后停止服务，重启后从本机恢复记录和待核对提交。跨场次可用独立的 `RDK_VISION_COURSE_SESSION_DIR` 区分工位。升级前下载进度并关闭旧工作台，升级后按需导入。也可独立运行 `node mcp/workbench.mjs`，打开终端打印的本机地址，并用 `--resume FILE` 恢复进度。要通过插件提交训练请从 Studio 的 MCP 入口打开工位。

工作台和课程工具处理本机工位记录。相机、RoboGO、PTQ 和板端操作由实际宿主工具执行。参考 [完整课程操作稿](skills/rdk-vision-workshop/references/course-runbook.md)。

## RoboGO 原 Run

学员从训练卡「连接 RoboGO」进入官方 SSO 授权。进程重启后重新授权。工作台每约 20 秒只读核对原 Run，直至失败或核实 X5 INT8 产物，也可按「刷新原 Run」。若原 Run 的响应没有附带唯一且明确标为 X5 INT8 的制品摘要，A 保持待核对。下载后把 .bin 的 SHA-256 与原 Run、PTQ 和上板回执比对。

组织方核对本组 RoboGO 镜像、算力、计费、挂载和配额后，在 `~/.config/rdk-vision-workshop/training-profile.json` 保存工位模板，也可用 `RDK_VISION_ROBOGO_TRAINING_PROFILE` 指定私有 JSON 的绝对路径。模板与凭据分开保存。工作台会重新读取文件，可在已授权工位补齐。JSON 的 `input` 使用官方 `training_jobs.prepare_create` 所需字段，按课程设置 YOLOv8s、640 和 100 轮。确认页显示预检的实际参数，确认后发起一次提交。结果不明确时，从 RoboGO 任务列表核对并绑定原任务。工位也可在 RoboGO 网页提交，再录入原任务 ID。


### 学员单项 ISP 实操

先保存期初 ISP，再读取本工位的可写参数。曝光、增益、对比度、锐度、白平衡按当前工位协议和模式显示；一次只提交一个数值。白平衡的各通道是独立选项。X5 的原生锐度需要相机服务支持单字段候选，且快照带手动可写范围。

记录同一区域的调前和调后新帧、独立回读及保留或恢复理由。保留后先恢复期初 ISP 才能开始另一项。新增流程的真实板端验收按工位单独记录。
