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

- `POST /api/ops/auth/login {userName, password}` → 服务端转发主站
  `POST /api/sso/direct/login`（`RDK_SSO_RELAY_BASE_URL`，生产
  `http://127.0.0.1:18090`），返回主站会话 `sessionId`。d-obs 不接触
  `SSO_DIRECT_AES_KEY`。
- 会话校验：请求带 `x-rdk-sso-session` 头，服务端 `GET /api/sso/me`
  验证（要求 `payload.user.id` 非空且 `sessionId` 回显一致），结果缓存
  60s（正负都缓存）。上游 `ssoCredentialLimiter`（20 次/15 分钟/IP）按
  127.0.0.1 共享桶计数，全 d-obs 复用同一配额。
- 登录端点另有进程内 per-IP 限流（默认 20 次/15 分钟，
  `RDK_SSO_LOGIN_RATE_MAX` 可调）。
- `POST /api/ops/auth/logout`：尽力吊销主站会话 + 清本地缓存。
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
（`last_owner_required`）。

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

## 工作台使用

1. 打开 `/ops-observability`，登录屏输入**主站账号密码**（管理员可继续用
   运营令牌直连）。
2. 登录后顶栏出现账号 chip + 租户切换器 + 退出按钮；组员视图只含
   “当前态势”（本租户只读）与“租户”（owner 管组员）。
3. 未加入任何租户的账号会看到自己的**账号 ID**（可复制），发给管理员即可
   加入。v1 手工录入账号 ID；邀请链接式自助加入是后续增强。
4. 管理员在“租户管理”面板每行可展开组员管理（同套 API）。

## 部署配置（生产 47.110.142.255）

`/etc/d-obs.env` 追加：

```
RDK_SSO_RELAY_BASE_URL=http://127.0.0.1:18090
# 可选：SSO 管理员 allowlist（逗号/空白分隔的主站账号 ID）
# RDK_FLYWHEEL_ADMIN_USER_IDS=<sso_user_id>
```

改完 `systemctl restart d-obs`。
