---
title: 学习记忆系统与插件化多源处理
date: 2026-07-29
status: proposed
scope:
  - Source / Memory / AI Context / Learning Evidence
  - Worker / Connector / Search / Storage
related:
  - ../architecture/ARCHITECTURE.md
  - ../architecture/DATA_MODEL_AND_PREDICTION.md
  - ../plans/2026-07-21-lifelong-learning-design.md
promotion_target:
  - 学习记忆系统设计
  - 插件协议
  - 记忆存储与投影 ADR
---

# 学习记忆系统与插件化多源处理

## 1. 决策问题

怎样建立既能处理网页、文献、GitHub、社交收藏、文件和软件资料，又能支持 AI 长期协作的全面记忆系统，同时避免把来源、用户知识、任务和能力评价混进一个向量库？

## 2. 调研结论

截至 2026-07-29，对官方资料的对比显示：

- Mem0 可借鉴抽取、去重、作用域和显式更新/删除；通用事实字符串不足以表达学习证据。
- LangGraph 可借鉴线程状态与跨线程长期 Store 分离；通用 Store 不应替代领域事实源。
- Letta 可借鉴少量常驻上下文和可搜索归档；Agent 不应自主修改正式用户知识。
- Graphiti/Zep 可借鉴 Episode、来源、时间有效性和事实失效；首期不需要独立图数据库。
- Cognee 可借鉴异步巩固 Pipeline；进入长期记忆必须先成为可审核候选。
- GraphRAG 可借鉴局部实体检索和全局主题摘要；大型图索引只适用于数据和查询证明有价值后。
- Airbyte/Unstructured 可借鉴协议化连接器、增量状态、记录版本和可重处理流水线。

官方参考链接：

- https://docs.mem0.ai/core-concepts/how-it-works
- https://docs.langchain.com/oss/python/langgraph/stores
- https://docs.letta.com/guides/core-concepts/memory/memory-blocks/index.md
- https://help.getzep.com/graphiti/getting-started/overview
- https://docs.cognee.ai/core-concepts/main-operations/remember
- https://microsoft.github.io/graphrag/index/overview/
- https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol
- https://docs.unstructured.io/pipelines/workflows

## 3. 记忆领域分层

记忆不是一种表，而是不同权威性、时效性和权限记录的组合：

| 类型 | 对象 | 规则 |
|---|---|---|
| 来源记忆 | Source/Snapshot/Anchor/Annotation | 带版本、原文和回链 |
| 情景记忆 | Capture/Learning/Decision/Feedback Event | 追加写，记录实际发生历史 |
| 语义记忆 | Document/Block/Claim/Concept/Relation | 用户确认后才是正式知识 |
| 前瞻记忆 | LearningIntent/Task/Reminder/PlanItem | 未来行动，可取消和重排 |
| 程序记忆 | Procedure/Workflow/FailurePattern | 操作和解决问题的方法 |
| 个人记忆 | Preference/Constraint/StableContext | 用户明确声明或确认 |
| 能力记忆 | AbilityEvidence/DerivedAssessment | 只能从真实表现推导 |
| 运行时记忆 | SessionState/WorkingSet/ContextPack | 有 TTL，不是长期事实 |

共同元数据包含 `workspace_id`、authority、生命周期、来源引用、valid time、recorded time、置信度、敏感级别、保留策略和模型/流水线版本。新事实通过 supersedes/contradicts/invalidates 关联旧事实，不原地抹除历史。

## 4. 插件协议

插件按最小权限拆分：

- `SourceConnector`：抓取和增量同步；
- `ContentParser`：格式和结构解析；
- `Enricher`：OCR、翻译和元数据；
- `Analyzer`：摘要、问题、关系、任务和应用建议候选；
- `Exporter/ActionAdapter`：导出或受控外部动作。

连接器接口：

