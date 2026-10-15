# 无相机时验证 X5 原生原子能力

复用本仓库 [实现与接入说明](../../../../docs/vision-workshop-x5-native.md)，
不要重写通用 fixed-argv runner 或将 UVC daemon 改名冒充 HBN。

2026-10-14 已跑通的是软件验证：实际官方头文件编译、隔离 SDK 调用、Python 状态驱动、
真实 HTTP/MCP 及制品/失败账本。没有板端 ARM64 链接、相机点亮/采集或画质通过证据。

1. 读 [native backend 构建说明](../../../../tools/vision-x5-native/README.md)，记录官方头文件与 VP 配置 revision。
   用匹配 SDK include 与两份实际配置跑 `make syntax-check test`；不编译带总线探测的 `vp_sensors.c`。
2. 跑 `python3 tools/vision-x5-preflight.test.py`、`vision-x5-frame.test.py`、`vision-x5-camera.test.py`、`vision-x5-isp.test.py`、`vision-x5-calibration.test.py`；
   跑 `node --test tools/vision-x5-camera-http.test.mjs`、`npm run test:vision-workshop`、`npm run typecheck`。
   将 fixture 驱动/模型明确标记为软件测试；不注册进正常服务。
3. 检查缺 SDK 时目录只有 probe/pipeline_validate、pipeline 不 passed。
   检查新帧 frame ID/SDK timeval 递增、RAW/PNG 实际字节哈希，不能用缓存宣称链路通过。
4. 对忽略写入、部分写入、独立 getter 失败和写后丢帧注入故障；确认 pending/unconfirmed 持久化、
   新写被阻止、deviceRuns 保留 jobId/SDK 错误、恢复必须重新 getter 验证。
   重启后的 confirmed 未关闭写入仍保留原始快照；SIGKILL 不等于恢复硬件。
5. 四项 CPROC 是 float32，包括亮度。平台在候选哈希前做 Math.fround，并重新验证范围；
   daemon 对非 canonical float32 在写前拒绝，不在事后返回请求哈希。
6. v2 绑定 34 个实际 SDK typed 接口，其中 27 个 getter/setter 属性、7 个只读观测；原版 SDK 字节存私有文件，
   公共配置只用服务器生成的 snapshotId 与编译器描述的字段，不接受任意 native bytes。
   模块回读比较清除 padding/getter-only/AUTO 当前输出；保留 mode 和真实选中配置。
   数值范围取 SDK 规范或带 evidenceRef 的私有操作员策略；未知范围默认只读，策略不能扩大 SDK 范围。
7. AE/AWB/HDR mode getter 在 SDK 2.0 文档中暂不可用，模式与相关手动数值需要私有 modeReadbackEvidence。
   曝光为 float32 秒再转微秒；WB 需要 awbGainLimits，不能发明 sensor caps。
   process_raw 需要 AE/AWB 资格、手动模式及匹配 RAW10 布局；C 模块真的分配/提交/取回帧，
   匹配本次提交的 ID 与 timeval，失败清理/恢复未确认时阻止再写。时间源为 host submission。
8. 通过已拥有资产创建 blc/lsc/ccm/awb 任务并实际运行 NumPy，不调用成功占位工具。
   固定 Python、输入原始 manifest 哈希、输出字节/self hash、失败/中断账本、账户隔离都须验证。
   calibration_apply 只从服务器已完成任务读取结果，经私有 calibrationBindings 映射到实际 SDK；
   没有绑定拒绝执行。LSC 必须记录实际网格/通道/尺度，AWB 明确选光源，CCM 明确矩阵顺序。
   BLC 仅能走确认的效果库 JSON 已有字段；不能发明专用 BLC getter。
9. tuning_load 接受有界 JSON 字节+sha256，不接受请求路径；SDK scene 调用后重新独立读模块。
   原始效果库与模块保存后才写；公开模块之外的字段 readbackAvailable 保持 false。
   加载/标定后平台 baseline 更新为实际 SDK 快照，导出校验实际字节而非相信自报 hash。
10. 相机到手后再按真实板型、排线、SDK、模式逐项验收。
   本软件工作流通过不提升 hardwareVerified/quality 状态；不自动部署或提交。

NV12 转换必须指定 matrix/range 与两个实际 plane/stride；RAW16 必须明确 bit depth、Bayer、
alignment、endian。可选 NumPy 与标准库输出逐字节一致，不作为板端 FPS 或色彩精度证据。
SDK timeval 的纳秒换算只标 `sdkTimestampNs`，不假定传感器独立时基或与主机时间同步。

## 线上软件验收记录

2026-10-14 已按用户授权发布；见 [发布记录](../../../../docs/releases/2026-10-14-camera-isp-v2.md)。
生产 Node 的候选 ESM 导入、只读 HTTP/MCP、真实模型知识查询与隔离 Python/NumPy BLC 计算已通过。
校准操作 metadata 应从纯声明模块导入，避免 calibration → platform-operations → metadata → calibration 的 ESM 初始化环。
生产服务器使用独立 Python runtime，不覆盖系统 Python；缺 NumPy 必须在读取输入资产前拒绝。
没有 adapter 时设备操作保持 unavailable；上线状态不能提升硬件或画质验证等级。
