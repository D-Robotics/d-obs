# 日报 / 周报定时单元

飞书卡片投递的两个定时单元，跑在 d-obs 发布目录内（随每次发布自动更新代码）：

| 单元 | 时间（Asia/Shanghai） | 脚本 | 内容 |
| --- | --- | --- | --- |
| `d-obs-daily-digest` | 每天 20:00 | `server/monitoring/studio-error-digest.js` | 每日稳定性摘要：巡检/事故/错误聚类/AI Run/通知投递 |
| `d-obs-weekly-digest` | 每周五 18:00 | `server/monitoring/studio-weekly-digest.js` | 运营周报：周窗口事故开闭与 MTTR、按天分布、环比、错误 Top |

两者共用告警配置（`studio_alert_config`，PG 优先）里的飞书 Webhook，卡片跳转按钮使用 `notification.dashboardUrl` 深链。

## 安装（生产 47.110.142.255）

```bash
cp ops/digests/d-obs-{daily,weekly}-digest.{service,timer} /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now d-obs-daily-digest.timer d-obs-weekly-digest.timer
```

手动触发（真实投递）与预览：

```bash
systemctl start d-obs-daily-digest.service
/opt/node-v22.19.0-linux-x64/bin/node /opt/d-obs/current/server/monitoring/studio-weekly-digest.js --dry-run
```

## 历史

2026-10-08 前的日报由旧单元 `rdstudio-error-digest.timer`（每天 10:00/20:00）承担，
但其构建来自 rdstudio-web-opt 的旧版 alert-config schema：9-23 起配置里带审计字段
（createdBy/createdAt 等）即被 zod 拒绝，静默回落 safe defaults（notification.enabled=false），
此后所有投递均为 `notification_disabled`，实际从未送达。新单元改从 d-obs 发布目录运行并读
同一份 PG 配置后修复。旧 timer 应保持 disabled。
