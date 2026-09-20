# 双跑对账报告（D-010 Phase 3 影子流量证据）

- **日期**：2026-09-20
- **基线（old）**：release `prometheus-query-link-20260920-143723`（本日扩展+加固合入前的最后版本）
- **对照（new）**：release `obs-hardening-20260920-172014`（当前生产）
- **方法**：生产 PG 从同一份备份克隆两个影子库（`d_obs_shadow_a/b`，各 71 表）；旧/新 release 分别绑定影子库跑在 18094/18095；读路径逐端点归一化 diff，写入路径注入**完全相同**的故障探针报文后比对落库行（时间戳归一化）。

## 读路径（GET，admin token，ISO 时间戳归一化）

| 端点 | 结论 | 说明 |
| --- | --- | --- |
| `/status`（HTML） | **IDENTICAL** | 逐字节一致 |
| `/api/ops/observability/access` | **IDENTICAL** | |
| `/api/ops/observability/config` | **IDENTICAL** | |
| `/api/ops/observability/tenants` | **IDENTICAL** | |
| `/api/ops/observability/learning` | **IDENTICAL** | |
| `/overview?hours=24` | DIFF（可归因） | run locator 为 AEAD 随机 nonce 密封，每次请求必然不同（密码学性质，非回归） |
| `/database`（目录） | DIFF（可归因） | `databaseSizeBytes` 等活统计值在两个影子库间自然漂移；结构一致 |
| `/operator-metrics` | DIFF（可归因） | 新版增加 `cost` 成本归因字段（fa98bfd 新功能；影子库无价格表故为 null） |
| `/objects` | DIFF（可归因） | `generatedAt` 毫秒级 epoch 相差 2ms（易变字段，语义一致） |
| `/remediation` | DIFF（可归因） | 自愈剧本对象结构化升级（`target`/`steps`/`successSummary`，注册表化重构的一部分） |

**意外回归：0**。

## 写入路径（同一平台探针 token、同一 4-key 故障报文分别 POST）

| 表 | 影子A（旧） | 影子B（新） | 结论 |
| --- | --- | --- | --- |
| `studio_external_probe_status` | 4 行 | 4 行 | **IDENTICAL** |
| `studio_alert_incidents`（30 分钟内更新） | 2 行 | 2 行 | **IDENTICAL**（注入故障 → open critical，两侧行一致） |
| `studio_alert_checks`（external%） | 4 行 | 4 行 | **IDENTICAL**（含 enabled/unhealthy/active/streak 全字段） |

## 结论

新 release 在共享面上与旧版本行为一致；全部差异可归因为（a）密码学随机性、（b）活统计漂移、（c）本次发布引入的有意功能面（成本归因、剧本结构化、DB 面板默认白名单——白名单属安全收紧，未列入对账面）。满足 D-010 Phase 3 的双跑一致性证据要求（读路径 + 写路径）。

**范围声明**：本次为同日相邻版本的双跑（改动密度高于常规发布）；告警 worker 的评估循环未纳入双跑（影子实例未启动 worker，避免通知外发），worker 状态机一致性由既有单元/回归测试覆盖。

## 复现

影子库由 `ops/backup/` 的最新 dump 克隆；对账脚本（读路径 diff、写入 diff）见本文方法描述，行号区间与版本绑定，复现时需按当版本重排。
