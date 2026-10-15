---
name: d-obs-rsi-validation
description: 扩展或验收 d-obs 的可验证进化实验、工具失败证据采集和版本继承闭环。用于“继续完善进化实验”“验证两轮继承”“真实失败案例接入”“RSI replay / admission / rollback”；生产发布另用 d-obs-release。
---

# d-obs 可验证进化闭环

从仓库根目录工作。先读 [模块说明](../../../docs/rsi-learning.md)，按任务只读取相关实现；证据收集、回放和运行时应用是三个不同边界。

## 找到改动位置

- `server/evolution/rsi-replay.ts`：有限规则解释器、adaptive-only 提案、同预算回放和准入门禁。
- `server/evolution/rsi-ledger.ts`：冻结案例、规则版本、回放绑定、接受与祖先回退。
- `server/evolution/rsi-failure-inbox.ts`：账号证据收集箱、人工标签、修订号和绑定。
- `server/monitoring/rsi-failure-observer.ts`：平台工具执行回执的后台观察。
- `server/monitoring/platform-operations.ts`：`finish` 集中接入点，助手/MCP/插件共享。
- `server/monitoring/rsi-*-routes.ts`、`rsi-learning-operations.ts`：权限、同源写入与全局工具目录。
- `server/monitoring/rsi-*-page.ts`：页面操作、账号切换和轮询状态。

## 保持可验证的闭环

1. 冻结独立人工确认的案例和来源。预测/建议不能自动成为标签；确认后标签和分组保持固定。相同归因输入不能跨 frozen/adaptive/holdout 分组。
2. 提案只读取 adaptive，明确记录父版本和实际加载版本。保留父版本能力，下一轮确实加载已接受版本。
3. 用同一解释器、案例、预算比较父版本、候选和每轮从初始版本重学的无继承对照。预算不足时先拒绝，不能部分执行后伪装成完整得分。
4. 服务器复算并校验案例/规则/报告哈希和修订号后接受。客户端提供的评分不构成准入证据。
5. 只有带服务端采集来源、当前来源仍有效且活动版本已接受的实验可以显式绑定。新回执记录实际版本，仍保持未确认标签。
6. 验证退回祖先实际改变后续归因；退回初始、待验证候选、来源排除或缺失时暂停版本预测，继续保留观察。保持历史冻结证据不变。

HTTP 写入采用服务端身份、运营动作同源检查和 revision CAS。实验 revision 与收集箱 revision 分开，遇到 stale_revision 先读最新状态再决定操作。

## 采集与持久化的已验证约束

只采集已审查操作模板、HTTP 状态和固定机器错误码；丢弃未知错误文本。不保存提示词、参数、正文、实例资源 ID 或凭据。跳过租户、只读和 RSI 自身请求，避免递归采集。

HTTP 200 的逻辑失败由可信内部 `receiptFailure:true` 保留，不开放客户端回执写入口。变更调用的失败结果标为 unknown，因为超时不能证明副作用没有发生。

观察不能改变原调用结果。若绑定在异步采集间切换，仅针对 `rsi_inbox_binding_required` 重试无预测的观察，防止丢失失败；不要把旧版本预测重新挂到新绑定。

发布跨进程锁时先完整写入并 fsync 临时锁记录，再 `fs.link` 排他发布。先建空锁再写 JSON 会让并行进程读取半条记录。保留原子 rename、目录 fsync、账号队列与文件权限；不通过清空状态修复损坏。

## 验收

运行与改动有关的测试；完整闭环可用：

```sh
node --import tsx --test server/evolution/rsi-*.test.ts server/monitoring/rsi-*.test.ts server/monitoring/platform-operations.test.ts server/monitoring/platform-assistant-routes.test.ts server/monitoring/observability-page-integrity.test.ts server/monitoring/observability-page-tenant-scope.test.ts
npm run typecheck
npm run build
```

使用已跑通的 [本地闭环验收脚本](scripts/replay-evidence.sh)，支持原 smoke 的参数：

```sh
sh .codex/skills/d-obs-rsi-validation/scripts/replay-evidence.sh --state-dir /tmp/d-obs-rsi-verify --output /tmp/d-obs-rsi-verify.json
```

该脚本经过真实本地 HTTP 执行路径，用预设夹具标签模拟确认，验收两轮继承、接受后实际应用和回退停止应用。所有网络请求仅在 127.0.0.1。核对清单的 source、labelAuthority、productionDataUsed 和 productionImprovementClaimed；夹具准确率不能作为生产收益。验收目录每次创建独立子目录，不能用作生产状态目录。

用浏览器查看页面空态、未确认预测与固定确认标签、准入门禁、当前版本和历史报告，保存实际截图。页面筛选/草稿应跨轮询保留，跨身份清除，旧异步响应不得回填新账号。

共享脏工作区出现无关失败时，保存错误证据，并在稳定来源快照中叠加本次文件和最小接线进行隔离验证，记录覆盖列表和哈希。不要为了得到绿色结果修改别人的 WIP；分别报告全仓检查与隔离结果。

交付时说明当前受限学习目标、实际采集入口、验收来源、测试结果和运行时应用证据。生产发布沿用用户授权范围和对应发布流程，本技能不提供发布授权。
