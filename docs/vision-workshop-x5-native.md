# X5 / IMX415 原生原子能力

2026-10-14：软件 v2 已实现，使用官方 X5 HBN 头文件编译检查并通过隔离 SDK、Python 状态驱动和真实 HTTP/MCP 协议测试。实机 IMX415 已通过板上官方 `libsrcampy` 获取新帧；该板 RDKOS 3.1.1 的旧 SDK 缺少本 adapter 使用的新版 CPROC、EE、2DNR/3DNR 接口，因此官方出图不能证明原生 v2 适配成功。原生 v2 的目标板链接、RAW、ISP 生效/恢复及画质仍未验收；不自动注册设备或上线服务。

## 代码与范围

| 层 | 实现 |
| --- | --- |
| 只读环境探测 | [vision-x5-preflight.py](../tools/vision-x5-preflight.py)：OS、内核、软件包、库/工具文件、DT、CSI 和已枚举 I²C；不扫描总线、写寄存器、执行 SDK 或重配置设备树 |
| 原生 SDK | [C backend / 构建说明](../tools/vision-x5-native/README.md)：真实 Camera/VIN/ISP 创建、开流/停止、RAW/NV12 取帧及释放、34 个 typed SDK 模块、AE/AWB/CPROC、模块快照/独立读回与真实 RAW 回灌 |
| 板端原子服务 | [vision-x5-camera.py](../tools/vision-x5-camera.py)：私有 loopback、固定身份、单设备串行、原始快照、独立读回、写前持久日志与恢复、真实新帧及哈希 |
| CPU 标定 | [vision-x5-calibration.py](../tools/vision-x5-calibration.py)：BLC/LSC/CCM/AWB 四种计算；只读取当前用户拥有的输入制品与任务，产物为 SDK 中立参数及条件/哈希，不直接写板 |
| SDK 格式与恢复 | [vision-x5-isp.py](../tools/vision-x5-isp.py)：编译器字段描述、私有原始快照、128bit 私有快照引用、文件归属/权限/非符号链接及 profile/layout 校验、操作员限值与 SDK 绑定；加载后重新 getter |
| 图像转换 | [vision-x5-frame.py](../tools/vision-x5-frame.py)：显式 NV12 两 plane/stride/矩阵/range → PNG；明确对齐/字节序的 RAW16 → unpacked16le；有 NumPy 时逐行向量化，无 NumPy 时标准库回退，输出一致 |
| 平台 | 复用 `rdk.vision-device-runner.v1` 的 REST / typed MCP / 实验账本 / 资产 / 导出，支持现有 Studio 插件；不需要再套固定 argv runner |

原生库只接受 `imx415-30fps-2lane` / `imx415-30fps-4lane`、3840×2160、linear RAW10、30 fps、I²C 0x1a、CSI host 0 或 2。它们来自两份官方 VP 配置；不能根据模组名决定实际 lane 或排线映射。

ABI v2 提供 17 个设备操作：`probe`、`pipeline_validate`、`bringup`、`capture_raw`、`process_raw`、`preview_start/stop/frame`、`capture_frame`、`controls_get/set`、`apply_tuning`、`restore_tuning`、`tuning_get/load/export`、`calibration_apply`。ABI v1 保留原 12 个操作；库缺失、ABI 不符或配置不支持时只公布 `probe/pipeline_validate`。目录中的实现不证明硬件已通过，控制和标定是否可执行还取决于实际 getter、模式、私有限值、绑定及原版恢复条件。

原生模块表覆盖 **34 个 SDK 接口**：27 个具有 getter/setter 的属性模块，包括 AE/AWB、module control、CPROC、LSC、CCM、GC、2DNR/3DNR、WDR、DMSC、EE、DPCC、HDR、曝光表/ROI、AWB/LSC calibration、AFM/AF、直方图与 RGBIR；另外 7 个 sensor/line-rate/statistics 接口只读。只有运行时真实 getter 成功的模块才进入快照；一个公开 API 在某个 SDK/模组上不可用时保留错误或缺口，不生成成功占位。

