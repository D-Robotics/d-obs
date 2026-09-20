# VictoriaMetrics 高可用指标存储

生产机使用 VictoriaMetrics Cluster 接收 Prometheus `remote_write`：两个
三个 `vmstorage` 节点保存副本，两个 `vminsert` / `vmselect` 由 HAProxy 做故障转移，
`vminsert` 的复制因子为 2，`vmselect` 查询时按 15 秒去重。数据保留 90 天，Prometheus
本地 TSDB 仍然保留即时查询、规则评估和告警入口。

```text
Prometheus (scrape / rules / UI)
        │ remote_write
        ▼
  HAProxy :8480  ──┬─ vminsert-a ──┐
                   └─ vminsert-b ──┴─ replicationFactor=2 ──┬─ vmstorage-a
                                                             ├─ vmstorage-b
                                                             └─ vmstorage-c
  HAProxy :8481  ──┬─ vmselect-a ──┐
                   └─ vmselect-b ──┴─ PromQL / 长期历史
```

部署目录：`/opt/d-obs/storage/victoria-metrics`；数据目录：
`/var/lib/d-obs/victoria-metrics/{a,b}`。服务只绑定回环地址：

| 入口 | 用途 |
| --- | --- |
| `127.0.0.1:8480` | Prometheus remote_write |
| `127.0.0.1:8481` | 长期历史 PromQL（vmselect） |
| `127.0.0.1:8482` / `8483` / `8490` | vmstorage-a/b/c 自监控 |
| `127.0.0.1:8484` / `8488` | vminsert-a/b 自监控 |
| `127.0.0.1:8485` / `8489` | vmselect-a/b 自监控 |

验证：

```bash
docker compose ps
curl -fsS http://127.0.0.1:8480/metrics | grep vm_insert
curl -fsS http://127.0.0.1:8481/select/0/prometheus/api/v1/query \
  --get --data-urlencode 'query=up'
```

三个 storage 节点满足复制因子 2 在单个 storage 故障时继续写入双副本的要求；这套部署在同一台
服务器上，能够承受单个容器或单个 vmstorage 进程故障；它不能承受
服务器整机、机房或同一块物理磁盘损坏。跨主机 HA 需要把三个 vmstorage 放到不同主机/可用区，
并把备份写到独立对象存储。VictoriaMetrics 官方也明确建议对复制集群做独立备份。
