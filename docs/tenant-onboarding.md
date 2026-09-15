# 团队接入 d-obs（租户拨测）

d-obs 以独立项目身份为线上项目提供拨测监控：每个项目注册为租户，拿到
独立的探针 token，由服务器上的 systemd timer 每分钟上报健康状态。
凭据不入仓：token 只存在服务器 `/var/lib/d-obs/probes/<tenant>.token`
（0600）与注册/轮换接口的响应中。

## 当前接入的项目（2026-09-15）

| 租户       | 目标                          | 结果                                    |
| ---------- | ----------------------------- | --------------------------------------- |
| sim2real   | http://127.0.0.1:18102        | /healthz 200 · 入口 200 · healthy       |
| mujoco-lab | http://127.0.0.1:18100        | /healthz 200 · 入口 200 · healthy       |
| microduck  | http://127.0.0.1:18101        | 入口 200 · healthy（无 /healthz，检查停用） |
| platform   | 自带异地探针（source 106.53） | 长期运行                                |

studio 不在本表：它走平台级集成（告警 worker 直接巡检 + 共享中心库的
trace/事故数据），无需注册租户。

## 接入流程（新项目）

1. **注册租户**（在服务器上执行；`RDK_TENANT_REGISTRATION_TOKEN` 在
   `/etc/d-obs.env`，无 token 时接口 fail-closed 503）：

   ```bash
   curl -s -X POST http://127.0.0.1:18093/api/ops/tenants/register \
     -H "content-type: application/json" \
     -H "x-registration-token: $RDK_TENANT_REGISTRATION_TOKEN" \
     -d '{"tenantId":"<project>","displayName":"<project>"}'
   # 响应含一次性明文 probeToken（64-hex），只在此刻可见。
   ```

   tenantId 规则：小写字母开头，小写字母数字连字符，2–40 字符；
   `platform` 等保留字拒绝。

2. **落盘 token**：`echo <probeToken> > /var/lib/d-obs/probes/<project>.token
   && chmod 600 …`。

3. **写 env 文件** `/etc/d-obs/probes/<project>.env`：

   ```text
   RDK_RL_PROBE_TARGET=http://127.0.0.1:<port>
   RDK_RL_PROBE_TOKEN_FILE=/var/lib/d-obs/probes/<project>.token
   ```

4. **启用 timer**（unit 文件在 `ops/probes/`，已装在
   `/etc/systemd/system/`）：`systemctl enable --now tenant-probe@<project>.timer`

5. **验证**：一分钟后看 `journalctl -u tenant-probe@<project>`（期望
   `report=202`），再在 d-obs 总览页检查状态网格出现该租户的 4 项拨测。

## 数据形态

- `studio_external_probe_status`：一行一租户（PK `(tenant_id, source)`），
  租户 source 为 `tenant:<id>`。
- `studio_alert_checks`：租户 alert_key 命名空间化为
  `t.<tenantId>.<checkKey>`（4 项/租户：dns/tls 停用 + health/entry 实测），
  与平台裸 key 互不冲突。
- `studio_alert_incidents`：租户检查故障自动开事故（如 microduck 缺
  /healthz → `t.microduck.external-health` open），看板事故工作台直接展示。

## token 轮换

```bash
curl -s -X POST http://127.0.0.1:18093/api/ops/observability/tenants/<tenantId>/token \
  -H "x-admin-token: $RDK_CREDITS_ADMIN_TOKEN" \
  -H "x-rdk-ops-action: observability"
# 新明文 token 只在响应中；更新 token 文件即可，探针下一次上报自动生效。
```

## 运维要点

- 探针脚本在跨 release 的 `/opt/d-obs/tools/rl-platform-probe.mjs`
  （不在 release 目录内，升级 d-obs 不影响探针）；源文件在仓内
  `tools/rl-platform-probe.mjs`。
- timer 每分钟整点触发（`OnCalendar=*-*-* *:*:00`）。
- 无 /healthz 的纯静态项目（如 microduck）：在项目 env 文件加
  `RDK_RL_PROBE_HEALTHZ=0`，健康检查按停用上报（不开事故）；之后给项目
  补上 /healthz 端点时移除该行即可恢复检查。
