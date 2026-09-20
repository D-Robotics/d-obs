# d-obs 的 Prometheus 持久化抓取

这份配置让 Prometheus 在 d-obs 同机抓取 `127.0.0.1:18093/metrics`。Prometheus 的 TSDB
保存指标历史；d-obs 只负责接收 OTLP metrics、做低基数标签映射并暴露当前样本。

生产机上的容器启动参数应保持以下三个目录关系：

```bash
docker run -d --name d-obs-prometheus --restart unless-stopped --network host \
  -v /opt/d-obs/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro \
  -v /opt/d-obs/prometheus/rules:/etc/prometheus/rules:ro \
  -v /var/lib/d-obs/prometheus:/prometheus \
  prom/prometheus:v3.5.0 \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus \
  --web.enable-lifecycle \
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

Prometheus 按两个数据域抓取四类数据源：云侧的 d-obs OTLP/AI 指标、服务器上的
node-exporter、RDK Studio 私有 OTLP gateway 的 collector 自监控指标，以及端侧的
`/edge-metrics` 设备身份/心跳/最新样本。所有目标都带 `plane=cloud` 或 `plane=edge`，
可用 `sum by (plane)`、`up{plane="edge"}` 直接分域查询。规则文件
`rules/d-obs-baseline.yml` 提供主机 CPU/内存/磁盘、OTLP 接收率、落库队列和端侧离线设备
的 recording rules 与基础告警；通知仍由 d-obs 的事故/通知闭环统一承接。

服务器上的 node-exporter 建议只绑定回环地址：

```bash
docker run -d --name d-obs-node-exporter --restart unless-stopped --network host --pid host \
  -v /proc:/host/proc:ro -v /sys:/host/sys:ro -v /:/rootfs:ro \
  --read-only --security-opt no-new-privileges --cap-drop=ALL \
  prom/node-exporter:v1.9.1 \
  --path.procfs=/host/proc --path.sysfs=/host/sys --path.rootfs=/rootfs \
  --web.listen-address=127.0.0.1:9100
```

RDK 板端使用仓库中的 `tools/edge-agent.mjs` 和
`ops/edge-agent/rdk-edge-agent.service`，设备心跳会进入端侧域和 d-obs 的“边缘设备”面；
弱网样本先落本地 outbox，恢复后补传。云端应用仍使用 OTLP traces/metrics/logs，所有信号
可用 `robot`、`device`、`site`、`firmware` 等受控资源标签关联，但不会和云侧主机指标混在
同一组查询结果里。
如果给 `/metrics` 设置 `RDK_OBSERVABILITY_METRICS_TOKEN`，需要同时在 scrape 配置里增加
`authorization` header，并避免把 token 提交到仓库。
