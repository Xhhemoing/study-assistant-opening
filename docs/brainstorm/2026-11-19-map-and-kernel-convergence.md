---
title: 知识地图收束与学习内核协同研究
date: 2026-11-19
status: promoted
scope:
  - Opening 知识地图（`/opening/map`）与冲刺台（`/opening/sprint`）
  - 课程学习路线（`learning-route`）、延迟复测资格与今日续学入口（`/opening/today`）
  - `packages/contracts/src/opening/{asset-graph,course-route,knowledge}.ts`
  - `packages/database/src/repositories/{opening-asset-graph,opening-course-route-retest-state,opening-study-exposure,opening-study-notes}.ts`
  - `apps/web/src/features/opening/{asset-graph,courses,exam-sprint,teaching}`
  - 多工具协同工作流（`docs/operations/agent-workflow.md`、`.agents/skills/aistudy-autopilot/SKILL.md`）
related:
  - docs/brainstorm/2026-11-18-knowledge-assets-api.md
  - docs/brainstorm/2026-11-18-long-running-learning-agent.md
  - docs/plans/2026-10-17-goal-driven-learning-framework.md
  - docs/product/UX_AND_AI_POLICY.md
  - docs/product/PRD.md
promotion_target:
  - docs/plans/2026-11-19-map-and-kernel-convergence-plan.md
---

# 知识地图收束与学习内核协同研究

## 1. 决策问题

11 月 18 日至 19 日期间，项目并行推进了三条演进线：

1. **长效学习内核修订（Kernel v2）**：围绕课程知识覆盖状态、当日例外时长与跨日复测改排、无课程多稿写作分离恢复推进设计（PR `#448`）与首批主线切片（PR `#449`、`#451`–`#454`）。
2. **知识地图双轨演进**：发布主线合入 PR `#450`（在单一 `AssetGraphWorkspace` 中补齐关系图/列表双视图切换与无障碍键盘导航），而自由画布原型在同一路由 `/opening/map` 下并行构建了子树拖拽、二维根节点排布、离屏定位、级数沙盒示例与考前 15 分钟挑题面板。
3. **多工具协作减负**：针对并行委派中的全仓构建争用与多轮审查往返，收紧默认局部检查与单轮双审汇聚规则。

当前必须回答四个直接影响主线收束与学生体验的架构问题：

- **地图考前「15 分钟」入口语义（问题 1）**：地图考前挑题究竟表示一次进入课程工作台的学习意图，还是与当日例外日程共享的服务端可兑现时间承诺？
- **「本轮纸上已复习」记录边界（问题 2）**：考前纸面过题的勾选应作为浏览器会话级可撤销核对、服务端独立接触记录，还是直接移除？
- **画布与图谱关系演化边界**：如何把自由画布交互并入 `#450` 的单一状态机，并在不引入脆弱边主键迁移的前提下呈现课程知识边的核验状态、可重验出处与即时追问/反例？
- **诊断微探针与延迟复测资格边界**：在图谱或工作台中提供两步诊断微探针时，如何避免污染待复测要求的 `independent` 资格？

如果不先收束上述边界，`/opening/map` 将出现两套冲突的前端状态机、仅对前 40 项分页结果排序的局部推荐，以及在跨入口跳转时无法兑现或意外污染复测证据的断层。

## 2. 指向范围

