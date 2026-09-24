# Contributing to d-obs

感谢贡献。d-obs 是面向 AI 应用、RDK 设备和边缘运行时的可观测平台，贡献应优先保持
OpenTelemetry 兼容、低敏感数据边界和云端/端侧语义一致。

## 开发流程

```bash
npm ci
npm run typecheck
npm test
npm run build
```

提交前请为新的 API、数据边界、告警状态机和设备协议补测试。涉及 OTLP 字段时，优先
扩展 `shared/ai-observability-semantics.ts` 的规范化映射，而不是在单个路由里增加私有
字段。不要把 prompt、completion、工具参数、凭据、用户标识或原始 IP 写入遥测。

## 变更约定

- 新的观测字段必须有版本化 schema、保留策略和脱敏规则。
- 新的端侧能力必须支持弱网、重复上报和设备级鉴权。
- 生产变更必须经过行动环：提案、证据、审批、白名单执行和后置验证。
- 新的外部依赖需要说明许可证、运行时资源和离线部署影响。
- Pull Request 描述应包含行为变化、验证命令和未完成的生产实测项。

## 数据和安全

贡献者不得提交真实 Token、Webhook、生产数据库连接串、设备序列号或用户内容。发现
安全问题请按 [SECURITY.md](./SECURITY.md) 报告，不要在公开 issue 中发布可利用细节。

## 许可证和第三方代码

仓库核心代码使用 Apache-2.0。`@deepseek-ai/*` 等外部依赖仍受各自许可证和访问策略
约束；提交前必须确认不会把受限代码复制到可分发的核心目录。
