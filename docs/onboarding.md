# 接入指南：新服务器与新应用

被观测对象接入 d-obs 的总入口。核心口径是**对象自动注册**：接入方只要按约定
上报数据，resource 里的身份属性（`device.id` / `robot.id` / `host.name` /
`service.name` / `project.id`）就会自动登记为告警对象
（`public.studio_obs_object_registry`），告警、看板、处置挂在同一个对象模型上——
对象清单不需要手工维护。登记是尽力而为（fire-and-forget），失败不影响摄入主链路。

实现见 `server/monitoring/observability-object-registry.ts`；已登记对象在工作台
「告警中心 → 告警对象」查看。

## 路径选择

| 接入对象 | 路径 | 鉴权凭据 | 细节文档 |
| --- | --- | --- | --- |
| RDK 边缘设备 / 开发板 | 工作台注册设备 → `tools/edge-agent.mjs` 心跳上报 | 设备 token（`x-rdk-device-token`） | [ecosystem.md](./ecosystem.md) |
| 一般 Linux 服务器 | node_exporter 进 Prometheus（指标历史）+ OTLP 携带 `host.name`（对象登记） | metrics token / OTLP Bearer | 本文 §2 |
| 云端应用 / AI 应用 | OTLP 三信号（traces / metrics / logs） | OTLP Bearer / API key | [ecosystem.md](./ecosystem.md) |
| 只需存活拨测的项目 | 租户自助注册 → tenant-probe timer 每分钟拨测 | 探针 token（`x-rdk-tenant-probe-token`） | [tenant-onboarding.md](./tenant-onboarding.md) |
| 业务/运维事件埋点 | `POST /api/ops/events` 批量上报（可叠加在租户接入上） | 探针 token 同上 | [event-ingest.md](./event-ingest.md) |

## 1. RDK 边缘设备

1. 工作台「边缘设备」注册设备（如 `rdk-x5-01`），拿到一次性设备 token；
2. 把 `tools/edge-agent.mjs` 复制到板子，token 存入 `0600` 文件；
3. 板上运行（或装 `ops/edge-agent/rdk-edge-agent.service`）：

   ```bash
   export RDK_OBS_REPORT_URL='https://<d-obs-host>:<port>'
   export RDK_DEVICE_TOKEN_FILE=/var/lib/rdk-edge-agent/token
   export RDK_EDGE_REQUIRE_TLS=1             # 生产环境拒绝明文 HTTP
   export RDK_EDGE_MAX_BACKOFF_SECONDS=900   # 弱网指数退避上限
   node tools/edge-agent.mjs
   ```

可通过 SSH 访问时用一键脚本完成注册、token 下发、systemd 安装与首次启动：

```bash
ops/edge-agent/bootstrap.sh \
  --board <board-ip> --device-id rdk-x5-01 --model X5 \
  --admin-token "$RDK_CREDITS_ADMIN_TOKEN"
```

agent 每分钟采集 CPU/内存/温度/磁盘/BPU 上报 `POST /api/edge/heartbeat`；弱网时
样本缓冲在本地 `outbox.jsonl`，恢复后自动补传（回填窗口 7 天）。设备自动登记为
`device/<id>` 对象，支持下行命令（claim/ack）。设备 token 在工作台签发，库内只存
哈希；`RDK_DEVICE_OFFLINE_MINUTES`（默认 5）控制离线判定。

## 2. 一般 Linux 服务器

两条通道各管一层，建议都配：

- **指标历史（Prometheus）**：服务器安装 node_exporter，纳入生产 Prometheus 抓取
  （`plane=cloud`）；PromQL 查询与 Grafana 历史都在这一层，配置见
  [ops/prometheus/](../ops/prometheus/)。
- **对象登记与告警中心可见（OTLP）**：让服务器上的采集 agent 以 OTLP 上报任一信号
  （指标最常用），resource attributes 携带 `host.name`，首次上报即登记为
  `host/<hostname>` 对象；resource 属性会原样进入对象 labels（可携带 ip、role 等）。

已知边界：内置主机告警规则（disk-space、node-memory-pressure、node-cpu-load 等）
当前绑定 `host/self`，worker 解析为**平台本机**主机名。给新服务器配独立告警需要在
`server/monitoring/alert-config.ts` 的 `ALERT_RULE_OBJECT_TARGETS` 补规则与对象映射
（见 §6）。

## 3. 云端应用 / AI 应用（OTLP）

端点与协议：`POST /v1/traces`、`/v1/metrics`、`/v1/logs`（兼容
`/api/public/otel/v1/*`、`/api/v1/otel/v1/*` 别名与标准 OTLP/gRPC）；支持
HTTP JSON、HTTP protobuf 两种编码。Phoenix、Langfuse 以及一切 OTLP 兼容 SDK
直接复用同一入口。

鉴权：`Authorization: Bearer <token>`（或 `x-api-key` / `api-key`）；生产环境配置
`RDK_PUBLIC_OBSERVABILITY_API_TOKEN`。