| 层次 | 明确指向 |
|---|---|
| 用户场景 | 考前在地图看清薄弱课程要求并开始 15 分钟针对性练习；在地图与冲刺台之间核对本轮纸面复习进度；查看课程知识关系的材料出处与核验状态；断网或资料列表偶发失败时稳定续学 |
| 产品入口/流程 | `/opening/map`、`/opening/sprint`、`/opening/courses/[id]/study`、`/opening/today` |
| 领域对象 | `AssetGraphPage`、`AssetGraphEdge`、`CourseRouteSnapshot`、`CourseRequirementProgress`、课程知识快照边（`KnowledgeEdge`）、延迟复测（`DelayedCheck`）、学习笔记（`StudyNote`） |
| 代码边界 | [asset-graph 契约](../../packages/contracts/src/opening/asset-graph.ts)、[course-route 契约](../../packages/contracts/src/opening/course-route.ts)、[knowledge 契约](../../packages/contracts/src/opening/knowledge.ts)、[图谱只读仓储](../../packages/database/src/repositories/opening-asset-graph.ts)、[复测状态仓储](../../packages/database/src/repositories/opening-course-route-retest-state.ts)、[知识地图工作台](../../apps/web/src/features/opening/asset-graph/asset-graph-workspace.tsx)、[课程学习工作台](../../apps/web/src/features/opening/courses/course-study-workspace.tsx)、[冲刺检查点](../../apps/web/src/features/opening/exam-sprint/sprint-checkpoint.ts) |
| 计划任务 | 基于已合入主线的 `#454`–`#456` 基线合并自由画布至单一 `AssetGraphWorkspace`、零迁移补齐知识边状态与重验出处、拆分续学首屏加载并进入用户浏览器验收 |

## 3. 不变量与约束

- **单一学习证据权威**：`LearnerState` 与 `RequirementStatus` 只由服务端合格作答、核对与复测记录派生；任何纸面复习勾选、画布展开或预览读取不得改写能力估计或达标状态。
- **帮助放行与复测独立资格隔离**：延迟复测资格同时检查间隔期内的帮助放行记录与同一 `(course_id, requirement_key)` 的中间作答记录；预取、画布浏览和未授权微探针不得静默触发帮助放行或写入中间作答。
- **只读有界投影与权限重验**：`/api/opening/asset-graph/query` 保持只读、有界分页与 HMAC 游标签名；任何边出处（课程资料版本、页码）必须在当前工作区、课程归属、可读版本与隐私排除条件下重验后才可返回，缺失页码时严禁以 `chunk_index` 冒充 `page`。
- **无课程写作零隐式欠账**：自由写作与探索笔记在不绑定课程要求时保持零自动排程，不进入课程待办或预算扣减。
- **零破坏性迁移与模块化单体边界**：优先在现有 PostgreSQL 事实表与契约可选字段内完成零迁移收束；未完成真实浏览器走查与单专题校准前，不新增独立知识边持久化主键表。

## 4. 已验证事实

