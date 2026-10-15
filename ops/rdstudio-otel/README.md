# rdstudio-otel-collector 联动脚本

rdstudio 的 OTel Collector 与 d-obs 之间的运维脚本（生产主机 47.110.142.255）。
背景与接入模式见 [docs/onboarding.md §3.1](../../docs/onboarding.md)。

## d-obs local transition

生产机的 `STUDIO_TRACE_LOCAL_OTLP_ENDPOINT` 固定指向同机 d-obs 的
`http://127.0.0.1:18093`，`STUDIO_TRACE_LOCAL_OTLP_TOKEN_FILE` 使用 d-obs
凭据注册表签发的 `rdkstudio-otel-collector` service token。切换 endpoint 或
轮换 token 后，必须重启 `rdstudio-otel-collector.service` 并确认
`otelcol_exporter_sent_spans{exporter="otlp_http/local_transition"}` 增长、队列
回到 0。

发布包会安装 `render-config-safe.sh`：候选配置的 SHA-256 不等于 capability
登记值时保留上一份已验证配置，避免 renderer 漂移触发 systemd 重启循环。每 5
分钟运行 `rdstudio-otel-preflight.service`，检查 endpoint、token、配置与 evidence
摘要、evidence 剩余有效期和 local transition exporter 的失败计数增量。

## heartbeat.mjs — 链路管道心跳

每小时向 collector 中央入口（127.0.0.1:14318）注入 1 条合成 ERROR span
（尾采样必留），让 d-obs 的 `otlp-trace-freshness` 告警语义保持为
「管道断了」而非「没流量」。部署为
`d-obs-trace-heartbeat.{service,timer}`（systemd，2026-10-08 启用）。

## cohort-expand.mjs — 导出灰度名单扩量

应用侧 relay 转发（`collector-relay-forwarder.ts`）按账号 HMAC 门控是否把
trace 批次转发给 collector。本脚本把名单从灰度 3 人扩到全部活跃账号：
scope ref 推导与应用侧 `deriveStudioCollectorScopeRef` 逐字节一致，
正确性可用 2026-08-27 旧名单（ztc_host/qiaolongli/lx199710 三人）交叉验证。
名单文件被转发器每次批量重读，改动热生效；回滚恢复 `.bak-20261008` 即可。
