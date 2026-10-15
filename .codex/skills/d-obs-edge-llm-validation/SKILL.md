---
name: d-obs-edge-llm-validation
description: 验收 d-obs 的 X5 端侧文本模型部署模块、真实 runner 协议与浏览器工作流。用于“测试端侧大模型”“部署模块联调”“X5 Qwen 平台验收”“edge-llm smoke”；无板卡时使用明确标记的本机 fixture。生产发布另用 d-obs-release。
---

# 端侧大模型模块验收

按用户范围选择本机联调或真实板卡验收。用户说尚未接板子时，完成平台与 runner 测试；将推理服务和硬件探针明确标为 fixture，不把 fixture 的 token/s 或配置板型写成 X5 实测。板端接入过程见仓库 `docs/edge-llm.md`。

## 本机回归

在仓库根目录检查 `git status --short`，保留其他会话的未提交工作。执行当前实际测试文件，不把历史测试数量当固定验收条件：

```sh
npm run typecheck
node --import tsx --test server/monitoring/edge-llm*.test.ts server/monitoring/platform-operations.test.ts server/monitoring/platform-assistant-routes.test.ts tools/edge-llm-runner.test.mjs
bash -n tools/edge-llm-bootstrap.sh
node --check tools/edge-llm-runner.mjs
```

`edge-llm-runner.integration.test.ts` 会运行生产平台服务和生产 runner，通过真实本机 HTTP 完成部署、三案例流式计时、报告及停止；推理二进制仍是 fixture。测试独立临时状态与模型目录，结束关闭 HTTP server、停止自己启动的子进程并清理 fixture。不要借用生产配置、状态目录或已有模型服务。

重点核对：

- HTTP202 只登记 submitting；查询原 UUID，丢响应不重发部署。
- 模型哈希、非空输出、服务健康及固定案例都存在才接受成功；缺失或矛盾的零 token 数留空，不由字符估算。
- TTFT 用客户端首个有效 SSE 内容计时；runtime 生成速度和包含 TTFT 的请求平均速度分列。
- unknown 恢复使用服务端冻结的旧 ID 集。runner 先保存拒绝重放记录、只停止自己的进程、验证推理端口释放；平台旧任务标 superseded，outcome 仍 unknown。
- 错误恢复清单不能终结旧任务。跨账号恢复不在其他账号的列表、报告或回执中暴露旧 ID、私有清单及凭据。

## 浏览器工作流

有 UI、路由接线或状态机改动时，在本机临时 Express 实例挂载生产 `registerEdgeLlmRoutes` 与 `renderEdgeLlmPage`，配置独立 `EdgeLlmService` 和独立生产 runner，推理与硬件用标注清晰的 fixture。使用当前可用的 Playwright；仓库无此依赖时可复用已安装的 Studio 项目依赖，不为测试升级全局包。

沿真实页面检查匿名拒绝、登录后目录、probe、deploy、benchmark、受保护报告下载、stop、错误哈希失败、刷新不重放及桌面/手机溢出。页面就绪状态来自异步目录刷新；等待操作完成与目标状态完成刷新后断言，不以点击成功或 HTTP200 代替最终结果。

额外检查模型 ready 时部署按钮禁用，benchmark 与 stop 仍可用；停止后才允许新部署。身份改变后丢弃晚到回执并清空私有页面数据。

保存结构化报告，写明 `realX5Tested:false`、`realQwenTested:false` 及 fixture 范围。截图里的测试设备和模型名称也标明非真机。修复实际发现的问题后运行针对性回归，再报告通过数量与当前限制。

## 真机验收边界

本机测试通过不证明官方模型文件下载、llama.cpp 实际编译、X5 推理性能或 BPU 加速。只有用户提供真实连接并授权该场景后，按接入文档保存实际 probe、模型 SHA、runtime 版本、deploy、benchmark 和 stop 报告。发布 d-obs 与安装板端服务是不同操作，分别遵循用户范围。
