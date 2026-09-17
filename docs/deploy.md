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

推荐用脚本（`ops/deploy.sh`）——它把下面手工步骤里出过事故的地方都做成了闸门：

```bash
ops/deploy.sh --tag tenant-id-ux            # 用当前 HEAD 发布
ops/deploy.sh --tag tenant-id-ux --dry-run  # 只在本机构建打包，打印远端步骤
```

闸门与行为：

- **脏工作区直接拒发**（产物必须能对应到 commit，否则「线上 == HEAD」无法证明；
  确实要发未提交代码时用 `--allow-dirty`，但线上就不可溯源了）；
- 包内必须存在 `./server/main.js` 与 `./package.json` 才允许上传；
- 上传后在服务器核对 **sha256** 才解压（防上传截断/中间设备改写）；
- **依赖不上传**：服务器 `cp -al` 硬链上一版 `node_modules`（180MB → 秒级；硬链而非软链，
  所以删旧 release 不会把新 release 的依赖一起删掉）。`package.json` 变了则拒绝复用，
  要求本地装好依赖后用 `--with-deps` 重发；
- 切软链后健康检查（`systemctl is-active` + 本机 `/ops-observability` 200）不过就
  **自动回滚**到上一版并打印 journal。

### 手工步骤（脚本不可用时的兜底）

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

注意 `tar --czf` 是错的（少一个横杠，命令直接失败），配合 `2>/dev/null` 会静默失败并把
上一轮的旧包传上去——手工发时不要吞 stderr，且传完先确认包内有 `server/main.js`。

## release 清理

每次发布会新增一个 release，其中 `node_modules`（约 182MB）在脚本发布时是**硬链**自
上一版，所以 `du` 看到的体积会明显大于实际新增占用。`d-obs.service` 只通过 `current`
软链启动，因此**除 current 之外都可安全删除**（硬链不会因删旧 release 而断链），
建议保留 current + 上一个作为回滚点：

```bash
cd /opt/d-obs/releases && ls -1t | tail -n +3 | xargs -r rm -rf
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

**生产已收紧（2026-09-16）**：`/etc/d-obs.env` 里的 `RDK_DB_PANEL_TABLES` 设为本服务
运行时真正读写的 32 张表，因此面板不再能看到共用中心库里主站的商业/凭据表
（`credit_user_key`、`credit_account`、`chat_credit_accounts`、`redemption_code`、
`product_events` 等）。实测：这些表在目录里不出现，按表名直连详情与 CSV 导出均 404，
而本服务要用的表（如 `conversation_turns`、`studio_alert_incidents`）仍为 200。

**名单已纳入仓库**：`ops/db-panel-allowlist.txt`（含生成说明）。`server/monitoring/postgres-dashboard-allowlist.test.ts`
会重算运行时可达表集合、断言全部在名单里 —— 代码新增表读写而没同步名单时会直接测试失败。

名单的生成方式（改代码后重新推导，别靠手写）：从入口做一次可达性遍历（**含动态
`import()`**——租户 store 就是动态导入的），收集可达模块里所有
`from|into|update|join public.<table>` 的表名。宁可宽一点：漏一张会让面板功能坏掉，
多一张只是多暴露一张本服务确实会读的表。放宽或收窄都只改 `/etc/d-obs.env` 这一行后
`systemctl restart d-obs`，并保留 `RDK_DB_PANEL_TABLES` 为空即可恢复「全部可见」的旧行为。

## 告警配置的归属（2026-09-17 已切给 d-obs）

**线上真正生效的告警配置只有一份**，d-obs 与主站 worker 现在共用它：

| 谁 | 配置文件 | 状态 |
| --- | --- | --- |
| 主站 worker（`rdstudio-alert-worker.timer`，每分钟跑，**线上唯一在跑的告警评估**） | `/var/lib/rdstudio-alert-worker/config.json` | 26 条规则、通知已启用、影子模式**关闭**、渠道 feishu |
| d-obs | 同一个文件（`/etc/d-obs.env` 里的 `RDK_ALERT_CONFIG_PATH` 覆盖已注释掉，走默认路径） | 面板显示的就是线上真实配置 |

也就是说：**在 d-obs 面板里改的阈值现在会真的生效**（下一次 worker 评估时）。切换前
必须先解决的两个 schema 差异都已修掉：

1. ✅ 文件里 d-obs 不认识的规则键（`l4-shadow-ready-to-observe`、`l4-canary-ready-for-approval`）
   与其旧键（`moss-model-target-degraded`，现名 `agent-model-target-degraded`）不再被搬动或丢弃：
   未知键原样留档并在整份写出时写回；旧键的改动**写到旧键上**（worker 读的是旧键，
   写新键等于没改）。面板会如实列出「其它系统管理的规则」。
2. ✅ 保存不再把 d-obs 的默认值物化进文件：写盘以**磁盘原文**为基准做最小改动
   （`planAlertConfigWrite`）。原样保存 → `changed=false`，文件一个字节都不动、连备份都不产生；
   改一条规则 → 只写那一条。schema 也改成「校验时滤掉未知字段」而不是 strict 拒绝，
   否则文件里任何别的系统写的字段都会让整份配置退回默认值、面板显示的就不是线上配置。

### 真机验证（对线上那份 26 条规则的配置）

- 面板读到的是线上配置而非默认值：通知 `enabled=true`、`shadowMode=false`、feishu 已配置；
- 4 条 `north-star-*` 规则当时不在文件里。**注意：「不在文件里」不等于「线上未评估」**——worker 会把自己的内置默认值合并进来一并评估，实测这 4 条的生效阈值与 d-obs 默认值逐项相同，当时它们已在评估并有 2 条处于 critical 事故中（见下）。现已把这 4 条写入文件固定（2026-09-17），面板与线上不再存在「显示值 ≠ 生效值」的歧义；
- 原样保存干跑：`changed=false`；
- 停用一条规则：规则总数 26 → 26（无物化、无丢失），两条外部规则与旧键仍在。

### 回滚

恢复 `/etc/d-obs.env` 里 `RDK_ALERT_CONFIG_PATH=/var/lib/d-obs/alert-config.json`（备份在
`/etc/d-obs.env.bak-*`）后 `systemctl restart d-obs`，面板即回到「只看自己的空文件」状态；
线上告警始终由主站 worker 读那份文件，不受影响。每次覆写前都会留时间戳备份
（`config.json.bak-<UTC 毫秒>`，保留最近 5 份）。

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
- 页面内跳转用相对路径（`./ops-observability`）。

## 并存说明

同机还有一条 9 月 11 日上线的 `@rdk-studio/observability`（`/rdkstudio/observability/`
前缀、SSO 登录、`rdk-observability.service`）。两者共用中心库的
`studio_alert_incidents` 表但服务独立、互不干扰。合流或下线旧线另行决策。