1. **发布分支与集成基线（2026-11-19 核对）**：`feat/opening-release` 远端指向 `b1b98a9c`，已包含复测排期窗口（`#449`）、知识地图列表视图（`#450`）、课程知识同步状态（`#451`）、无课程写作权限与续写分离（`#452`、`#453`）、当日例外时长与跨日复测改排（`#454` `eb966c84`）以及 CI 看门狗与主线状态同步（`#455`、`#456`）（相关 UI 待用户浏览器验收）；`integration/opening` 已同步 `#448` 内核修订设计文档与 `feat/opening-release` 基线。
2. **知识地图前端存在双入口分叉**：`#450` 在 [asset-graph-workspace.tsx](../../apps/web/src/features/opening/asset-graph/asset-graph-workspace.tsx) 内维护单一 store、关系图/列表视图切换（`AssetGraphListView`）以及带 `selectedMinutes`（默认 20 分钟，支持 `5..180` 分钟）的 `startCourseRequirement` 动作；而自由画布原型新增平行 `FreeMapEntry` 与客户端 `roots(kinds: ["requirement"], limit: 40)` 局部排序组件，若直接并存将造成同一 `/opening/map` 出现两套选择、焦点、刷新与权限回退逻辑。
3. **全课程要求分母已有权威接口且正式复测依赖任务绑定**：[course-route.ts](../../packages/contracts/src/opening/course-route.ts) 中的 `courseRouteSnapshotSchema` 已按课程一次性返回 `scopeState`、全量 `requirements`（含 `status`、`mandatory`、`position`、`delayedCheck`、`sourcesAvailable`）及 `courseRouteStartSchema`（含 `minutes: 5..180`、`taskId`、`expectedTaskVersion`），无需在图谱分页接口上拼凑局部推荐；同时 [opening-course-route-actions.ts](../../packages/database/src/repositories/opening-course-route-actions.ts) 第 201–214 行仅在传入待处理 `taskId` 与 `expectedTaskVersion` 时绑定正式复测活动（无任务上下文直接启动会退化为普通练习并写入间隔期作答）。
4. **课程知识边状态被投影层压平且客户端边契约为严格模式**：[knowledge.ts](../../packages/contracts/src/opening/knowledge.ts) 中 `knowledgeEdgeSchema` 已存有 `status: "suggested" | "supported" | "needs_check"` 与 `evidenceChunkIds`，但 [opening-asset-graph.ts](../../packages/database/src/repositories/opening-asset-graph.ts) 在构造 `contains / prerequisite / appliesTo` 边时将 `supported` 与 `needs_check` 统一映射为 `basis: "recorded"`，前端无法区分“材料已支撑”与“待核对”，且知识图重建不保留跨版本稳定边 UUID；同时 [asset-graph.ts](../../packages/contracts/src/opening/asset-graph.ts) 第 258–269 行的 `assetGraphEdgeSchema` 采用 `.strict()` 解析，新增可选边字段需前后端同单原子切流或先行下发宽松读取契约。
5. **预取笔记正文与中间作答存在证据副作用**：笔记正文交付走 [opening-study-exposure.ts](../../packages/database/src/repositories/opening-study-exposure.ts) 放行回执，学习笔记绑定通过 [opening-study-notes.ts](../../packages/database/src/repositories/opening-study-notes.ts) 仅支持关联课程、目标或课程要求，不支持绑定课程知识边；同时 [opening-course-route-retest-state.ts](../../packages/database/src/repositories/opening-course-route-retest-state.ts) 第 62–69 行与 [course-route-retest.ts](../../packages/domain/src/opening/course-route-retest.ts) 会将复测等待期内的帮助放行判为 `assisted`、将同 `requirement_key` 的中间作答判为 `insufficient_evidence`。
6. **续学首屏与结束小结仍可收紧**：[course-study-workspace.tsx](../../apps/web/src/features/opening/courses/course-study-workspace.tsx) 当前复用了 [course-detail.tsx](../../apps/web/src/features/opening/courses/course-detail.tsx) 的聚合加载，课程资料列表偶发失败会连带阻断已有活动的继续作答；[activity-summary-card.tsx](../../apps/web/src/features/opening/teaching/activity-summary-card.tsx) 与 [next-learning-step.ts](../../packages/domain/src/opening/adaptive/next-learning-step.ts) 尚未在小结卡片上直接收口为单一推荐动作；[loop-metrics.ts](../../packages/domain/src/opening/adaptive/loop-metrics.ts) 中首次独立表现与隔天复测结果的配对统计仍待单专题跑通。

## 5. 假设与未知项

| 假设/未知项 | 风险 | 验证方法 |
|---|---|---|
| 自由画布子树拖拽与关系图/列表三态共享同一 `AssetGraphStore` 后，在大课程节点数（>80）下仍能保持流畅交互与清晰焦点恢复 | 视图切换时若未清理待定焦点或坐标缓存过大，可能引起跳焦或卡顿 | 单测覆盖视图切换焦点与 `decodeFreeMapPositions` 边界，并交用户真实浏览器走查 |
| 考前「本轮纸上已复习」使用 `sessionStorage` 跨 `/opening/map` 与 `/opening/sprint` 共享即可满足单次考前冲刺核对需求，暂无需跨设备持久化 | 用户关闭标签页或换设备后纸面勾选会清空 | 在界面显著标明“仅限本次浏览器会话、不计入掌握度”，观察真实考前试用是否出现跨日保留诉求 |
| 单门高数课程的级数专题足以验证“首次作答 → 纠错/提示 → 隔天独立复测”完整闭环及付费试点意愿 | 若题库平行变体或材料锚点不足，可能卡在 `reservedSupply` 或 `needs_check` | 先跑通单专题端到端验收，再决定是否扩充题库或引入新表结构 |

