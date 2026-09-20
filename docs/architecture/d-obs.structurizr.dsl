workspace "d-obs" "RDK 可观测平台 — 当前状态架构模型（C4：系统上下文 + 容器视图）。证据见 d-obs.evidence.md" {

  model {
    opsAdmin = person "运营管理员" "平台管理员（x-admin-token 或 SSO 账号）与租户 owner，使用运营工作台管理告警/事故/租户/模型池"
    tenantMember = person "租户团队成员" "接入团队的组员，用 SSO 账号或 tenant-token 获得本租户只读视图"

    dObs = softwareSystem "d-obs" "独立可观测平台：运营工作台、告警评估与投递、链路追踪、运营指标、数据库资产、模型池控制面。自 RDK Studio 按 D-010 边界抽取，双进程共享一库" {
      web = container "Web 服务进程" "Express 单进程：SSR 工作台页面、JSON API、探针/OTLP/事件摄取、公共观测 API、状态页、遥测治理运行时、可选 OTLP/gRPC receiver、/metrics 端点（生产端口 18093）" "Node.js + Express + TypeScript"
      worker = container "告警评估 Worker" "独立进程（studio-alert-worker.ts），每 60 秒评估指标/日志/拨测规则，驱动事故状态机、升级链、维护窗口、通知投递与白名单自愈剧本；配置来自 RDK_ALERT_CONFIG_PATH 文件" "Node.js"
      db = container "中心 PostgreSQL" "数据面唯一真源：告警检查/事故/通知、租户、ops 事件、run/trace 投影、审计、保留策略。Web 与 Worker 双进程共享（d_obs 库）" "PostgreSQL"
    }

    studio = softwareSystem "RDK Studio 主站" "账号体系与 SSO 中继（生产 127.0.0.1:18090）；d-obs 转发登录与 /api/sso/me 会话验证，鉴权语义不复制"
    targets = softwareSystem "被观测业务系统" "被拨测/监控的业务站点，如强化学习平台 sim2real-web（healthz、入口页等）"
    probes = softwareSystem "外部探针" "异地拨测进程（tools/rl-platform-probe.mjs，systemd timer 驱动），自算 ok/active 后回传 DNS/TLS/健康/入口检查结果"
    aiApps = softwareSystem "AI 应用 / OTel SDK" "Phoenix、Langfuse 及其他 OTLP 兼容 SDK，上报 GenAI 语义的 trace/metrics（不含 prompt/completion/工具参数）"
    prometheus = softwareSystem "Prometheus" "以 15s 间隔抓取 d-obs 的 /metrics（OTLP 指标经抓取持久化）"
    gateway = softwareSystem "模型路由网关" "D-Robotics 模型网关：admin API 127.0.0.1:3100，网关目标 3100/3101；模型池控制面的操作对象"
    langfuse = softwareSystem "Langfuse 看板" "Agent Trace 公开看板，由工作台页面 iframe 嵌入"
    channels = softwareSystem "通知渠道" "飞书/钉钉/企微/Slack/Telegram/通用 Webhook，告警通知的外发出口"

    opsAdmin -> dObs "浏览器使用工作台与 JSON API（x-admin-token 或主站 SSO Cookie，timing-safe 比对，fail-closed）"
    tenantMember -> dObs "只读租户视图（tenant-token 一次性注入 sessionStorage；变更端点一律 403）"
    probes -> dObs "POST /api/health/external-probe-report（x-rdk-external-probe-token / x-rdk-tenant-probe-token）"
    aiApps -> dObs "OTLP/HTTP JSON、HTTP protobuf、可选 OTLP/gRPC 上报 /v1/traces /v1/metrics（可选 Bearer token）"
    prometheus -> dObs "定时抓取 GET /metrics（15s，可选 Bearer token）"
    dObs -> studio "转发账号登录与 SSO 会话验证（HTTP，回环；透传 XFF 供主站按真实来源限流）"
    dObs -> channels "投递告警/恢复通知（Webhook；含重试、降噪、影子模式、维护窗口后补发）"
    dObs -> gateway "admin API：目标健康探测、单目标真实探测、路由优先级与目标替换（HTTP，回环）"
    dObs -> targets "主动拨测与健康检查（worker 执行：internal-health、公网健康、合成探针，HMAC 签名）"
    dObs -> langfuse "工作台页面 iframe 嵌入公开看板（浏览器侧加载）"

    web -> db "SQL 读写（pg：工作台查询、摄取落库、审计、租户）"
    worker -> db "SQL 读写（pg：告警状态机、事故、通知、行动环后置验证）"
  }

  views {
    systemContext dObs "SystemContext" {
      include *
      autolayout lr
      description "d-obs 与人员、外部系统的边界"
    }

    container dObs "Containers" {
      include *
      autolayout tb
      description "d-obs 双进程 + 共享数据库；进程间不直连，只经 PostgreSQL 交换状态"
    }
  }
}
