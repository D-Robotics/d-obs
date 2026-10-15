# 公共市场投稿说明

公开名称：地瓜相机调试助手 / RDK Camera Workshop。
发布者：D-Robotics。联系邮箱以插件清单中用户确认的 author.email 为准。
检索词：D-Robotics、地瓜机器人、RDK、相机点亮、相机调试、MIPI、USB、ISP、IMX415、X5。

## 能力与依赖

本插件把相机接入知识、版本排障和已适配相机的采图、控制、ISP 与恢复流程交给 AI 宿主执行。实际操作通过用户自备 d-obs 服务开放的 typed MCP 工具；服务端须已登记硬件与 adapter。无需设备可阅读随包知识和规划步骤。

首次安装时本地 vision_connection_status 可报告连接配置缺项；它不表示远端或相机在线。Node.js 22+、自己的服务地址及访问权限是执行工具的前提，安装包不提供托管后台、厂商 SDK、传感器驱动或示例账号。

## 当前证据

前版 stdio MCP/配置与失败处理已通过 24 项测试，打包搬移校验测试通过，Qoder 桌面实际导入与本地诊断工具发现通过。公开版本另做展示字段、Agent、头像及档案校验。尚无公开市场审核回执，也未完成 WorkBuddy 公开专家的客户端实装；新版本公开展示字段不视为已通过客户端审核。

X5 原生 ISP 实机及独立画质验收尚未完成；USB UVC 控制不能证明板卡 ISP。新 Sensor 驱动、设备树和寄存器表生成未实现。公开文案不宣称这些能力已交付。

## 数据处理边界

桥接器运行在用户本机，连接配置和凭据保存在插件及源码仓库外；不随包上传。相机图像、参数和运行记录由用户配置的 d-obs 服务保存与处理；当用户调用视觉模型或宿主工具时，相关数据会进入其选择的 AI 模型/宿主服务。用户应按自己的服务与宿主配置控制数据留存和访问。该说明是技术数据流说明，不替代平台要求的企业隐私政策或服务条款。

本包不含真实凭据、客户图像、厂商资料全文或二进制 SDK。软件采用随包 Apache-2.0 许可证；头像为本项目绘制的相机插画，不是新增的公司官方标志。

## 投稿及可搜索的判定

- Qoder：[我的发布](https://qoder.com/account/apphub-publications)。该入口来自[公共市场的 Submit to Community](https://qoder.com/marketplace)，需要网页账号登录。提交该宿主的单插件投稿 ZIP，按页面预检和审核要求填写公开资料。进入公共市场并可被其他账号检索后，才算搜索可达；本机导入不能替代。
- WorkBuddy：[开放平台](https://open.workbuddy.cn/)。登录后选择 D-Robotics 发布主体，按需完成企业/开发者认证，再创建“专家”，上传 WorkBuddy 专家投稿 ZIP。随包 .codebuddy-plugin/plugin.json、agents、头像和展示字段依据[官方专家规范](https://open.workbuddy.cn/docs/expert)准备。实际上传解析和审核仍需平台回执。

如果后台要求额外 Connector 审核、公开服务或法律资料，必须按真实服务能力补齐；当前 stdio 与 admin/SSO header 桥不能冒充 OAuth 服务。发布过程遇到合同、企业认证或身份核验时由主体持有人完成。

成功验收应记录资产 ID、提交/审核状态、公开详情页，以及用另一个账号检索“D-Robotics”“地瓜相机”“RDK”“ISP”的结果。仅生成 ZIP、提交审核或上传完成都不能写成已经可搜索。

## 官方资料

核查日期：2026-10-15。

- [Qoder 公共发布要求](https://docs.qoder.cn/en/qoderwork/user-guide/qoderwork-extension-release-guide-skill-plugin-connector)
- [WorkBuddy 开放平台流程](https://open.workbuddy.cn/docs)
- [WorkBuddy 开发者/企业入驻](https://open.workbuddy.cn/docs/onboarding)
- [WorkBuddy 专家展示规范](https://open.workbuddy.cn/docs/expert)