## 6. 候选方案

### 问题 1：地图考前「15 分钟」入口语义

- **方案 1A（当前批准基线：学习意图 + 复用 `learning-route` 全课程分母 + 到期复测任务强绑定）**：在课程上下文下读取 `CourseRouteSnapshot` 全量要求作为推荐分母（不再用图谱 `roots(limit: 40)` 局部猜测，且在过滤 `verified` 之前先检查到期 `delayedCheck`），按服务端真实状态确定性选出下一项可行动要求与一句可核对原因，支持在画布/列表中定位该节点；对普通练习要求在触发 `startCourseRequirement` 进入课程学习工作台时默认预填 `minutes = 15`，对已到窗口的正式延迟复测要求强制携带绑定的 `taskId + expectedTaskVersion` 启动或跳回 `/opening/today` 复测入口（绝不无 `taskId` 静默降级为普通练习）。不改动当日计划容量账本，不承诺“墙钟 15 分钟必能做完”。
- **方案 1B（增强方案：服务端可兑现时间承诺）**：对接 `#454` 当日容量/例外接口与题目耗时预估，仅返回剩余预算与题量均可保证在 15 分钟内闭环的候选动作。需要等待 `#454` 浏览器走查稳定并补齐单题耗时校准，否则容易出现预览可读但提交报 `400/409` 的断层。
- **方案 1C（替代方案：仅保留无时长挑题）**：完全移除地图侧时长预设，只保留定位节点与默认 20 分钟进入学习。损失考前短时冲刺的明确入口预期。

### 问题 2：「本轮纸上已复习」记录边界

- **方案 2A（当前批准基线：浏览器会话级跨页可撤销勾选）**：保留在 v1，采用与 [sprint-checkpoint.ts](../../apps/web/src/features/opening/exam-sprint/sprint-checkpoint.ts) 一致的 Zod 校验 `window.sessionStorage` 存储，按 `(userId, workspaceId, scopeKind, scopeId, roundId)` 作用域在 `/opening/map` 与 `/opening/sprint` 间共享 `{ requirementId, requirementRevision, markedAt }`，支持随时撤销与“开启新一轮纸上核对”；严格不写服务端、不改 `LearnerState` / `RequirementStatus`，当 `requirement.revision` 变化或隐私变更时自动失效旧标记。
- **方案 2B（增强方案：服务端独立纸面接触记录表）**：新增独立表或字段持久化纸面接触历史与轮次，跨设备同步，仍与学习能力证据隔离。需新增 migration、备份恢复校验与删除链路，当前收益尚不足以证明复杂度。
- **方案 2C（替代方案：首版移除）**：完全删除纸上复习按钮，考前仅靠线上答题推进。对习惯拿讲义和草稿纸快速过一轮考点的学生缺少低负担进度抓手。

### 问题 3：画布融合、知识边出处、追问反例与微探针边界

