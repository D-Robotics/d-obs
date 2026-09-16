# d-obs 生产部署

记录 2026-09-15 首次上线的实际布局与流程。凭据一律不入仓：SSH 走维护者
keychain（`security find-generic-password -s codex-rdk-device-47.110.142.255 -a root`），
DB URL 与运营令牌从服务器上 studio 的 `/etc/rdstudio-web.env` 读取。

## 服务器布局（与 studio 同机）

| 东西         | 位置                                                      |
| ------------ | --------------------------------------------------------- |
| App 根       | `/opt/d-obs/releases/<release-id>/`，`current` 软链切换   |
| systemd 服务 | `d-obs.service`（node 直接跑 `current/server/main.js`）   |
| 监听端口     | 127.0.0.1:18093（服务器 18xxx 惯例内的空闲位）            |
| 公网入口     | `https://rdkstudio.d-robotics.cc/dobs/`（nginx 前缀代理） |
| env 文件     | `/etc/d-obs.env`（0600，root）                            |
| 告警状态     | `/var/lib/d-obs/alert-config.json`、`alert-state.json`    |
| 数据         | 生产中心库（studio 同库），`studio_alert_incidents` 等表  |

服务器到 npm registry 不通，**不要在服务器上 `npm install`**——本地装好
依赖整树打包上传。

## 发布流程

```bash
npm run build:clean                      # tsc 产物到 dist/
mkdir /tmp/d-obs-rel && cp -R dist/server dist/shared /tmp/d-obs-rel/
cp package.json /tmp/d-obs-rel/
cp -R node_modules /tmp/d-obs-rel/       # 本地已装好的干净依赖
find /tmp/d-obs-rel -name '*.d.ts' -delete
COPYFILE_DISABLE=1 tar --exclude=.DSStore -czf /tmp/d-obs-rel.tgz -C /tmp/d-obs-rel .

# 上传 → 新 release 目录 → 切软链 → 重启 → 验证
scp /tmp/d-obs-rel.tgz root@47.110.142.255:/opt/d-obs/releases/
ssh root@47.110.142.255 'cd /opt/d-obs/releases && mkdir <release-id> \
  && tar -xzf d-obs-rel.tgz -C <release-id> && rm d-obs-rel.tgz \
  && cd /opt/d-obs && ln -sfn releases/<release-id> current \
  && systemctl restart d-obs && sleep 3 && systemctl is-active d-obs'
```

## 团队接入

线上项目以租户身份接入拨测监控，流程见 [`tenant-onboarding.md`](./tenant-onboarding.md)；
探针 unit 文件在 `ops/probes/`（`tenant-probe@.service` / `tenant-probe@.timer`），
env 文件在服务器 `/etc/d-obs/probes/<project>.env`。

## 验证清单

1. 本机 health：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18093/ops-observability` = 200
2. 公网页面：`https://rdkstudio.d-robotics.cc/dobs/ops-observability` 200，标题「d-obs · 生产可观测与告警」
3. 公网 API（带运营令牌）：`/dobs/api/ops/observability/overview` 返回 ok
4. 未授权：不带令牌 overview 403；`POST /api/ops/tenants/register` 无 token 503（fail-closed）
5. `journalctl -u d-obs -p err` 无新条目
6. 浏览器：登录表单可用，错误令牌就地报错；进入后事故徽章数与库中
   `studio_alert_incidents` 进行中条数一致
7. **免登**：先在业务站（`https://rdkstudio.d-robotics.cc`）登录，再打开
   `/dobs/ops-observability`，应当**直接进入**工作台而不再要求输密码；
   `curl -s -H "Cookie: rdk_sso_session=<sid>" http://127.0.0.1:18093/api/ops/auth/me`
   应返回该账号（无 Cookie 时返回 `user:null`）。
8. **真实客户端 IP**：确认 `RDK_TRUST_PROXY` 未关闭（默认 `loopback`），
   然后从两个不同出口 IP 各失败登录一次并观察限流计数互不影响——若发现
   `journalctl` 里所有请求都记成 127.0.0.1，说明 nginx 没传
   `X-Forwarded-For`（检查 `proxy_set_header` 是否仍在）。

## 数据库面板的表范围（可选收紧）

`/api/ops/observability/database*` 是运营只读取证面：凭据/密钥类列按名字启发式
隐藏（含 CSV 导出），但**表级默认不设限**——而 d-obs 与业务站共用中心库，所以
admin token ≈ 对该库整库只读。需要收紧时在 `/etc/d-obs.env` 配白名单：

```
# 只允许看可观测相关表（裸表名默认 public schema）
RDK_DB_PANEL_TABLES=studio_alert_incidents,studio_alert_checks,studio_ops_events,studio_obs_tenants
```

配置后目录列表、关系图、表详情、整表 CSV 四个面一致收敛；白名单外的表按
「不存在」（404）返回，不确认其是否存在。不配置 = 保持现状（全部可见）。

## 反代与客户端地址

`app.set('trust proxy', …)` 默认取 `loopback`（见 `server/trusted-proxy.ts`）：
只有当直连对端是回环地址时才采信 `X-Forwarded-For`。生产 nginx 与本服务同机，
因此登录限流能按真实客户端 IP 分桶；若进程被意外暴露到公网，外部伪造的 XFF
不会被采信。反代换到别的机器时用 `RDK_TRUST_PROXY=<该机器 IP/CIDR>` 显式声明。


## nginx 前缀（已上线，改动前备份 rdkstudio-ssl.conf）

```nginx
location = /dobs { return 301 /dobs/; }
location /dobs/ {
    proxy_pass http://127.0.0.1:18093/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
    proxy_read_timeout 5m;
    client_max_body_size 2m;
    add_header Cache-Control "no-store" always;
}
```

前缀兼容性依赖两点，改代码时不能破坏：

- 客户端 API base 从 `location.pathname` 剥离 `/ops-observability` 推导（前缀自适应）；
- 页面内跳转用相对路径（`./ops-observability`、`./session-trace`）。

## 并存说明

同机还有一条 9 月 11 日上线的 `@rdk-studio/observability`（`/rdkstudio/observability/`
前缀、SSO 登录、`rdk-observability.service`）。两者共用中心库的
`studio_alert_incidents` 表但服务独立、互不干扰。合流或下线旧线另行决策。