AE 曝光/模拟增益范围来自真实 `hbn_isp_get_exposure_attr` 的只读范围；没有真实范围就不开放对应数值。曝光按 SDK **float32 秒**量化，再转换为微秒，不能直接对微秒做 `Math.fround`；真实 line period 可留在传感器证据中，不能为不在该网格上的 getter 伪造 step。AWB 四通道增益没有公开 SDK 上下界；红/蓝数值编辑要求显式 `awbGainLimits.min/max/evidenceRef` 私有操作员策略，来源标为 operator-policy，不能称 SDK caps。CPROC 四项均为 float32，使用实际 getter 值和公开范围。

SDK 2.0.0 文档说明 AE/HDR/AWB getter 的 mode 暂不可用。`modeReadbackEvidence` 分别以 `exposure`、`awb`、`hdr_exposure` 记录与实际 SDK 版本匹配的独立模式读回资格；缺证据时对应模式与 AE/WB 数值控制保持只读，私有限值策略不能绕过模式资格。setter 的 mode/readback 不符返回失败，不能用调用返回 0、请求回显或 fixture 替代模式资格证据。

模块配置格式为 `x5-hbn-isp-v2`。原始 native bytes 仅从真实 SDK getter 或私有恢复存储生成，；客户端只能引用服务端生成的 128bit opaque snapshotId，服务端校验 0700 目录/0600 文件的归属和非符号链接，以及 snapshot/profile/layout；公共请求不能提交任意原生字节。客户端只使用实际 compiler-described numeric 字段。已有 SDK 规范范围不可放宽；没有公开范围的字段默认只读，必须有显式私有 `ispFieldPolicies` 才允许受限编辑。快照同时保存原始字节；配置比较清除真实 padding、getter-only 字段和 AUTO 当前算法输出，严格保留 mode。比较范围是 SDK 可读的所选模式配置，不把动态状态或不可读字段称为完整参数验收。

CPU 标定任务先验证输入制品归属、字节哈希、RAW 布局和已记录的采集条件，再输出 `computed` 的 BLC/LSC/CCM/AWB 结果。条件记录并不证明光源、暗场或色卡真实合格。`calibration_apply` 必须由私有 `calibrationBindings` 指明同版本 SDK 的目标字段、通道/矩阵顺序、编码和单位；缺绑定返回 `calibration_sdk_binding_required`。公共模块走真实 setter→独立 getter；原始效果库现有 JSON 字段走私有匹配模板→`hbn_camera_switch_scence`→公开模块独立 getter。没有专用公开 BLC getter，BLC 等未公开 JSON 字段的全参数读回保持未验证，文件 SHA 只是声明输入的归档证据。

官方配置的 `calib_lname="disable"` 在所读 SDK 2.0.0 文档中表示使用默认
`imx415_tuning.json`，不是该版本的 ISP 禁用开关；默认目录为 `/usr/hobot/lib/sensor`。
preflight 记录其存在、字节数与 SHA-256，不返回内容，也不称 SDK 已加载/schema 已验证。
实际版本解析规则和 CPROC MANUAL 状态还须在板端核对。

旧板本次实际文件位置为 `/usr/hobot/bin/imx415_tuning.json`；预检同时列出两个候选位置，不能按文件存在自动选择效果库。头文件缺少当前 adapter 所需接口时报告 `incompatible`；接口名称存在仍保持编译和 ABI 未验证。相同名称的库若分布在不同目录，预检保留冲突路径；原生构建默认链接 `/usr/hobot/lib`，可由匹配 sysroot 的配置覆盖。

## 实机失败后的平台保护

