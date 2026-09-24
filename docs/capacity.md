# 容量与性能验收

仓库内的功能测试不能代替目标环境压测。每次发布前，在隔离环境运行：

```bash
RDK_OBS_URL=http://127.0.0.1:47110 \
RDK_OBS_TOKEN="$RDK_PUBLIC_OBSERVABILITY_API_TOKEN" \
RDK_OTLP_REQUESTS=1000 \
RDK_OTLP_CONCURRENCY=16 \
RDK_OTLP_SPANS_PER_REQUEST=8 \
RDK_OTLP_P95_BUDGET_MS=1000 \
npm run smoke:otlp
```

## 首版门槛

| 项目 | 目标 | 失败处理 |
| --- | --- | --- |
| OTLP 写入 HTTP 状态 | 失败率 = 0 | 检查连接池、请求体上限和数据库队列 |
| OTLP partial success | rejected = 0 | 检查字段白名单、时间戳和 ID 生成 |
| 写入 P95 | ≤ 1s（隔离环境） | 增大批量/连接池前先确认数据库锁和队列深度 |
| 指标队列丢弃 | 0 | 降低采样或切换长期指标存储 |
| Prometheus 高基数 | 受控标签无 user/session/trace ID | 检查语义映射和标签预算 |
| 设备心跳 | 设备离线阈值内可发现 | 检查 outbox 回填、令牌缓存和端侧时钟 |

## 扩容触发器

- metric samples 日增超过 2,000 万行，或 14 天保留下查询 P95 超过 3 秒：把样本写入
  专用时序/分析存储，PostgreSQL 保留索引和控制面。
- 单活跃主机无法满足 SLO，或外部生产租户超过 1 个：启用 [ops/ha/README.md](../ops/ha/README.md)
  的 PG 热备和双实例方案。
- 设备数超过 500 台或整点同时上报：要求端侧 Collector/磁盘队列，并打开上报抖动。
