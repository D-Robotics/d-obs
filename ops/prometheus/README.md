# d-obs 的 Prometheus 持久化抓取

这份配置让 Prometheus 在 d-obs 同机抓取 `127.0.0.1:18093/metrics`。Prometheus 的 TSDB
保存指标历史；d-obs 只负责接收 OTLP metrics、做低基数标签映射并暴露当前样本。

生产机上的容器启动参数应保持以下三个目录关系：

```bash
docker run -d --name d-obs-prometheus --restart unless-stopped --network host \
  -v /opt/d-obs/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro \
  -v /var/lib/d-obs/prometheus:/prometheus \
  prom/prometheus:v3.5.0 \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --web.listen-address=127.0.0.1:9090
```

Prometheus 不需要对公网开放；Grafana 或内部运维工具通过本机 `127.0.0.1:9090` 查询。
如果给 `/metrics` 设置 `RDK_OBSERVABILITY_METRICS_TOKEN`，需要同时在 scrape 配置里增加
`authorization` header，并避免把 token 提交到仓库。
