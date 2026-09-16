# 事件级埋点摄取（POST /api/ops/events）

拨测只回答"服务还活着"；事件埋点回答"发生了什么"。接入方（如强化学习
平台 sim2real-web）把低敏业务/运维事件批量上报到本端点，逐条消毒、指纹
去重后写入 `studio_ops_events`，工作台总览的"最近事件"、错误率与登录
统计组件直接按既有 `event_code` 惯例消费。

## 鉴权

与拨测上报共用同一套 256-bit token（先匹配平台 token，再走租户查找）：

- `x-rdk-external-probe-token: <64-hex>`（平台 token 文件）
- `x-rdk-tenant-probe-token: <64-hex>`（租户注册签发的 probeToken）

命中任一即接受。**归属租户由 token 解析出的身份决定**（平台 token → `platform`，
租户 token → 该租户），写入 `studio_ops_events.tenant_id`；正文里不存在这个字段，
上报方无法声明/伪造归属。事件按上报方自带的 `component` 落库（如
`sim2real-web`），工作台按 component 区分来源。

## 租户隔离

### 物理分表（第一道，也是最关键的一道）

平台事件写 `studio_ops_events`，**租户事件写独立的 `studio_ops_events_tenant`**
（同构表，多一个非空 `tenant_id`）。原因是读取方不都在本仓库：线上平台告警规则
评估跑在**主站部署**（`/opt/rdstudio-web-opt/.../studio-alert-worker.js`），它与
本仓库同源但**没有租户过滤**，改它意味着改主站代码并发布业务站。分表之后，任何
既有消费者（主站 worker、主站看板、flywheel 指标）读到的天然只有平台事件，
隔离由存储结构保证，不依赖跨仓库同步。

### 纵深防御（第二道）

`tenant_id` 仍继续写入并参与三处，缺一不可：

1. **写入**：由摄取身份填入（非法/缺省值收敛为 `platform`）。
2. **指纹**：租户进事件指纹，因此同名事件在不同归属下指纹不同——否则知道目标
   指纹的租户可以预置一行，把平台/别家的同名事件在去重窗口内压掉。
3. **读取**：平台侧全部读取点（工作台错误率/事件流/登录指标、平台告警规则、
   Run 证据列表）一律带 `tenant_id = 'platform'`。平台告警规则只看平台自身埋点，
   所以**租户 token 无法再通过上报 `http_5xx` / `tool_call` / `client_error`
   打开平台事故或污染平台口径**。

回归测试 `server/monitoring/ops-event-tenant-scope.test.ts` 对上述读取点做源码级
检查（每个 `studio_ops_events` 读取语句必须带平台租户过滤，唯一豁免是全局保留期
清理），新增查询漏掉过滤会直接测失败。

### 保留期（需单独调度）

平台事件表的保留期由**主站部署**的告警 worker 清理（30 天），而它不认识
`studio_ops_events_tenant`；d-obs 自带的 worker 清理逻辑只在 d-obs 自己跑 worker
时生效，线上并不跑它。因此租户事件表需要独立调度，否则会无界增长：

```bash
# 仓内已提供脚本与 unit（ops/retention/）
install -m 0644 ops/retention/tenant-events-retention.{service,timer} /etc/systemd/system/
install -d /opt/d-obs/tools && install -m 0755 tools/trim-tenant-events.mjs /opt/d-obs/tools/
# 脚本放在 tools/（跨 release），但 pg 在 release 内：需要这条软链，否则 ERR_MODULE_NOT_FOUND
ln -sfn /opt/d-obs/current/node_modules /opt/d-obs/node_modules
systemctl daemon-reload && systemctl enable --now tenant-events-retention.timer
systemctl list-timers tenant-events-retention.timer      # 核对下次触发
# 手动跑一次（保留天数默认 30，可传参）
RDK_CHAT_CREDITS_DB_URL=... node tools/trim-tenant-events.mjs 30
```

### 租户侧展示

租户 overview（`GET /api/ops/observability/overview`，组员/owner 或租户 token 访问）
会带上本租户自己的「最近事件」面板，数据来自 `studio_ops_events_tenant`，查询按
**服务端解析出的 tenantScope** 过滤（不接受客户端声明）。平台视图不加这张表——
平台事件仍在「事故调查」里作为证据查看，避免重复。管理员用 `?tenant=<id>` 切到某
租户视角时同样会看到该租户的事件。

## 契约

```json
POST /api/ops/events
{
  "schema": "rdk.dobs.ops-events.v1",
  "producedBy": "sim2real-web",
  "events": [
    {
      "eventId": "0b74e5c1-…",           // 必填，幂等键（进指纹）
      "component": "sim2real-web",       // 必填 slug
      "eventCode": "run_created",        // 必填 slug，看板按此聚合
      "outcome": "ok",                   // ok | error | rejected | degraded
      "severityHint": "info",            // 可选 info | warning | critical
      "safeSummary": "run entered training",   // 可选 ≤500（写入前再消毒）
      "metadata": { "engine": "starter-ppo" }, // 可选 ≤32 键标量
      "correlation": { "runId": "run-1", "userId": "u1" },
      "occurredAt": "2026-09-15T08:00:00Z",    // 可选 ISO，缺省用服务端时刻
      "dedupeWithinMs": 3600000               // 可选，上限 1h
    }
  ]
}
```

回执 `202 { ok, accepted, dropped, failed, tenant }`；批级问题整批拒绝
（400 invalid_schema/invalid_producer/empty_batch，413 item_limit/
request_bytes_limit）；单条身份/枚举字段非法只丢弃该条并计入 `dropped`。

## 幂等与上限

- `eventId` 进入事件指纹，默认 1h 去重窗口——客户端按 eventId 重试天然
  幂等（`recordOpsEvent` 的 dedupe 查询按指纹短路）。
- 批次 ≤64 条、请求 ≤256KB；同身份限速 120 req/min（封顶 7680 行/分钟）。
- 正文、摘要、metadata 全部经 `sanitizeOpsSummary`/`safeMetadata` 消毒：
  凭据形状内容、邮箱/手机号直接标识一律打码后才落库。

## event_code 惯例

总览的错误率/登录组件按固定 `event_code` 聚合，接入方应沿用：

| event_code            | outcome 语义                     | 点亮的看板组件   |
| --------------------- | -------------------------------- | ---------------- |
| `http_5xx`            | error                            | API 5xx 计数     |
| `sso_login_attempt`   | ok / rejected / error            | 登录成功/拒绝    |
| `process_unhandled_error` | error                        | 进程错误计数     |
| `client_error`        | error                            | 客户端错误计数   |
| `tool_call`           | ok / error                       | 工具失败计数     |
| 其他（如 `run_created`） | 任意                         | "最近事件"列表   |

## curl 示例

```bash
TOKEN=$(cat /var/lib/d-obs/probes/<tenant>.token)
curl -s -X POST http://127.0.0.1:18093/api/ops/events \
  -H "content-type: application/json" \
  -H "x-rdk-tenant-probe-token: $TOKEN" \
  -d '{"schema":"rdk.dobs.ops-events.v1","producedBy":"sim2real-web","events":[
    {"eventId":"'"$(uuidgen)"'","component":"sim2real-web",
     "eventCode":"run_created","outcome":"ok",
     "correlation":{"runId":"run-1"}}]}'
# 期望 {"ok":true,"accepted":1,...}
```

验证：工作台「最近事件」出现该条，或直接查
`select component,event_code,outcome from studio_ops_events order by occurred_at desc limit 5`。
