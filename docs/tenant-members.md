# 租户组员与账号登录

d-obs 的租户升级为多账号协作单元：组员用**主站 SSO 账号密码**登录可观测
工作台，按租户获得隔离视图。d-obs 不复制主站鉴权（D-010：鉴权不复制），
主站 `rdstudio-web` 是唯一认证权威。

## 数据模型（中心库 `RDK_CHAT_CREDITS_DB_URL`）

```sql
create table if not exists public.studio_obs_tenant_members (
  tenant_id   text not null,
  sso_user_id text not null,          -- 主站账号 ID
  display_name text not null default '',
  role        text not null default 'member' check (role in ('owner','member')),
  added_by    text not null default '',
  created_at  timestamptz not null default now(),
  primary key (tenant_id, sso_user_id)
);
```

schema 由服务进程幂等自建（启动后首次访问自动创建，无需手工执行 SQL）。
一个账号可加入多个租户；租户内分 owner / member 两级。

## 登录与会话

### 会话候选链（与主站同序）

每次请求按下面的顺序解析会话，取第一个能通过主站校验的（对应主站
`getSessionIdCandidatesFromRequest` + `pickBestSessionId` 的语义）：

1. `x-rdk-sso-session` 请求头（工作台账号登录后写入 sessionStorage）；
2. `rdk_sso_session` Cookie —— **免登通道**：主站会话 Cookie 是
   `Path=/; HttpOnly`，浏览器会把 `/dobs/*` 的请求一并带上；
3. 云镜像懒恢复：`x-rdk-sso-session-cloud` 头（桌面/嵌入式形态本地 Cookie
   带不到时用）；主站用中央会话重建本地会话并回显**新的** `sessionId`。

因此**用户在业务站登录过，打开 `/dobs/` 不需要再输一次密码**。请求头里出现
多个逗号分隔的会话值时视为语义不明（典型成因是两个大小写不同的头被 fetch
合并成一个值），此时忽略该头并退回 Cookie 通道，而不是猜一个——猜错会把 A 的
主站会话当成 B 的 d-obs 登录态。

### 端点

- `POST /api/ops/auth/login {userName, password}` → 服务端转发主站
  `POST /api/sso/direct/login`（`RDK_SSO_RELAY_BASE_URL`，生产
  `http://127.0.0.1:18090`），返回主站会话 `sessionId`；并把主站下发的
  `Set-Cookie`（白名单：`rdk_sso_session` / `rdk_sso_web_session`）**透传给
  浏览器**，使这次登录同时成为主站登录态（免登闭环），也让 iframe、整表导出
  这类没有自定义头的请求重新带上凭证。**登录中继本身不需要 `SSO_DIRECT_AES_KEY`**
  （凭据只在回环上转发给主站，AES 由主站处理）；但该密钥在 d-obs 里另有兜底用途：
  未配置 `RDK_SYNTHETIC_PROBE_HMAC_SECRET` 时它被当作合成探针签名密钥，故并非
  「完全不接触」。建议显式配置专用密钥，避免复用主站密钥（见 README「密钥与兜底链」）。
- 会话校验：服务端 `GET /api/sso/me` 验证（要求 `payload.user.id` 非空；本地
  会话必须 `sessionId` 回显一致，云镜像恢复路径接受回显的新会话 id），结果
  缓存 60s（正负都缓存）。转发时只带 SSO 白名单内的 Cookie，不顺带外发同源
  其它 Cookie。上游 `ssoCredentialLimiter`（20 次/15 分钟/IP）按 127.0.0.1
  共享桶计数，全 d-obs 复用同一配额。
- 登录端点另有进程内限流，**两个维度**都要在额度内：
  - 按客户端地址（`RDK_SSO_RELAY_LOGIN_RATE_MAX`，默认 20 次/15 分钟）挡撞库喷洒；
  - 按目标账号（`RDK_SSO_RELAY_LOGIN_ACCOUNT_RATE_MAX`，默认 10 次/15 分钟）挡
    针对单账号的爆破，攻击者换 IP 也仍然受限，且不会连坐其它账号。
  地址维度依赖 `app.set('trust proxy', …)` 解析真实客户端 IP：默认值 `loopback`
  表示「只在直连对端是回环时才采信 X-Forwarded-For」，匹配同机 nginx 反代，
  同时避免进程意外暴露到公网时被伪造 XFF 绕过。可用 `RDK_TRUST_PROXY` 显式关闭
  （`0`/`off`）或指定 CIDR 列表。
  - 上游主站的 `ssoCredentialLimiter`（20 次/15 分钟）按 `req.ip` 计数，而 d-obs
    的全部中继登录都来自 127.0.0.1：d-ops 会把真实客户端地址用 `X-Forwarded-For`
    / `X-Real-IP` 转发过去，**前提是主站设了 `EXPRESS_TRUST_PROXY=1`**，此时主站也
    按真实来源分桶；主站未设该变量时这两个头被忽略，额度仍为平台级共享（行为与
    之前一致）。429 会原样透传为 `login_rate_limited`。
