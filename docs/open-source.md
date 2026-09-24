# 开源与生态边界

d-obs 的开源策略分为两层：

1. **核心平台与协议**：Apache-2.0，优先兼容 OpenTelemetry OTLP、Prometheus exposition、
   Phoenix/Langfuse/OpenInference 语义、Grafana JSON 和 MCP。核心数据模型不依赖某一家
   模型供应商。
2. **部署适配器**：RDK Studio SSO、D-Robotics 模型网关、生产通知渠道和内部数据库表属于
   部署适配层，可以由部署方替换，不应成为核心协议的隐式前提。

## 可替换边界

- 采集：OTLP HTTP JSON、HTTP protobuf、gRPC、设备 heartbeat、Prometheus scrape。
- 存储：PostgreSQL 是默认小规模实现；Prometheus/VictoriaMetrics 承担长期指标历史；在
  指标日增或查询延迟达到门槛后，可替换为专用分析存储。
- 身份：固定 API token、服务/租户 ingest token、SSO adapter 三种方式都通过统一 principal
  进入平台。
- 执行：行动环只调用白名单剧本，不允许把任意 shell 或脚本下发到设备。

## 发布一个可复现环境

发布前应提供：Node.js 22、PostgreSQL、Prometheus/Grafana（可选）、最小 OTLP 示例、
环境变量样例和不含敏感数据的演示数据库。生产专用依赖必须在文档中标出，不能让默认
`npm ci` 隐式依赖未公开的内部仓库。

## 贡献门槛

提交前运行 `npm run typecheck`、`npm test`、`npm run build`。涉及协议、隐私、告警或设备
命令的改动必须同时更新 schema、文档和回归测试。
