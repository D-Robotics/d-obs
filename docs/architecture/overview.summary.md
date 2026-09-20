# 架构工件摘要

- 生成：2026-09-20，`system-modeler` 场景（+ `c4model` / `graphviz` 基础格式）
- 代码基线：main @ 9a6d74c
- 一句话回答：d-obs = **双进程（Web + 告警 Worker）+ 一库（PostgreSQL）** 的独立可观测平台，经 D-010 从 RDK Studio 抽取；鉴权 fail-closed、租户按 `tenant_id` 隔离、行动环无裸执行。

## 工件清单

| 文件 | 回答什么问题 |
| --- | --- |
| `d-obs.structurizr.dsl` | 系统上下文（L1）与容器（L2）：d-obs 与谁交互、内部有哪些可部署单元 |
| `runtime-topology.dot` | 生产怎么跑：nginx → systemd `d-obs` @18093、Worker、PG、Prometheus、systemd timers、发布与回滚 |
| `dataflow-ingest-alert.dot` | 数据怎么流：探针/OTLP/事件摄取 → 检查/投影落库 → worker 评估 → 状态机 → 投递/升级/自愈 |
| `d-obs.architecture-understanding.md` | 人话版架构解读、L3 模块表、边界约束、假设与不确定项 |
| `d-obs.evidence.md` | 每条架构主张的证据（file:line）与置信度 |

## 下一步（可选）

1. 如需拆分视图：可用 `dependency-impact-analyzer` 做模块依赖/变更影响图（`server/monitoring` 内部 100+ 文件值得一张 L3 图）。
2. 低置信项核实后回写 `d-obs.evidence.md`（dsh 依赖、supabase 残留、PG 部署形态）。
3. 若此目录要长期维护为 living architecture，可接入 `architecture-health` 做 freshness/traceability 校验。

## 维护说明

- 架构发生变更（新容器、新外部系统、端口变化）时，同步更新 DSL 与两个 DOT，并刷新证据表的行号。
- DOT 预览：`dot -Tsvg <file>.dot -o <file>.svg`；DSL 可用 Qoder 的 Structurizr DSL 查看器或 Structurizr Playground 打开。
