# Qoder / WorkBuddy 分发与公共市场提交

本目录是可独立托管的相机插件市场源码，`plugins/rdk-camera-workshop` 为单插件目录。另提供单插件 ZIP 和完整市场 ZIP。当前状态是本地预览包；打包或协议测试通过不表示官方上架、宿主完整验收或实机画质达标。

## Qoder

Qoder IDE 支持本地导入，CLI 支持自建 marketplace。`.qoder-plugin/plugin.json` 是插件清单；市场清单位于 `.qoder-plugin/marketplace.json`，根目录另提供相同内容的 `marketplace.json` 便于 URL 分发。将完整市场目录作为独立仓库根目录，不能只上传 marketplace.json 而遗漏相对 source 指向的插件。

国内 QoderWork 的公开发布文档另说明可在客户端提交审核，并在“我的发布”管理；Plugin 引用的 Connector 需要可解析。当前插件采用用户自备服务的本地 stdio 桥，不是已经上架的公共 Connector。公共 Connector 的公开 HTTPS、OAuth、企业身份、隐私条款及服务可用性报告是另一套要求；本次未实现该服务，也不能把当前 admin/SSO header 桥宣称为 OAuth。

先用实际账号与客户端结构预检确认本地 stdio 插件是否可以直接投稿；如果当前市场要求先发布 Connector，则将其记为明确阻塞，不能填写虚构的依赖、公开服务或授权入口。不要用 IDE/CLI 自建市场验收代替 QoderWork 公共市场审核。

## WorkBuddy

官方文档确认支持在插件页添加第三方市场地址。本包使用其内置插件同样的 `.codebuddy-plugin/` 目录和 `CODEBUDDY_PLUGIN_ROOT` 替换形式。市场 ZIP/本地目录导入以实际客户端入口为准；Git 地址需先将本目录托管为独立仓库。当前没有写入任何尚未创建的仓库地址。

公开投稿入口现已核实为 [WorkBuddy 开放平台](https://open.workbuddy.cn/)，需要开发者/企业入驻与认证，再创建专家并提交审核。公开专家还要求 Agent 文件、头像、双语展示名/职业/简介、固定三组标签与快捷提问；通用本地插件包不能直接当作合规专家包。参阅 [专家规范](https://open.workbuddy.cn/docs/expert) 和随包 PUBLIC-RELEASE.md。自建市场分发仍不能宣称已进入官方市场。

Qoder 国际公共市场的“Submit to Community”已核实指向 [我的发布](https://qoder.com/account/apphub-publications)，网页账号需单独登录。

## 提交文案

名称：RDK 相机接入与 ISP 调试助手（预览版）

简介：面向 RDK 相机接入与画质调试，提供接入资料核对、版本排障、已适配相机点亮与采图，以及服务端实际开放的 ISP/标定/恢复工作流。需要用户自己的 d-obs 服务、访问权限与已登记硬件。

边界：不生成未支持 Sensor 的驱动/设备树，不随包部署后台；USB 控制不代表原生 ISP。X5 实机 ISP 与独立画质验收尚未完成。团队经验和实机证据分别标注。

软件授权：Apache-2.0（随包 LICENSE）。发布者沿用源项目 D-Robotics 元数据；公共提交需使用具备该发布身份权限的账号。厂商 SDK、资料全文与凭据不在包内。

## 验收状态

发布时附上本次构建的 host-packages.json 校验值和独立验证报告，分别记录：包结构/哈希、stdio 连接与失败处理、宿主导入/工具发现、真实硬件与画质。fixture 必须显式标记，不用软件测试回执冒充相机点亮。

## 官方依据（核查于 2026-10-15）

- [Qoder CLI 插件规范](https://docs.qoder.com/cli/plugins-reference)
- [Qoder 插件导入](https://docs.qoder.com/qoder/plugins)
- [国内 QoderWork 公开发布要求](https://docs.qoder.cn/en/qoderwork/user-guide/qoderwork-extension-release-guide-skill-plugin-connector)
- [WorkBuddy 插件与第三方市场](https://www.codebuddy.cn/docs/workbuddy/Plugins)
- [CodeBuddy/WorkBuddy 兼容清单与路径变量](https://www.codebuddy.cn/docs/cli/plugins-reference)
