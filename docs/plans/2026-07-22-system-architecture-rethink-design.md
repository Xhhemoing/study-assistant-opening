# AIstudy 系统实现架构重审设计

**状态：**已批准（2026-07-22）  
**范围：**在已批准的终身学习产品设计之上，锁定进程形态、主后端语言、包边界与扩展闸门。  
**产品设计基线：**`docs/plans/2026-07-21-lifelong-learning-design.md`  
**实施计划基线：**`docs/plans/2026-07-21-lifelong-learning-implementation.md`

## 1. 决策摘要

| 决策 | 选择 |
|---|---|
| 部署形态 | 模块化单体：`apps/web` + `apps/worker`，同仓 monorepo |
| 主后端语言 | **TypeScript（Node.js）** |
| 数据真相源 | PostgreSQL |
| 异步 | Redis + BullMQ |
| 对象存储 | S3 兼容 |
| 多语言 | **默认不启用**；仅在扩展闸门通过后以专用 Worker 接入 |
| Phase 1 不做 | 微服务拆分、协同编辑、数据库视图、白板、完整 PDF 阅读 |

## 2. 方案取舍（已确认）

推荐并批准 **方案 A：TypeScript 模块化单体 + 同仓 Worker**。

- **拒绝方案 B**（Python 主业务 API）：双栈权限/事务/事件与自托管成本过高。
- **拒绝方案 C**（Day1 多语言微服务）：无负载证据前过早复杂化。

大规模查询与 AI 工具调用的扩展点是：

1. 事件追加写 + 派生快照读；
2. 同步路径与异步路径分离；
3. Worker 水平扩展与任务幂等；
4. PostgreSQL 索引/分页/（后期）pgvector；
5. 有证据后再挂异构 sidecar，而非更换主语言。

## 3. 进程与包边界

### 3.1 进程

```text
Browser
  → apps/web (Next.js + TypeScript)
       UI / SSR / Auth / 同步 API / 入队
  → PostgreSQL / Redis+BullMQ / S3
  → apps/worker (TypeScript)
       AI 编排、评估重算、索引、导出、轻量解析
  → [闸门后] workers/python-*（可选）
       仅专用重任务；契约入出；不拥有领域权威
```

| 进程 | 做 | 不做 |
|---|---|---|
| `apps/web` | 会话认证、对象级授权、资产/课程/目标/事件写入、计划读取、创建 Job | HTTP 内等待 LLM；重解析；批量重算 |
| `apps/worker` | 消费队列、AI tool-call、重算、导出、索引 | 对外用户会话 API；绕过 domain 写正式内容 |

### 3.2 共享包

| 包 | 职责 |
|---|---|
| `packages/contracts` | API / Job / 导入导出 / AI 输出 Schema（Zod） |
| `packages/domain` | 纯领域规则；不 import UI/DB/Redis |
| `packages/database` | Drizzle schema、迁移、repository |
| `packages/ai` | Provider、prompt、tool、候选装配；只产 Candidate |
| `packages/config` | 环境、开关、限流与模型策略 |
| `packages/ui` | 设计令牌与共享组件 |

### 3.3 领域模块（逻辑边界）

1. Identity  
2. Library（统一资产：Document/Block/Relation/Property/Revision 等）  
3. Course（长期课程、多目标、时间窗口、策略）  
4. Exploration（草稿、对话分支、PromotionRecord）  
5. Learning（追加事件、评估、计划）  
6. AI Orchestration  
7. Marketplace / Export（Phase 1 最小导出优先）

## 4. 数据流（核心）

### 4.1 作答 → 下一步

```text
Submit Attempt (web)
→ validate + append LearningEvent (同步成功即返回)
→ enqueue assessment recompute
→ worker derives AbilitySlices / SummaryStatus
→ planner updates future TaskQueue
→ UI 显示精简结果；派生延迟时显示“正在更新”
```

### 4.2 AI 候选

```text
User request (web)
→ create AIJob + enqueue
→ worker calls provider / tools
→ validate structured output (contracts)
→ save CandidateArtifact + provenance
→ user/reviewer accept/edit/reject
→ only then create formal content version
```

### 4.3 探索沉淀

```text
Exploration scratch/candidate
→ user selective promotion
→ PromotionRecord + Library asset reference
→ optional Course AssetMembership
→ never silent bulk promotion by AI
```

## 5. 错误处理与降级

| 故障 | 行为 |
|---|---|
| AI 不可用 | 笔记、探索草稿、练习、规则计划仍可用 |
| 队列不可用 | 事件先写 DB；outbox 后重试 |
| 向量不可用 | 降级元数据/全文检索 |
| 对象存储不可用 | 不宣称上传成功；可重试状态 |
| 评估失败 | 最近已知结果或规则基线，不伪造状态 |

## 6. 扩展闸门（异构 Worker）

仅当具备 profiling 或稳定性证据时，才增加 Python（或其他）专用 Worker。必须同时满足：

1. 任务 Schema 在 `packages/contracts` 版本化；  
2. 输出经 Schema 校验后进入 TypeScript domain 管线；  
3. sidecar **禁止**直接 UPDATE 正式资产/事件表；  
4. 失败不阻塞同步学习路径；  
5. 自托管文档同步更新。

典型触发场景（示例，非承诺）：重 PDF/OCR、本地 embedding 批处理、可测的 CPU 瓶颈。

## 7. 测试策略

- 单元：domain 纯函数（策略、评估、计划）  
- 集成：DB 事务/隔离、队列幂等、对象存储签名  
- 契约：API/Job/AI 输出 Schema  
- E2E：三入口闭环、AI 降级、资产跨课程唯一性  
- Spike（Phase 0 Task 1）：可执行验证后再锁版本进 ADR-001  

## 8. 与现有文档的关系

- 产品根领域以终身学习设计为准。  
- 本文件覆盖**系统实现架构与语言边界**；与旧「备考中心」Hermes 计划冲突时以本文件 + 终身学习实施计划为准。  
- `docs/architecture/ARCHITECTURE.md` 的模块化单体原则继续有效；语言与扩展闸门以本文件为准，后续应回写对齐。  

## 9. 下一步

1. Task 1：可执行 Spike + `docs/decisions/ADR-001-stack.md`  
2. Task 2：npm workspace 脚手架与质量门  
3. 按 `docs/plans/2026-07-21-lifelong-learning-implementation.md` 继续 TDD 纵向切片  
