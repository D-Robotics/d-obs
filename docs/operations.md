# d-obs 运维手册

README 之外的深入参考：API 清单、鉴权细节、告警规则语义、行动环生命周期、
模型池操作、故障排查。

## 1. HTTP API 清单

全部挂载在 `server/main.ts`，数据端点都在 `/api/ops/observability/` 下。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/ops-observability` | 工作台 HTML（可直接打开，数据请求才鉴权） |
| GET | `/session-trace` | 会话 Trace 独立页 |
| GET | `/api/ops/observability/access` | 当前请求是否运营 admin（探活/自检） |
| GET | `/api/ops/observability/overview?hours=24` | 总览：检查、事故、告警状态、行动队列 |
| GET | `/api/ops/observability/config` | 告警配置（definitions + rules + 通道） |
| POST | `/api/ops/observability/run-checks` | 立即评估一轮（不等 60s 周期） |
| POST | `/api/ops/observability/test-notification` | 测试通知模板真实投递 |
| GET | `/api/ops/observability/events/:eventId` | 单事件详情（上下文/关联 run） |
| GET | `/api/ops/observability/incidents/:key/actions` | 事故行动队列 |
| GET | `/api/ops/observability/database?hours=24` | PostgreSQL 运行状态与资产 |
| GET | `/api/ops/observability/database/tables/:tableName` | 表分页预览 / CSV 导出 |
| GET | `/api/ops/observability/objects?limit=200` | 告警对象注册表 |
| GET | `/api/ops/observability/operator-metrics?days=30` | 运营指标（按天） |
| GET | `/api/ops/observability/learning?days=30` | Skill 数据闭环投影 |
| GET | `/api/ops/observability/model-pool` | 模型池状态（目标健康 + 路由映射） |
| POST | `/api/ops/observability/model-pool/probe` | 单目标真实探测 |
| PUT | `/api/ops/observability/model-pool/routing` | 调整 fallback 顺序 / 权重 |
| PUT | `/api/ops/observability/model-pool/replace` | 替换上游目标（需 confirm:REPLACE） |
| POST | `/api/health/external-probe-report` | 外部探针数据回传（独立 token：`x-rdk-external-probe-token` 头，64-hex 文件） |
| GET/POST | `/api/ops/observability/actions/*` | 证据化行动环（提案/审批/执行/验收） |
| POST | `/api/ops/observability/remediation` | 自愈（10 返回 action_proposal_required 引导走行动环） |

**写端点统一约定**：`x-admin-token` + `x-rdk-ops-action: observability` 双头。
`remediate`（直连自愈）与 `run-evolution`（直触进化）已退役为 410 fail-closed，
必须走行动环。

## 2. 告警规则语义

三类监控：

- **metric**：中心库聚合（AI run 退化率、token 预算、API 5xx、SLO 燃烧率等）
- **log**：Nginx access.log / PostgreSQL 错误日志的采样观察
- **probe**：真实业务链路拨测（登录→`/api/sso/me` 等）与外部拨测（异地 TLS/入口）

状态机：`healthy → observing(Pending × openAfter) → warning/critical → resolved(× resolveAfter)`。
阈值、窗口、样本下限、每规则的独立通知通道都在工作台“告警策略”里编辑，
保存写回 `config.json`（`/var/lib/rdstudio-alert-worker/config.json`，0600 权限）并
记录配置审计。

**影子模式**：`notification.shadowMode=true` 时只评估和记录、不真实投递——
新环境接入建议先影子跑 24h。

## 3. 行动环（所有变更的安全路径）

任何会改生产状态的写操作（自愈剧本、模型池路由变更、目标替换）都走：

```
提案（proposal，绑证据）
  → 服务器签发 evidence-proof（短时效 HMAC，防重放）
  → 另一名 admin 审批（双人控制）
  → 白名单剧本执行（如 reload-nginx 前先 nginx -t 校验）
  → 后置验证（失败自动入回归集）
  → 验收（accept）/标记回归（mark-regression）
```

单人环境也保持该流程——审批可以同一 token 完成，但审计链完整。

## 4. 模型池操作

前置：模型网关 admin API 可达（`RDK_GATEWAY_ADMIN_URL`，默认同机 3100）。

- **看**：目标列表 = label / model / baseUrl / Key 指纹（脱敏）/ 状态
  （healthy/half_open/cooldown/degraded）/ 成功率 / P95 / 并发 / 角色。
- **探测**：对单目标发一次真实调用，成功会刷状态与延迟统计。
- **调路由**：选一个 frontend 映射，填 fallback 顺序（逗号分隔、不可重复）和权重。
  **Agent 主路由受保护**，界面上不可选，避免预算保护被覆盖。
- **替换目标**：完整 HTTPS baseUrl + 上游模型名 + 新 Key（仅本次提交，不落盘明文），
  `confirm:'REPLACE'`；写入网关后需要手动“探测”验证。

所有写操作都有运营审计（谁、何时、改了什么）。

## 5. 故障排查

| 症状 | 检查 |
| --- | --- |
| 工作台一直“正在读取…” | API 403 → 检查 `RDK_CREDITS_ADMIN_TOKEN` 是否配了、浏览器是否带 token；503 → 数据库连不上 |
| `model_pool_unavailable` | 网关 admin API 不可达：`curl $RDK_GATEWAY_ADMIN_URL/admin/health` |
| 告警不触发 | worker 进程在跑吗（`npm run worker`）；`npm run worker:check-config`；是否处于影子模式 |
| 通知没发出 | 工作台→通知模板：webhook 配置、降噪窗口、恢复通知设置；`test-notification` 实测 |
| Agent Trace 面板提示未配置 | `STUDIO_LANGFUSE_PUBLIC_DASHBOARD_URL` 未设置或看板未设 Public |
| 表预览/AI 查询失败 | `RDK_CHAT_CREDITS_DB_URL` 指向的库里没有 `ops_ai` 脱敏视图（上游迁移未跑） |
| 探针上报 401 | token 文件不是 64-hex，或 d-obs 的 `RDK_EXTERNAL_PROBE_TOKEN_PATH` 与探针侧 `RDK_RL_PROBE_TOKEN_FILE` 不一致 |
| 探针上报 503 | `studio_external_probe_status`/`studio_alert_checks`/`studio_alert_incidents` 建表失败：重跑 `tools/init-schema.sql`（幂等） |
| 自愈面板 500 `remediation_schema_unavailable` | `studio_remediation_runs` 缺失：`init-schema.sql` 已含同源 DDL（含 RLS 与 environment check），重跑即可 |
| 行动队列显示“当前账号没有运营配置权限” | 预期行为：行动域要求 SSO 账号身份，admin-token 直连（`?ops-token=`）下模块级降级，其余面板不受影响 |
| 总览 external 检查变 critical“心跳未上报” | 探针超过 3 分钟没有上报（timer 停了或 `RDK_RL_PROBE_TARGET` 指向变了）；重新上报即恢复 |
| worker 开了告警但 `studio_alert_incidents` 空表 | 事故表缺 `acknowledged_at`/`silence_until` 等列，upsert 失败被静默吞掉：重跑 `init-schema.sql`（幂等补列） |

## 6. 数据与 schema

d-obs 不自带独立迁移工具；数据表（`studio_alert_*`、`studio_ops_events`、
`agent_run_records`、`studio_observability_actions` 等）由代码启动时幂等建表 +
上游迁移提供。与主站共用一个中心库时，d-obs 只读写自己域内的表，不碰业务表
（唯一例外是 `ops_ai` 脱敏视图与只读的运营指标聚合）。
