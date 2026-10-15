# X5 IMX415 相机软件发布记录

2026-10-14 已发布 d-obs 相机软件和 RDK Studio 原生插件接线。入口为 [相机工作台](https://rdkstudio.d-robotics.cc/dobs/ops-observability/vision-workshop)。本次软件发布通过验收；相机尚未收到，板端点亮、采图、ISP 应用和画质仍未验收。

| 服务 | 实际 current | 本次 manifest SHA256 |
| --- | --- | --- |
| d-obs | `/opt/d-obs/releases/camera-isp-v2-20261014-054d8a8829d1` | `5c5249102b3ebd5e35ba5d51a5c17670b54941e1362932304a82971940e455ec` |
| Studio 主备 | `/opt/rdstudio-web-opt/releases/20261014T101947Z-camera-952648b1` | `9428e8051144166ee138b9306f2416b8e27984c2a7bcbdbeb963f769ed8646e7` |

d-obs 发布 25 个文件，Studio 发布 18 个文件，均以实际线上基线加必要补丁组装。旧版本和未覆盖文件的哈希保持一致；没有提交共享工作区、发布其他会话的 UX 改动或切换观测 worker。插件固定为已验收的 1.1.0，归档 SHA256 为 `69a6ab9368cdb0d46239d8111399fad2d8b8fe48f8c728d9d0aaf1bfa5fe32e3`。

## 实际验收

- d-obs 真实生产 Node 22.19：健康和就绪均为 200；源站与公网知识 v2.0.0、42 个 typed MCP 工具、48 项操作目录及只读工具回执通过。
- 公网真实模型知识查询返回正常答案，并有成功的知识 GET 回执。此项验证知识查询，不能当作相机自动调优执行证据。
- Python 3.10 隔离环境和 NumPy 2.0.2 已配置；实际候选 JS 调用 Python 完成 BLC 合成输入计算。未向生产创建校准任务，其他校准算法的测试沿用此前软件验收记录。
- 两个大 JSON 入口的公网 3 MiB 匿名请求返回业务鉴权 403，未被代理以 413 拒绝，未执行设备操作。
- Studio 先切备用，再切主服务；主服务 Node 22.16、备用 Node 22.19 的实际 PID 和 cwd 均对应新版本，源站和公网健康均为 200。新相机接口匿名访问为 401，只证明权限门禁。

## 当前能力边界

d-obs 未登记设备 adapter，点亮、采图、参数应用和 AI 调优显示不可用。实际 Studio 生产环境为 `web-cloud`，相机执行返回 `vision_workshop_account_bridge_unavailable`；这次没有接通多用户云端账号桥。插件代码上线不代表可以在云端通过自然语言操作相机。

本次没有执行板端操作。ARM64 SDK 链接、实际 IMX415 模式与排线、RAW/NV12 采集、参数应用与恢复、RAW replay 和画质改进均保留未验证状态。本地插件仍按原有本机、loopback 和可信身份条件调用。

## 证据与恢复

机器可读验收记录为 `output/camera/x5-camera-release-20261014.json`，对应安全回执保存在同级 `x5-camera-release-20261014-evidence/`。此前 `x5-native-v2-software-acceptance.json` 保持历史原文，不将其旧的未发布状态改写为本次部署证据。

保留的回滚基线为 d-obs `collection-polish-20261013-c92ce87399ff`、Studio `20261012-preserved-1.4.5-0aae8cce`。恢复前须确认 current 仍属于本次发布；只恢复本次软链与专用配置，不能覆盖后续发布。专用配置备份和控制脚本保存在本任务私有发布目录，凭据不进入本记录。
