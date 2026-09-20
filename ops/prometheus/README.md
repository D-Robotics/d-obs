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
  --web.listen-address=127.0.0.1:9090 \
  --web.external-url=https://rdkstudio.d-robotics.cc/dobs/prometheus/ \
  --web.route-prefix=/dobs/prometheus
```

线上查询入口是
`https://rdkstudio.d-robotics.cc/dobs/prometheus/graph`，由 RDK Studio 的 nginx
反代到本机 Prometheus，并通过 d-obs 的 `/api/ops/prometheus/auth` 复用 RDK Studio
SSO/运营管理员权限。Prometheus 仍只监听 `127.0.0.1:9090`，不能绕过 RDK Studio 直接访问。

需要在生产 nginx 的 TLS server 中将 `/dobs/prometheus/`（放在通用 `/dobs/` location
之前）代理到 `http://127.0.0.1:9090`，并用 `auth_request` 调用
`http://127.0.0.1:18093/api/ops/prometheus/auth`。代理时保留完整 URI，才能匹配上面的
`--web.route-prefix`。

如果暂时不走线上入口，Grafana 或内部运维工具仍可通过本机 `127.0.0.1:9090` 查询。
如果给 `/metrics` 设置 `RDK_OBSERVABILITY_METRICS_TOKEN`，需要同时在 scrape 配置里增加
`authorization` header，并避免把 token 提交到仓库。
