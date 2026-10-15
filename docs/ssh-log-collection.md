# SSH 端侧运行日志采集

工作台入口：**边缘设备 → RDK 日志调查 → 单源 SSH 采集**，深链为
`/ops-observability#devices/logs`（部署在 `/dobs` 下时保留该前缀）。

平台后端通过 SSH 读取 X5 上已有的日志，并把采集结果保存到后端本地。
X5 无需安装采集 agent。浏览器负责选择设备、开始/停止、实时查看、关键词筛选
和下载；SSH 连接由运行 d-obs 的机器建立。
按产品与版本规划多源采集、复现和模型调查，请见 [RDK 日志调查](rdk-log-investigation.md)。

## 配置设备

在 **d-obs 后端运行账户**下确认已能以密钥非交互连接设备，并核验设备的 SSH
主机指纹，将其加入该账户的 `known_hosts`。采集器使用严格主机密钥检查，首次
未知主机或主机密钥变化会连接失败；不会绕过指纹核验。

通过 `RDK_SSH_LOG_TARGETS` 设置设备清单（JSON 数组），随后重启 d-obs。可以
使用该账户 SSH config 中已有的 Host 别名：

```json
[
  {
    "id": "lab-x5",
    "label": "实验室 X5",
    "host": "x5",
    "user": "sunrise",
    "port": 22,
    "sources": [
      { "id": "kernel", "label": "内核与驱动", "type": "kernel" },
      { "id": "system", "label": "系统日志", "type": "journal" },
      { "id": "isp-service", "label": "ISP 调试服务", "type": "unit", "unit": "isp-debug.service" },
      { "id": "isp-file", "label": "ISP 调试文件", "type": "file", "path": "/var/log/isp-debug.log" }
    ]
  }
]
```

`isp-debug.service` 和 `/var/log/isp-debug.log` 是示例，请换成设备上的实际名称。
省略 `sources` 时提供内核与系统日志，平台另提供固定 logcat/dmesg 来源，
RDK 调查模板会先验证命令和权限再推荐。`identityFile` 可选，指定后端上私钥
文件的绝对路径；省略时沿用后端 SSH 配置。私钥内容、身份文件路径和设备
连接参数不会随设备清单返回浏览器。

设备需提供 `journalctl`、`tail` 和 GNU coreutils 的 `timeout`（X5 Ubuntu 系统
通常已提供）。远程读取命令也有时长上限，平台断开后会在该上限内退出。
SSH 用户需要具备对应日志的读取权限。采集器不自动提权，不修改驱动日志级别，
不启动 ISP 程序。临时程序的 stdout/stderr 应先保存到文件或交给 systemd，
再配置对应来源；无法事后恢复没有保存的终端输出。

## 网络和登录

后端必须能访问设备 SSH 端口。在本机或局域网部署 d-obs 时可以直接访问 X5；
云端部署时，需要已有的 VPN、内网连接或 SSH 可达路径。浏览器所在电脑能访问
设备，并不代表云端后端也能访问设备。

此入口使用现有运营管理员权限。独立本地部署可设置 `RDK_CREDITS_ADMIN_TOKEN`，
在工作台登录界面使用运营令牌；SSO 部署沿用管理员白名单。租户只读凭证不能
采集或读取原始设备日志。SSO 采集记录按账号隔离；使用同一运营令牌的调用者
共享同一个采集身份。

## 保存和边界

`RDK_SSH_LOG_STATE_DIR` 可指定后端持久目录，默认
`~/.local/state/d-obs/ssh-logs`，应挂载持久磁盘且仅服务账户可读。
原始日志单独保存，不经过 OTLP 的摘要截断或上传到其他服务。

默认读取最近 200 行并持续跟随 5 分钟；最长 30 分钟，同时最多 4 路。
单次原文最多 10 MiB，采集目录总预算 50 MiB（包含记录和元数据）。每次采集有时长、并发和磁盘上限，
到达上限会停止并显示原因；不会静默丢掉旧记录。已结束的采集保存 24 小时，
期间可再次查看或导出。后端重启会保留已经保存的输出，将未结束的采集标为
失败，并显示重启中断原因；需要重新开始 SSH 跟随。

网络中断后该次采集会结束，页面保留已有输出和错误信息。重新采集会再次读取
所选来源的最近日志；当前版本不承诺跨断线无缝续接，也不能恢复设备已经清理的
日志。网页显示窗口有单独上限，导出包括后端保留的整个采集结果。

## 原子 API

接口契约：`rdk.ssh-logs.v1`。前缀为 `/api/ops/observability/ssh-logs`：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/targets` | 可选择的设备与日志来源，连接凭据脱敏 |
| GET | `/sessions` | 当前身份的采集记录 |
| POST | `/sessions` | 开始采集，参数 `targetId`、`sourceId`、`lines`、`durationSeconds`、`follow` |
| GET | `/sessions/:id?after=0&limit=500` | 按游标增量读取，返回记录、下一游标、`hasMore` 和采集状态 |
| POST | `/sessions/:id/stop` | 停止采集并保存尾部输出 |
| GET | `/sessions/:id/export` | 下载保留的原始输出 |

令牌调用使用 `x-admin-token`。POST 还需 `x-rdk-ops-action: observability`，
浏览器调用沿用同源校验。`record.text` 包含原有换行，一个记录可能含多行，
消费端直接连接文本即可。`stream` 区分 SSH 标准输出与错误输出。

此 API 仅接受服务端已配置的来源标识，不提供浏览器传入任意远程命令的入口。
