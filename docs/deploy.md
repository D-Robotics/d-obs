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

## 验证清单

1. 本机 health：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18093/ops-observability` = 200
2. 公网页面：`https://rdkstudio.d-robotics.cc/dobs/ops-observability` 200，标题「d-obs · 生产可观测与告警」
3. 公网 API（带运营令牌）：`/dobs/api/ops/observability/overview` 返回 ok
4. 未授权：不带令牌 overview 403；`POST /api/ops/tenants/register` 无 token 503（fail-closed）
5. `journalctl -u d-obs -p err` 无新条目
6. 浏览器：登录表单可用，错误令牌就地报错；进入后事故徽章数与库中
   `studio_alert_incidents` 进行中条数一致

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