- `POST /api/ops/auth/logout`：按候选链逐个清本地缓存 + 尽力吊销主站会话
  （一并带 Cookie 通道，让主站围栏它看到的全部候选）；失败不影响本地登出。
  工作台登录时写入的运营令牌/租户 token 也在此一并清除。
- `GET /api/ops/auth/me`：返回 `{user, tenants:[{tenantId,displayName,role}], admin, relayConfigured}`。
- **未配置 `RDK_SSO_RELAY_BASE_URL` 时登录端点 503 fail-closed**；
  现有 admin token / 探针 token 入口完全不受影响（向后兼容）。

## 权限矩阵

| 能力 | 平台管理员 | 租户 owner | 租户 member | 探针 token |
| --- | --- | --- | --- | --- |
| 全局视图/全部面板 | ✅ | ❌ | ❌ | ❌ |
| 本租户只读 overview | ✅（`?tenant=`） | ✅ | ✅ | ✅ |
| 查看/管理本租户组员 | ✅ | ✅ | 只读名单 | ❌ |
| 轮换本租户探针 token | ✅ | ✅ | ❌ | ❌ |
| 创建/停用租户、告警配置、事故操作 | ✅ | ❌ | ❌ | ❌ |

优先级：admin token > SSO allowlist 管理员（`RDK_FLYWHEEL_ADMIN_USER_IDS`）
> SSO 组员（`x-rdk-obs-tenant` 头作用域）> 租户探针 token。

防锁死：租户最后一个 owner 不可降级（`last_owner_role_required`）、不可移除
（`last_owner_required`）。判定在 store 层的**每租户成员变更临界区**内完成
（`withTenantMutationLock`）——「先数 owner 再写」的朴素实现有竞态：两个并发
请求可以各自读到 owners=2，然后双双降级/移除最后一个 owner，把租户彻底锁死。
d-obs 是单进程写入者，进程内串行队列即可消除该窗口；若将来出现多进程写入，
需改为数据库事务 + `select … for update`。

租户凭证（`x-tenant-token`）出现在**非租户面**路由上会被显式拒绝
（403 `tenant_scope_only`：「该凭证只在租户面有效」），不允许退化成管理员/匿名
访问；凭证本身失效是 gate 的 401 `invalid_tenant_token`。两者语义不同，前端据此
区分「权限被改动」（提示 + 重查身份）与「模块级收敛」（静默降级）。

## 组员管理 API（工作台租户面板同一套）

```bash
# 列出组员（admin / 本租户 owner / 本租户 member 只读）
curl http://127.0.0.1:18093/api/ops/observability/tenants/<tenantId>/members \
  -H 'x-rdk-sso-session: <sid>' -H 'x-rdk-obs-tenant: <tenantId>'

# 添加组员（admin 或本租户 owner）
curl -X POST .../tenants/<tenantId>/members \
  -H 'x-rdk-sso-session: <sid>' -H 'x-rdk-obs-tenant: <tenantId>' \
  -H 'x-rdk-ops-action: observability' \
  -d '{"ssoUserId":"<账号ID>","displayName":"可选","role":"member|owner"}'

# 改角色 / 移除
POST   .../tenants/<tenantId>/members/<ssoUserId>/role  {"role":"member"}
DELETE .../tenants/<tenantId>/members/<ssoUserId>
```

成员变更全部写 `studio_alert_configuration_audit` 审计。

## 验证状态（2026-09-17）

