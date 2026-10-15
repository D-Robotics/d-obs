# RDK Studio 原生相机工作区发布记录

2026-10-15 已发布原生相机工作区、按账号隔离的云端调用桥和 DSH 软件准备 action。入口：[RDK Studio 扩展中心](https://rdkstudio.d-robotics.cc/rdkstudio/?tab=plugins)，选择 **RDK Camera Workshop → 打开相机插件工作区**。资料查询、无设备文件实验、RAW 导入、离线标定任务、结果与成果包导出均在 Studio 内操作。

本次状态为 `deployed_software_verified_sso_and_hardware_unverified`。相机尚未收到，不能将软件发布解释为 IMX415 点亮或 ISP 画质验收通过。此前 10-14 发布记录保留历史原文；本记录补齐其当时缺少的原生界面和云端账号桥。

## 线上版本

| 服务 | 实际 current | 本次 manifest SHA256 |
| --- | --- | --- |
| d-obs | `/opt/d-obs/releases/camera-native-20261015-acb03e1cdc6e` | `acb03e1cdc6eb64f647583ab43231a530f0d8cdf2fa0bec736a990704f205754` |
| Studio 主备 | `/opt/rdstudio-web-opt/releases/camera-native-20261015-4c419036790a` | `4c419036790aaad2e3a4b7dafc2aa883a6e572f62fa7763bf43e314cf5a970ed` |

d-obs 继承线上 `vision-zero-one-20261014-7a0ad49a5399`，覆盖五个相机模块；Studio 继承 `20261014T101947Z-camera-952648b1`，新增或覆盖 313 个必要文件。Studio bundled companion 为 1.2.0，独立下载包保留各自原版本。发布没有升级 npm/Python 依赖、修改 SSO/nginx 或切换观测 worker。

前端以实际线上产物为基线，旧 assets 全部保持原字节；新增独立 namespace `assets/camera-native-20261015-7ca48a7d1978`，仅对两个命名空间内的宿主 JS 做固定哈希、唯一 AST 定位的入口插入。组件复用宿主同一 React、AuthContext、UIContext 和请求层。967 条相对 import 校验通过，避免 immutable 旧 URL 下替换内容及重复登录状态。

## 功能与边界

- 无 adapter 时可以查 IMX415/X5 资料、保存文件实验、导入 RAW、管理 BLC/LSC/AWB/CCM 离线任务、查看结果及导出。设备操作另按真实 adapter/授权准入。
- Studio 只从可信会话或 Runtime owner 派生 SSO 身份，对服务端 loopback 请求签短期 HMAC 断言；绑定方法、路径、请求体和上传元数据。d-obs 使用私有持久 nonce 防重放，实验/任务/资产/导出按账号隔离，adapter 目录和实际执行均检查授权。
- DSH `vision_camera_read` / `vision_camera_prepare` 只开放明确查询和软件准备，不能通过低风险 receipt 操作硬件。Moss/DSH 正常聊天保留原线上真实已确权板卡门禁；无板卡的软件准备走原生工作区。
- ZIP 中的标定结果使用通过哈希验证的原始文件字节，导出 SHA256 与任务账本一致。没有重排 JSON 造成哈希漂移。
- 线上 adapter 授权为空，未登记真实相机。接机后仍需登记并授权真实 adapter、验证 ARM64 SDK、模式/排线、点亮/RAW、ISP 应用/回读/恢复及画质。

## 已执行验收

1. 正式 d-obs 候选在生产 Node 22.19 下通过 31 项模块测试；Studio 正式候选的相同运行字节在 Node 22.16 和 22.19 下分别通过 28 项测试及五个模块的语法、真实 ESM 导入/导出检查。模块测试使用私有镜像附加测试文件，没有修改正式候选。
2. 两个正式候选直接导入的 HTTP 闭环，在两个实际生产 Node 下均通过：Studio 路由/签名器 → d-obs 路由/私有存储 → Python 3.10.12 / NumPy 2.0.2。使用三个 32×32 合成 RAW12，真实 BLC 得到 R=64、Gr=66、Gb=68、B=70；核对账号隔离、专用 MCP 作用域、ZIP 原始字节哈希。全部为独立 loopback、合成身份和私有 state，清理通过，生产数据写入与硬件操作为 0。
3. 原生 UI 的 39 项组件测试、类型与 i18n 检查通过；完整线上壳加新组件的浏览器 fixture 验证覆盖中文/英文、1280/390 宽度、无板卡入口、RAW/任务/结果/下载、嵌套窗口焦点/关闭和账号 A→B 清理。
4. 按 d-obs → Studio standby → primary 顺序切换后，30 项公网/运行进程检查通过。实际 PID cwd、Node、manifest、覆盖文件及继承文件哈希吻合；三个进程的专用账号桥配置在内存中核对一致，未输出凭据。
5. 公网 `/rdkstudio/` HTML 和六个关键新资源与候选 SHA256 一致，健康/就绪为 200，两种 API 前缀匿名访问均为 401。真实公网的全新匿名浏览器加载 24 个新命名空间资源，均为 200，页面脚本错误和服务器 5xx 均为 0。

**未验收：**真实生产 SSO 登录态下的完整相机工作流、IMX415 实机点亮、目标 ARM64 SDK 链接、RAW 回灌、ISP 实际应用与画质。匿名 401、fixture 账号隔离和公网资源成功分别报告，不能互相替代。四类离线算法沿用已有单元/协议证据，本次正式跨服务已知解闭环只验证 BLC。

## 证据与恢复

机器记录：`output/camera/studio-native-release-20261015.json`。本任务冻结源码、最小 overlay、控制器、浏览器截图、正式候选测试和公网回执保存在任务私有目录 `~/.codex/task-artifacts/studio-camera-completion-20261015/`，服务器端记录在 `/root/.local/share/rdk-camera-release-20261015/`。凭据不进入发布包、manifest、Git 或公开报告。

正式 runner SHA256 为 `6ccd2b980d40d306e600dd1f4b3855d5b683a83a860ec99d2d44ef29ddbbad5c`。旧 runner 因 realpath 解引用 venv Python，首次复测无法加载 NumPy；保留失败日志，修正为保留 venv 入口后在两种生产 Node 下重跑通过。此修正仅涉及验收脚本，没有改动正式候选。

成对发布控制器 SHA256 为 `7f19298a039097726701b96a64eca30288696c461656b64a10b4f30f440f4c15`，15 项隔离测试通过。回滚只可在 current 和专用配置仍属本任务时执行，恢复真实基线软链与专用配置备份，不能覆盖后续发布。生产没有为测试而执行回滚；相关路径仅有隔离测试证据。
