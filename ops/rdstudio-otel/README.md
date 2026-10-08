# rdstudio-otel-collector 联动脚本

rdstudio 的 OTel Collector 与 d-obs 之间的运维脚本（生产主机 47.110.142.255）。
背景与接入模式见 [docs/onboarding.md §3.1](../../docs/onboarding.md)。

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
