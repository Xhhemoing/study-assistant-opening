# Brainstorm 索引

本表是项目专题研究与在役接口草案的登记入口。状态含义见 [README](README.md)。

> 2026-11-28 文档清理中，2026-07 至 2026-11 间已被正式吸收或过时的 20 份历史研究笔记已移除（原文保存在 Git 历史中）；其中有效原则、决策、算法基线与架构边界已并入 [AI + 学习论](../product/LEARNING_THEORY.md)、[决策登记](../decisions/DECISIONS.md)、[架构开发计划](../roadmap/ARCHITECTURE_PLAN.md)、[算法开发计划](../roadmap/ALGORITHM_PLAN.md) 与 [ADR-v3](../decisions/ADR-v3-open-core-and-engine-boundaries.md)。

## 现役专题与契约

| 日期 | 主题 | 状态 | 指向板块 | 主要结论 | 正式落点 |
|---|---|---|---|---|---|
| 2026-11-18 | [个人知识资产图的数据与接口对接](2026-11-18-knowledge-assets-api.md) | promoted | Opening、课程要求、资料、笔记、学习证据与探索 | 以有界只读投影支持双向展开和切换视角，动作走原业务入口；二期落地跨课共享技能证据投影，附 [21 条合成请求与响应样例](2026-11-18-knowledge-assets-examples.json)（供 `asset-graph` 单测直接读取，路径保持稳定） | `packages/contracts/src/opening/asset-graph.ts`、`packages/database/src/repositories/opening-asset-graph.ts`、`apps/web/src/features/opening/asset-graph/` |

## 使用规则

- 新增研究先复制 [研究记录模板](templates/research-note.md)，再在本索引登记。
- 一个记录必须指向具体产品流程、领域对象、代码边界或计划任务。
- `proposed` 只能表示“建议批准”，不能被当成正式规格。
- 提升到正式文档后改为 `promoted`，并补充目标链接；已被正式文档完整吸收后按周期清理，不长期堆积重复计划。
