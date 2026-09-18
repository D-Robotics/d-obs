# AI 原生生态接入

d-obs 把 AI 观测数据收敛到 OpenTelemetry OTLP。应用可以使用 HTTP JSON、HTTP protobuf
或标准 OTLP/gRPC，Phoenix、Langfuse、OpenInference 以及其他兼容 OTLP 的 SDK 都可以复用
同一条数据通道。

## 入口

| 用途 | HTTP 入口 | 鉴权 |
| --- | --- | --- |
| OTLP traces | `POST /v1/traces` | `Authorization: Bearer/Basic <credential>`、`x-api-key` 或 `api-key` |
| Phoenix/Langfuse OTLP 别名 | `POST /api/public/otel/v1/traces` | 同上 |
| OTLP metrics | `POST /v1/metrics` | 同上 |
| OTLP HTTP protobuf | 上述 traces/metrics 路径 + `Content-Type: application/x-protobuf` | 同上 |
| OTLP gRPC | `opentelemetry.proto.collector.{trace,metrics}.v1.*Service/Export` | gRPC metadata 中的 `authorization`、`x-api-key` 或 `api-key` |
| Prometheus scrape | `GET /metrics` | 默认匿名；配置 `RDK_OBSERVABILITY_METRICS_TOKEN` 后需要 Bearer/API key |
| 能力发现 | `GET /api/v1/ecosystem/capabilities` | 无需鉴权 |

配置写入 token：

```bash
export RDK_PUBLIC_OBSERVABILITY_API_TOKEN='change-me-with-a-long-random-value'
```

没有配置固定 token 时，d-obs 仍会按每个 Bearer/Basic/API key 的 SHA-256 建立隔离 owner，
但生产环境应显式配置固定 token，避免任意调用方创建新的 scope。

## OpenTelemetry SDK

HTTP JSON exporter：

```bash
export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT='http://127.0.0.1:47110/v1/traces'
export OTEL_EXPORTER_OTLP_TRACES_PROTOCOL='http/json'
export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer change-me-with-a-long-random-value'
```

HTTP protobuf exporter 只需将协议改为 `http/protobuf`，路径仍然是 `/v1/traces` 或
`/v1/metrics`：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:47110'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer change-me-with-a-long-random-value'
```

gRPC receiver 默认不启动，配置端口后启用标准 OTLP Trace/Metrics 服务：

```bash
export RDK_OTLP_GRPC_HOST='127.0.0.1'
export RDK_OTLP_GRPC_PORT='4317'
export RDK_PUBLIC_OBSERVABILITY_API_TOKEN='change-me-with-a-long-random-value'
```

标准 OpenTelemetry gRPC exporter：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT='http://127.0.0.1:4317'
export OTEL_EXPORTER_OTLP_PROTOCOL='grpc'
export OTEL_EXPORTER_OTLP_HEADERS='authorization=Bearer change-me-with-a-long-random-value'
```

gRPC 监听器当前使用明文连接，建议只绑定回环或内网地址，并在外部 TLS/mTLS 终止层后面部署。

最小请求示例：

```bash
curl -X POST http://127.0.0.1:47110/v1/traces \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer change-me-with-a-long-random-value' \
  -d '{
    "resourceSpans": [{
      "resource": {"attributes": [
        {"key":"service.name","value":{"stringValue":"agent-api"}},
        {"key":"deployment.environment.name","value":{"stringValue":"production"}}
      ]},
      "scopeSpans": [{"spans": [{
        "traceId":"11111111111111111111111111111111",
        "spanId":"2222222222222222",
        "name":"chat completion",
        "startTimeUnixNano":"1730000000000000000",
        "endTimeUnixNano":"1730000000100000000",
        "attributes": [
          {"key":"gen_ai.request.model","value":{"stringValue":"qwen"}},
          {"key":"gen_ai.usage.input_tokens","value":{"intValue":"128"}},
          {"key":"gen_ai.usage.output_tokens","value":{"intValue":"64"}}
        ]
      }]}]
    }]
  }'
```

响应遵循 OTLP partial success 形状：`rejectedSpans` 为 0 表示已接受；低敏感策略、
非法 ID、无效时间或超限字段会计入 rejected，不会把原始 payload 写入数据库。

## Phoenix 与 Langfuse

Phoenix 的 tracing collector 使用 OTLP，因此把 exporter endpoint 指向
`http://<d-obs>/v1/traces` 即可。Langfuse 新版推荐使用 OpenTelemetry ingestion，配置
其 SDK 的 OTEL endpoint 指向同一入口；Langfuse 的
`Authorization: Basic <base64(public_key:secret_key)>` 会被保留为独立 scope。旧版私有
ingestion payload 不作为稳定兼容面。

这两个生态最终都会落到同一套 d-obs 语义：

| 外部语义 | d-obs 字段 |
| --- | --- |
| `gen_ai.request.model` / `gen_ai.response.model` | `model` |
| `gen_ai.system` / `gen_ai.provider.name` | `provider` |
| `gen_ai.usage.input_tokens` | `inputTokens` |
| `gen_ai.usage.output_tokens` | `outputTokens` |
| `tool.name` / `gen_ai.tool.name` | `toolName` |
| `service.name` | `service` |
| `deployment.environment.name` | `environment` |
| `moss.run.id` / `gen_ai.conversation.id` | run identity |

## Prometheus

把 `/metrics` 加入 Prometheus scrape 配置：

```yaml
scrape_configs:
  - job_name: d-obs
    static_configs:
      - targets: ['d-obs:47110']
    metrics_path: /metrics
```

平台提供 OTLP 接入量、接受/拒绝数、创建 run 数，以及最近收到的上游 metric point。
指标名称经过清洗并限制数量，避免把用户 ID、trace ID 等高基数字段带入 Prometheus。

## 数据边界

接入层只允许低敏感字段：模型、提供商、Token 数、工具名、服务、环境、版本、对象引用、
状态和耗时。prompt、completion、tool arguments/results、URL query、凭据、session 原文
和原始账号标识不会被保存。需要业务级内容审计时，应使用独立的脱敏审计系统，不要把原文
塞进 trace attributes。

## 本地验证

```bash
npm run typecheck
node --import tsx --test server/observability/ai-ecosystem-routes.test.ts
curl http://127.0.0.1:47110/api/v1/ecosystem/capabilities
curl http://127.0.0.1:47110/metrics
```