SDK 最小配置：

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT='https://rdkstudio.d-robotics.cc/dobs'
export OTEL_EXPORTER_OTLP_PROTOCOL='http/protobuf'
export OTEL_EXPORTER_OTLP_HEADERS='Authorization=Bearer <token>'
```

生产公网入口经 nginx（`/dobs` 前缀），三信号 `/v1/*` 均已暴露（2026-10-05 实测：
无凭据 401、带凭据 200）。自托管未走反向代理时，端点为 `http://<d-obs-host>:<PORT>`
（`PORT` 默认 47110）；gRPC 通道面向同机/内网，公网接入统一使用 HTTP。
凭据的端到端验证命令（curl 直发 OTLP/HTTP JSON 并查回落库）见工作台
「观测查询 → 接入凭据 → 验证本凭据」。

要点：

- resource 带 `service.name` → 自动登记 `service/<name>` 对象；身份推导优先级为
  `device.id` > `robot.id` > `host.name` > `service.name` > `project.id`；
- 三信号均落库，默认保留 14 天（`RDK_OBSERVABILITY_SIGNAL_RETENTION_DAYS`）；
  长期历史与 PromQL 走 Prometheus 抓 `/metrics`，业务指标暴露在 `/metrics/business`；
- 低敏感边界：prompt、completion、工具参数/结果、凭据、URL query 不收；
- 跨机器人/云端/服务器关联用 `rdk.robot.id`、`rdk.device.id`、`rdk.site.id`、
  `rdk.firmware.version` 等稳定身份字段；用户 ID、session ID、trace ID 只用于
  Trace 关联，禁止进入指标标签。

AI 语义映射（gen_ai.* / OpenInference）、评估写入与 gRPC 启用方式见
[ecosystem.md](./ecosystem.md)。

## 4. 租户拨测（新项目最小接入）

适合只需要存活监控的项目：注册为租户，独立探针 token，systemd timer 每分钟拨测，
数据按租户隔离，故障自动开命名空间事故（`t.<tenantId>.<checkKey>`），对象推导为
`实体@租户`。

1. **注册租户**（服务器上执行；`RDK_TENANT_REGISTRATION_TOKEN` 在
   `/etc/d-obs.env`，未配置时接口 fail-closed 503）：

   ```bash
   curl -s -X POST http://127.0.0.1:18093/api/ops/tenants/register \
     -H "content-type: application/json" \
     -H "x-registration-token: $RDK_TENANT_REGISTRATION_TOKEN" \
     -d '{"tenantId":"<project>","displayName":"<project>"}'
   # 响应含一次性明文 probeToken（64-hex），只在此刻可见
   ```

2. **落盘 token**：`echo <probeToken> > /var/lib/d-obs/probes/<project>.token
   && chmod 600 …`；
3. **写 env 文件** `/etc/d-obs/probes/<project>.env`（probe target + token 文件路径）；
4. **启用 timer**：`systemctl enable --now tenant-probe@<project>.timer`
   （unit 在 `ops/probes/`）；
5. **验证**：一分钟后 `journalctl -u tenant-probe@<project>` 期望 `report=202`；
   总览页出现该租户的 4 项拨测。

撤销与 token 轮换必须走服务接口（面板操作或 admin API）；直接改库撤销存在
token 查找缓存窗口。完整流程、隔离语义与运维要点见
[tenant-onboarding.md](./tenant-onboarding.md)。

## 5. 事件级埋点（可选，叠加在拨测之上）

拨测回答"服务活着没有"，事件埋点回答"发生了什么"：租户 token 同时可用于
`POST /api/ops/events` 批量上报低敏业务/运维事件（幂等键去重、逐条消毒），
点亮工作台错误率、登录统计与最近事件组件。契约、幂等与 `event_code` 惯例见
[event-ingest.md](./event-ingest.md)。

## 6. 告警覆盖：自动与显式

- **自动**：对象一经登记即出现在告警中心对象面板，OTLP 信号、设备心跳、拨测数据
  自动挂到对应对象；租户检查故障自动开命名空间事故并进入处置闭环。
- **显式**：内置告警规则 → 对象的绑定关系在 `ALERT_RULE_OBJECT_TARGETS`
  （`server/monitoring/alert-config.ts`），未映射的规则默认落
  `service/<key>`。给新服务器/新应用配置专属告警规则时，规则本身在工作台
  「告警策略」维护，规则与对象的映射在该表中补充。

## 验证

```bash
curl https://rdkstudio.d-robotics.cc/dobs/api/v1/ecosystem/capabilities   # 能力自描述，无需鉴权（自托管时用 http://<host>:<PORT>/api/v1/ecosystem/capabilities）
```

- 工作台「告警中心 → 告警对象」确认新对象已出现；或直接查库：

  ```sql
  select object_id, object_type, display_name, last_seen_at
  from public.studio_obs_object_registry
  order by last_seen_at desc limit 20;
  ```

- 边缘设备：`journalctl -u rdk-edge-agent@<device-id>` 看首轮心跳，工作台
  「边缘设备」确认在线；
- 租户拨测：`journalctl -u tenant-probe@<project>` 期望 `report=202`。