- CSI host 0/2 只写入 VIN 的 `mipi_rx`；`rx_attr.phy` 保留官方 profile 的 DPHY/CPHY 类型。二者不是同一编号空间，软件测试覆盖两个 profile 和两个 host 的实际 API 入参。
- `hbn_camera_switch_scence` 返回 0 与公开 getter 成功分别保留证据，不能作为全部效果库字段或画质改善的证明。效果库写入、完整快照应用和恢复必须先取得新的有效帧，再持久化确认结果。
- 写后流故障会持久化 `cleanupRequired` 和 `unconfirmed`，重启 daemon 也不能消除。先显式执行成功的停止/清理，再恢复和取新帧；仅 RAW replay 清理成功不能证明现场流已恢复。关闭 daemon 不向已失败的流再次热切换效果库。
- 场景重启可以重置 frame ID，但仍保留上一帧的时间戳下界。成功的场景 API 调用不是旧队列清空的证明；若 SDK 时间戳也重置且没有时钟资格证据，明确拒绝确认新帧。
- AI 最终恢复失败只记录一次自动尝试，保留 SDK 数字错误；最终设备取帧失败进入恢复阻断。人工恢复在写前保存 pending 状态，配置与视频流确认分别显示；历史配置哈希不能补造新帧证明。
- 新一轮 AI 在初始实际 probe 发现待清理或写入未确认时停止，不将该状态存为本轮原始参数、不调用模型或恢复操作。正常停止的视频流并不等同于未确认写入；保存的故障观察需要重新 probe 才能确认已解除。

本次曝光、关闭 2DNR/3DNR 和临时效果库试验没有可靠的清晰度改善。曾出现效果库热切换后 MIPI 重启失败；单独恢复官方相机服务后，官方链路连续获取 90 个新帧并正常关闭。这是故障恢复的单次证据，不是新 adapter 或热切换稳定性验收，也不构成平台自动重启服务的授权。

传统 `x5-hbn-isp-controls-v1` 数值控制格式仍可使用；v2 的完整模块配置和私有效果库模板使用独立格式。候选在写入前完成实际 SDK 编码的 canonical 量化并计算版本，原生 getter 保留精确浮点值。直接写入非 canonical 数值会在 SDK 写入前失败；读回哈希来自新 getter，不能使用请求哈希。

## 构建与接入

1. 用只读 preflight 核对实际环境，保留结果。未采流时 `ready/passed/hardwareVerified` 保持 false；CLI 默认 exit 2 表示未就绪。`--allow-unready-exit-zero` 只影响探测命令退出码。
2. 使用匹配板端 SDK 的真实头文件、共享库与 VP 配置，按 [原生构建说明](../tools/vision-x5-native/README.md) 构建 `libvision_x5_native.so`。RDKOS 3.5.0 与 SDK 文档 2.0.0 不等同；本次主机 syntax/shim 测试没有证明 ARM64 链接成功。
3. 将新 Python 文件及编译库安装在板端受控目录，创建仓库外、当前用户拥有的 0600 私有配置及 0700 stateDir。配置示意如下，SDK、模式、RAW 电平、颜色解释必须替换为实际核对值；示意值不是模组默认参数。v2 的私有 `modeReadbackEvidence`、`awbGainLimits`、`ispFieldPolicies`、`calibrationBindings` 与 `effectLibrary` 均无隐含默认值，应按实际 SDK schema/资格记录配置。

```json
{
  "token": "REPLACE_WITH_PRIVATE_RANDOM_TOKEN_AT_LEAST_24_CHARS",
  "board": "RDK X5",
  "sensorModel": "IMX415",
  "sensorVendor": "Sony",
  "sdkVersion": "EXACT_INSTALLED_AND_COMPILED_SDK_VERSION",
  "cameraInterface": "MIPI CSI-2",
  "cameraMode": "CONFIRMED_LINEAR_RAW10_3840x2160_30FPS_2LANE",
  "sensorConfig": "imx415-30fps-2lane",
  "csiPort": 0,
  "nativeLibrary": "/opt/vision-x5/libvision_x5_native.so",
  "port": 3217,
  "stateDir": "/var/lib/vision-x5-private",
  "colorMatrix": "bt709",
  "colorRange": "limited",
  "blackLevel": 0,
  "whiteLevel": 1023,
  "discardFrames": 5
}
```

```sh
python3 tools/vision-x5-preflight.py
python3 tools/vision-x5-camera.py --config /private/x5-camera.json
```