- **方案 3A（当前批准基线：零迁移收束 + 沙盒隔离微探针）**：
  1. 将自由画布组件并入 `#450` 的单一 `AssetGraphWorkspace`（提供自由画布 / 结构画布或统一关系图 + 列表视图，移除重复的 `FreeMapEntry` 与局部 40 项挑题器）；坐标按 `(workspace/user, context, nodeId)` 存本机 `localStorage` 且只存坐标数值。
  2. 在 `assetGraphEdgeSchema`（`.strict()`）上通过客户端显式协商（`includeKnowledgeEdgeDetails`）增加可选 `knowledgeStatus`（`suggested | supported | needs_check`）与重验后的可选出处信息（未传协商位的已打开旧标签页默认保持原严格边形状），服务端重验 `evidenceChunkIds` 所属课程资料权限、可读版本与非空正整数 `page`，并连同协商位纳入 `scopeFingerprint` 游标失效计算。
  3. 边上“一句话追问 / 反例”默认作为临时只读核对，不静默建卡、不在画布预取笔记正文；学生显式点击保存时才通过既有 `study-notes` 绑定到课程或课程要求。
  4. 两步诊断微探针首版仅保留在级数内置示例（沙盒）中，不在真实课程待复测要求上直接写入作答或放行提示，保护延迟复测的 `independent` 资格。
- **方案 3B（重型方案：稳定知识边表 + 边级笔记关联 + 真实课程内联微探针）**：为 `opening_course_knowledge_edges` 增加跨版本稳定主键与对齐算法，扩展 `learning_asset_links` 支持 `knowledge_edge`，并在真实课程图谱内直接运行计分微探针。需数据库迁移、跨版本图对齐规则及复测“先测 / 先练”显式分流协议，当前时机不成熟。

## 7. 算法评估

| 维度 | 1A + 2A + 3A（零迁移收束基线） | 1B + 2B + 3B（服务端承诺与持久化扩展） | 1C + 2C（极简裁剪） |
|---|---|---|---|
| 目标效果 | 覆盖全课程分母挑题、15 分钟短时进入、跨页纸面核对、自由画布与列表同源定位、知识边状态与真实页码可辨 | 额外获得跨设备纸面轮次、服务端硬时长校验与边级长期笔记 | 仅保留基础浏览与默认入口，考前短时复习与纸面核对体验缺失 |
| 数据需求 | 复用现有 `CourseRouteSnapshot`、`KnowledgeSnapshot`、`source_chunks` 与浏览器存储 | 需单题耗时校准数据、新增纸面记录表与知识边跨版本对齐规则 | 无新增数据需求 |
| 延迟/吞吐 | 零额外写放大；图谱查询维持单次只读有界投影，续学首屏拆出慢速资料列表后更快可交互 | 增加事务锁、跨表联查与每次纸面点击的写接口开销 | 最低 |
| 成本 | 零数据库迁移，零静默模型调用 | 迁移维护、备份恢复预检与测试夹具成本显著上升 | 最低 |
| 可解释性 | 推荐分母（全课程 `N` 项要求）、排序优先级与“纸上复习不计入掌握”文案完全透明可核对 | 容量扣减、跨日改排与边对齐失败原因较难向学生一眼解释 | 高 |
| 隐私与安全 | 会话键隔离 `userId + workspaceId`；边出处重验当前可读资料与隐私排除；不预取笔记正文 | 新增持久化表须同步接入删除、导出与隐私纪元递增 | 高 |
| 可迁移/可回滚 | 零数据库迁移；契约 `.strict()` 增量字段按请求显式协商返回（旧标签页默认收原形状，回滚零数据库依赖） | 含 schema 变更与备份恢复联动，回滚成本高 | 可直接回退 |
| 扩展性 | 预留升级钩子：待 `#454` 浏览器验收与耗时校准稳定后可平滑把 `minutes=15` 升级为容量联动预览 | 提前固化尚未验证的边身份与纸面模型，易形成历史包袱 | 需重新设计考前辅助层 |
| 失败降级 | `learning-route` 未确认范围时明确提示先确认范围；`sessionStorage` 不可用时仅禁用纸面勾选且不阻断地图与答题 | 任一容量或持久化子链路异常均可能导致主入口报错阻断 | 退化为纯静态图 |

## 8. 推荐结论