```text
spec()                         声明配置、能力、权限和版本
check(config)                  验证授权和访问范围
discover(config)               返回 stream/schema
read(config, catalog, state)   输出增量记录和 checkpoint
```

统一 `CaptureEnvelope` 至少包含 connection、stream、external ID/version、source/observed time、content hash、deleted marker、raw blob reference、metadata、provenance 和 permission snapshot。

第三方插件不得直接访问数据库、对象存储、Redis 或主进程凭据；网络域名、文件、Cookie、CPU、内存和运行时限必须显式授权。外部内容全部按不可信输入处理。

## 5. 流水线与正式边界

```text
Connector
→ Raw Object + CaptureEnvelope
→ SourceSnapshot
→ Parse/Chunk/Anchor
→ OCR/Translate/Metadata
→ Claim/Question/Task/Relation Candidates
→ Deduplicate/Resolve/Conflict Check
→ Human or Policy Confirmation
→ Formal Domain Objects
→ Rebuildable Full-text/Vector/Graph Projections
→ ContextPack
```

每步记录 parser、chunker、embedder、extractor、prompt、model、policy 和 projection 版本。更换算法时从原始快照重放，不修改正式知识和历史事件。

## 6. 存储与伸缩策略

首期沿用模块化单体：

- PostgreSQL：正式对象、不可变事件、候选、关系、权限和 provenance；
- S3/MinIO：原文件、快照、图片、附件和解析中间物；
- Redis/BullMQ：抓取、分析、巩固、重建和删除任务；
- PostgreSQL 全文检索：确定性检索基线；
- pgvector：评测证明收益后启用语义检索；
- 关系表：首期图投影，复杂路径/规模达到门槛后再评估专用图后端。

全文、向量、图谱、摘要和评价都是可重建投影，不是事实源。Worker 可以按 workspace/source/dataset 分区并水平扩展。

## 7. 检索与 ContextPack

1. 先过滤 workspace、权限、有效期、敏感度和 authority；
2. 并行执行全文、向量、关系、时间、活动任务和最近事件召回；
3. 使用 RRF 等可解释融合基线，再评估学习排序；
4. 按任务和 token 预算构建结构化 ContextPack；
5. 记录本次实际使用的记忆、来源和版本。

ContextPack 明确区分当前目标、确认偏好、来源摘录、开放问题、历史经历、任务、能力限制和冲突事实。AI 必须能说明为何召回、来自哪里以及是否可能过期。

## 8. 遗忘、删除与治理

- AI 候选可过期，派生摘要和索引可重建；历史事件不被时间衰减篡改。
- 删除区分停止召回、归档、删除来源、删除派生内容和彻底清除。
- 彻底删除必须覆盖 SQL、对象文件、向量、图边、缓存和待执行任务，并生成可验证报告。
- 来源删除时可以保留用户笔记，但必须标识来源失效。
- 记忆中心允许用户查看、纠正、限定作用域、暂停、导出和忘记。
- AI 记住用户看过某内容，不能据此提升掌握状态。

## 9. 验收条件

- 插件断点恢复不重复产生副作用；
- 来源更新不覆盖旧快照和锚点；
- 冲突事实并存且带来源、双时间和状态；
- AI 无权直接写正式记忆；
- 跨工作区和未授权来源检索命中为零；
- 任一派生索引损坏都可从事实源重建；
- 删除操作清理全部指定投影并可审计；
- 向量/图服务失效时全文和手工流程仍可用。

## 10. 正式化与实施顺序

1. 记忆领域和权威性设计；
2. Source/Snapshot/Anchor/Provenance 契约；
3. LearningIntent/Task/PlanItem 边界；
4. 插件协议、权限和隔离 Runner；
5. 通用文本/URL/文件捕获；
6. 分析候选、审核和异步巩固；
7. 混合检索、ContextPack 和使用审计；
8. GitHub/Zotero/浏览器等适配器；
9. 用真实规模和查询证明需要后，再引入时间图谱和全局图分析。