4. 通过私有 SSH tunnel 或已有 HTTPS 代理接入板端 loopback 服务。平台注册 adapter 的 URL/token 仅放服务器私有配置，身份字段逐一匹配 daemon；`operations` 取自实际 `/capabilities`。缺库时不能把全部源码操作复制为就绪目录。配置、连接、读回控制或创建实验均不证明画质通过。
5. 从 Studio 自然语言调用现有 typed MCP：创建并绑定实验 → probe → bringup → pipeline_validate 的新帧 → 导入该运行器 baseline → RAW/PNG 归档 → 受保护的完整原版快照 → CPU 标定任务及私有 SDK 绑定（如适用）→ 生成数值/模块候选 → 应用/独立 getter → 新帧对比 → 明确评价 → 恢复。任何写前有原始 baseline；实际写入仍遵循平台/Studio 现有权限。

RAW 要求运行中的 `hbn_camera_get_sns_info` 返回明确 Bayer，真实 stride/plane 和像素唯一匹配左右对齐。黑帧/低信息数据若两种对齐都成立，拒绝采集，不猜；未支持的 packed/tiled 格式同样拒绝。NV12 转换要求明确颜色矩阵与 range，颜色精度未标定。

`process_raw` 使用同一实际 ISP 节点：暂停 live flow、解绑 VIN→ISP、清空旧帧后分配真实 RAW buffer 并 `hbn_vnode_sendframe`，验证提交 frame ID 与主机提交时间对应的输出，再释放 buffer 并恢复 live flow。AE/AWB 必须手动且读回可信。回灌时间戳来自主机提交时刻，不代表 sensor 曝光时间；live getframe、CPU 去马赛克或旧帧均不能替代原生回灌。停止/释放失败保留 replay 所有权和 cleanup 栅栏，阻止新写。

新帧用 SDK frame ID 和 `hbn_frame_info.tv` 做递增检查。`sdkTimestampNs` 表示 SDK timeval 转为纳秒，时基/与主机时钟的关系待实机核查；PNG `capturedAt` 是 SDK 返回后的主机接收时间，不是转换结束时间。PNG 保留原尺寸，超过平台 16 MiB 图像预算返回失败，不悄悄缩小图像。NumPy 加速的输出已与标准库路径逐字节核对；实时 FPS 仍须板端测试。

## 失败、停止与恢复

写前先 fsync 私有 `isp-write.json`，保存原始配置/模块快照、身份、jobId/operation 和 pending；每次写入都有可恢复的原版。写后独立 SDK getter 确认实际配置范围。效果库源文件/模板与不可公开读回字段分别记录，完整源文件恢复不能升级为 BLC 等未公开参数全读回已验证。读回不一致、部分写入或写后丢帧失败都会保持 unconfirmed，阻止新写入；显式 `restore_tuning` 可恢复并再次读回。重启后 pending/unconfirmed/confirmed 中尚未关闭的写入保留原始快照并要求恢复。

超时/断连不自动重放。用 probe 的 `writeOutcome/lastWrite`、当前独立 `controls_get` 和实验 deviceRuns 查实际状态。HTTP 失败账本保留受限的 adapterCode、SDK 数值错误码、jobId/operation；不保存 SDK 原始 stdout、路径或凭据。服务正常退出会恢复本轮原始控制并停止/关闭实际资源；恢复/停止失败保持真实失败，SIGKILL 不能承诺自动恢复。

`pipeline_validate` 每次取新帧，不靠缓存宣布通过；SDK 开始/停止失败保留 cleanup 栅栏，成功清理后才允许新帧序列。资源关闭为 void 的 SDK 调用只能记录已调用，不能伪造返回成功证明。

## 回归

```sh
python3 tools/vision-x5-preflight.test.py
python3 tools/vision-x5-frame.test.py
python3 tools/vision-x5-camera.test.py
python3 tools/vision-x5-calibration.test.py
node --test tools/vision-x5-camera-http.test.mjs
npm run test:vision-workshop
npm run typecheck
```

另在提供真实 SDK include / VP_SENSOR_DIR 时运行 native Makefile 的 `syntax-check test`。C shim、状态型 fixture、实际 HTTP 子进程和 fixture 模型分别标记为软件测试；不将 fixture 注册到正常服务、不作为相机/画质成功证据。

剩余验收是匹配目标 SDK 的 ARM64 链接、各公开模块/私有 JSON binding 的板端资格、实际接线后的采集/回灌/恢复和标定画质验证。源码与协议通过不会自动注册 adapter、上线或标记原生 ISP 画质完成。