- **推荐方案**：采用 **1A + 2A + 3A** 组合，即以 `learning-route` 全课程快照驱动地图考前挑题、到期复测优先于普通纠错判定并强绑 `taskId + expectedTaskVersion`、普通练习预填 **15 分钟学习意图**（**1A**），以浏览器 `sessionStorage` 提供跨 `/opening/map` 与 `/opening/sprint` 共享、带 `requirementRevision` 校验的可撤销 **本轮纸上已复习（2A）**，并将自由画布交互并入单一 `AssetGraphWorkspace`、按客户端显式协商零迁移补齐课程知识边 `knowledgeStatus` 与重验出处、保持边追问默认临时且微探针留在级数沙盒（**3A**）。同时顺手完成续学首屏与资料列表解耦及活动小结单一推荐动作接线。
- **适用边界**：Opening 单科邀请试用与高数考前专题验收阶段；单门课程要求规模在百级以内、图谱单页有界窗口 `<= 40`。
- **暂不采用**：
  - 不在地图侧新增独立的服务端“15 分钟可兑现时间承诺”接口（待 `#454` 完成真实浏览器走查且单题耗时有校准依据后再议）；
  - 不为“纸上已复习”新增服务端表或改动 `LearnerState` / `RequirementStatus`；
  - 不在当前阶段为 `opening_course_knowledge_edges` 增加跨版本持久化主键，也不把 `learning_asset_links` 扩到知识边；
  - 不在真实课程待复测要求上直接执行会写入作答或放行帮助的内联微探针；
  - 不因无课程自由写作或图谱临时追问自动创建今日任务。
- **升级触发条件**：
  1. `#454` 通过真实浏览器走查，且至少 1 个高数专题积累了题目实际耗时分布后，评估将 1A 升级为与当日剩余容量联动的时长预览（1B）；
  2. 真实试用中出现明确高频诉求“跨设备/跨天保留多轮纸面核对清单”，再立项评估轻量服务端轮次记录（2B）；
  3. 课程知识图重建频率与边级纠错样本证明需要跨版本保留人工边批注时，再设计稳定知识边身份与对齐迁移。
- **回退方案**：前端视图切换与会话级纸面标记零服务端迁移依赖；`assetGraphEdgeSchema` 新增可选字段仅对显式协商的新客户端返回（已打开旧标签页默认保持原严格边形状，若需回退直接停发或整体回退发布包即可，无需回滚数据库）；若自由画布交互在特定设备出现兼容问题，用户可在同一工作台一键切回列表视图或基础关系图。

## 9. 验证计划

- **数据集或测试夹具**：
  - 既有 [21 条资产图合成夹具](2026-11-18-knowledge-assets-examples.json) 扩展课程知识边 `suggested / supported / needs_check`、缺失页码 chunk、隐私排除重验与旧客户端未协商兼容用例；
  - 内置高数无穷级数示例模型（正项级数、比较判别法、比值/根值判别法、莱布尼茨交错级数）用于自由画布与两步沙盒微探针单测；
  - `CourseRouteSnapshot` 多状态要求夹具（覆盖 `needs_correction`、含 `verified` 及与 `needs_correction` 同时成立的到期 `retest`、`assisted`、`needs_verification`、`unobserved`、无到期复测的 `verified`、`blocked` 及 `scopeState !== "confirmed"`）。
- **当前基线**：`feat/opening-release`（`b1b98a9c`，已含 `#449`–`#456`）单一工作台 + 关系图/列表双视图；76/76 离线教学规则回归通过；批改 `calibrated=false`。
- **离线指标**：
  - 契约与单测：知识边状态与出处重验准确率 100%（无越权资料泄露、无 `chunk_index` 伪页码、资料版本或隐私变更后旧游标 100% 返回 `CURSOR_STALE`）；
  - 状态隔离：切换/撤销“本轮纸上已复习”前后，所有 `LearnerState`、`RequirementStatus` 与服务端写请求次数严格为 `0`；到期复测绝不无 `taskId` 误调普通练习；
  - 续学韧性：模拟课程资料列表接口 `500` 时，已有活动续学首屏正常可作答，资料面板独立报错可重试。