已对**生产库**实测的：成员存储层的增删查与计数（`addMember` / `findMembership` /
`listMembershipsForUser` / `listMembers` / `countOwners` / `countMembersByTenant` /
`removeMember`）——用一个本身已是平台管理员的账号做临时成员（不新增任何权限），
流程跑完即删，事后全表 0 残留。同时实测：租户凭证读租户面 200、打平台面 403
`tenant_scope_only`、伪造 token 401 `invalid_tenant_token`、无跨租户泄漏。

**组员视图已真机验证（2026-09-17，用 canary 账号，非管理员）**

canary 账号（`synthetic.username`，不在 `RDK_FLYWHEEL_ADMIN_USER_IDS` 里）是现成的
**真实非管理员账号**，用它走主站直登中继拿到真实会话后，组员链路逐项跑通：

| 验证点 | 结果 |
| --- | --- |
| `/api/ops/auth/me`（带会话） | 200，`admin=false`，`tenants` 列出组员租户与角色 |
| 组员带 `x-rdk-obs-tenant` 读本租户 overview | 200，`tenantScope` = 该租户 |
| 组员读**真实租户**（sim2real） | 200，返回该租户自己的 `t.sim2real.external-*` 检查 |
| 非管理员不带租户头 | 403 `not_authorized` |
| 组员访问没加入的租户 | 403 `not_a_member`（fail-closed） |
| 组员打平台专属面（`/tenants`） | 403（模块级拒绝） |

验证用的成员行与一次性租户**已全部删除**（成员表复查 0 行、无 e2e 残留），
canary 三项拨测复跑仍全过，说明这次验证没有影响线上告警。

一个已知的措辞细节：组员路径下**租户被停用**时返回的是 403 `not_a_member`
（因为成员查询按「活跃租户」联表，停用后查不到成员关系），而不是 `tenant_disabled`
——两者都是 fail-closed 的 403，只是对「被停用」这种情况提示不够精确；`tenant_disabled`
目前只在租户 token 路径出现。要让提示更准确，需要成员查询区分「无成员关系」与
「有成员关系但租户停用」。

## 工作台使用

1. **已在业务站登录的用户直接打开 `/ops-observability` 即可**（同源 Cookie
   免登）：页面会先问 `/api/ops/auth/me`，拿到身份后自动选中第一个租户并进入
   组员视图。未登录时登录屏输入**主站账号密码**（管理员可继续用运营令牌直连）。
2. 登录后顶栏出现账号 chip + 租户切换器 + 退出按钮；组员视图只含
   “当前态势”（本租户只读，含检查状态、事故与**本租户上报的最近事件**）与
   “租户”（owner 管组员）。事件面板只读 `studio_ops_events_tenant` 且按服务端
   解析出的租户过滤，看不到平台事件也看不到别家事件。
3. 未加入任何租户的账号会看到自己的**账号 ID**（可复制），发给管理员即可
   加入。v1 手工录入账号 ID；邀请链接式自助加入是后续增强。
4. 管理员在“租户管理”面板每行可展开组员管理（同套 API）。
5. 登录屏只在**确实未登录**时出现：判据是公开只读端点
   `/api/ops/observability/access`，不靠业务端点的 401/403——模块级 403
   （如行动域对 admin token 的降级）不该把已渲染的看板整页盖掉；会话中途变成
   403（如被移出租户）只提示“权限已变化”，不清空已渲染内容。
6. **owner** 在“租户”页可直接轮换本租户探针 token（面板内显示一次新 token），
   不必再找平台管理员——与权限矩阵一致。
7. **管理员**顶栏租户切换器会把概览切到该租户视角（请求带 `?tenant=`，服务端
   仅对管理员生效并校验租户存在）；切回“平台全局视图”则看全部归属。

## 部署配置（生产 47.110.142.255）

`/etc/d-obs.env` 追加：

```
RDK_SSO_RELAY_BASE_URL=http://127.0.0.1:18090
# 可选：SSO 管理员 allowlist（逗号/空白分隔的主站账号 ID）
# RDK_FLYWHEEL_ADMIN_USER_IDS=<sso_user_id>
```

> `RDK_FLYWHEEL_ADMIN_USER_IDS` 不配时，**任何纯 SSO 账号都不是管理员**：
> 行动环（证据化行动/审批/自愈）会对所有人返回 403，界面只显示「当前账号没有
> 运营配置权限」。要用 SSO 账号操作行动环，必须配这个白名单。

改完 `systemctl restart d-obs`。