- **线上/产品指标（单专题试点）**：利用 [loop-metrics.ts](../../packages/domain/src/opening/adaptive/loop-metrics.ts) 串联同一高数专题的**首次独立作答率**、**复测到期返回率**与**隔天新题独立正确率**。
- **用户验收场景**：从 `/opening/map` 选定一门课 → 查看全课程要求分母下的考前优先项与 15 分钟预设 → 勾选/撤销另一项“本轮纸上已复习”并在 `/opening/sprint` 看到一致标记 → 点击优先项进入 `/opening/courses/[id]/study` 完成一次独立作答 → 回到地图看到新增作答证据与更新后的状态 → 次日或到期后携带绑定任务或经 `/opening/today` 进入延迟复测。
- **通过阈值**：非浏览器门禁（目标包 `typecheck`、相关 `unit/handler` 测试、边界检查脚本与精确 head CI）全部零错误通过；上述端到端浏览器旅程由用户走查确认无跳焦、死胡同或状态误报。
- **失败停止条件**：若发现任何会静默写入错误学习证据、破坏延迟复测 `independent` 资格或泄露未授权课程资料片段的路径，立即阻断合入并退回最小只读投影。

## 10. 风险与治理

- **来源可信度与幻觉隔离**：知识边明确区分 `supported`、`needs_check` 与 `suggested`；未经当前可读材料 chunk 实证的边严禁渲染为“已核实定理依赖”，无页码 chunk 不伪造页码。
- **隐私、越权访问与工作区隔离**：浏览器 `localStorage` 仅存纯数值节点坐标（不含标题与证据摘要）；`sessionStorage` 纸面勾选键强制包含 `userId` 与 `workspaceId`，登出、切换账号/工作区或触发隐私变更事件时立即隔离或失效，防止共用浏览器串号。
- **错误自动化与证据污染防护**：禁止画布自动预取触发帮助放行的笔记正文；禁止无课程探索或临时追问自动生成排程任务；禁止在待复测要求上静默插入会消耗独立资格的微探针或无 `taskId` 降级启动普通练习。
- **公开仓库信息边界**：研究与计划文档仅记录模块路径、契约语义、提交/PR 编号与脱敏验证结论，不写入任何本机路径、主机拓扑或运行快照。

## 11. 正式化路径

获批后需要更新与推进：

- [x] 正式设计与实施计划：[2026-11-19-map-and-kernel-convergence-plan.md](../plans/2026-11-19-map-and-kernel-convergence-plan.md)
- [x] `#454`（`eb966c84`）跨日时间改排、`#455` CI 看门狗与 `#456` 状态同步合入 `feat/opening-release`（UI 待用户浏览器验收）
- [ ] 多工具协作技能细则收紧（`docs/operations/agent-workflow.md`、`.agents/skills/aistudy-autopilot/SKILL.md`）
- [ ] `AssetGraphWorkspace` 自由画布融合 + `1A`（15 分钟学习意图与到期复测任务绑定）+ `2A`（跨页会话级纸上复习勾选）
- [ ] `asset-graph` 契约与只读仓储零迁移原子切流补齐知识边 `knowledgeStatus`、重验出处与 `scopeFingerprint`
- [ ] `course-study-workspace` 续学首屏解耦与 `activity-summary-card` 单一下一步动作接线
- [ ] 用户浏览器端到端验收与单高数专题首次/延迟复测指标校准

## 12. 变更记录

| 日期 | 状态 | 变化 | 依据 |
|---|---|---|---|
| 2026-11-19 | promoted | 完成跨分支架构交叉核验；用户批准整体收束方案并拍板 1A（15 分钟学习意图）与 2A（会话级跨页纸上复习勾选），同步提升至实施计划 | 源码核验、独立交叉评审与用户明确决策（1A、2A） |
