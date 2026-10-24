# 阶段执行与所有权

用户于2026-10-24授权：保存方案，主代理分析细化，gpt-6.1-sol/high 子代理实现，完成验收后继续下一阶段。按本地实际开发树推进，保留已有dirty/untracked。此授权不包含自动push/合并/部署。

## 阶段与退出条件

| 阶段 | 工作 | 退出条件 | 当前状态 |
|---|---|---|---|
| 0 | 保存方案/任务卡/子代理路由 | 文件读回、分支核对、模型路由配置与调用日志核实 | 已完成 |
| 1A | P01连续性，P02示例，P03预览后端 | 三片实际代码+近测；主代理复核接口与权限 | 代码已落地，回归修复与验收中 |
| 1B | P04阅读器/课堂预览接入、渲染锚点 | 主路径可达、定向回归+类型；材料身份/曝光不回退 | 阅读器与课堂划词已接入并近测通过；自动图谱候选未接，类型/浏览器待验 |
| 2 | P05上下文审阅/多引用，P06支线 | 持久化语义+备份恢复+原生PG+UI接线 | 2A已接入并近测通过；2C纯上下文选择器33项及独立类型通过，数据库/入口尚未接；多引用未实现 |
| 3 | P07a自己的理解，P07b解释检查 | 原话/修订/来源正确；正式评分维度与投影隔离 | P07a真实入口与19项近测通过，Web完整类型/浏览器待验；P07b未实现 |
| 4 | P08节点整理，P09局部路径 | 稳定ID重建/偏好、可返回真实路径 | 待前置 |
| 5 | 跨片验证、P10指标、交接 | 近测/相关类型/迁移恢复完成，浏览器及真实质量单列 | 待实现 |

不把浏览器待用户验收伪装通过，也不以等待浏览器为由停止可继续的非浏览器开发。真实付费模型质量测试另经预算与材料允许后执行。

## 阶段1A文件归属

- demo子代理：新增 `features/opening/demo/**`、`app/demo/learning/**`、AI readiness中最小示例入口；不改middleware/其他全局路由。
- preview后端子代理：`features/opening/concepts/preview-{contract,service,client}.ts`及近测，`api/opening/concepts/preview/route.ts`；必要窄helper。不得覆盖既有dirty材料/批改文件。
- continuity子代理：assistant-drawer/session/conversation-companion/conversation-links/study-conversation-context及各自测试。不得修改其他待接前端。
- 主代理：STATUS、计划、集成与最终验收；共享文件/exports等协调后只由指定人员写入。

## 阶段1B派单规格（在1A实际契约确认后执行）

### UI1 材料预览最小主链

独占 `inbox/source-reader.tsx`及其新交互test，新增 `concepts/concept-preview.tsx`与对应test。

1. 读取真实preview-contract/client，不能猜字段；捕获ReaderSelection的source/version/page与文本，失效时阻止请求。
2. 点击“查看概念”显式请求，不在mount/selectionchange自动POST；按钮pointerdown保留选区，组件保存冻结选区及打开前焦点。
3. 展示 loading/available/unavailable/ambiguous/restricted/stale/error；available标材料原文或已存解释，不伪装AI生成。展示locator，内容Markdown/公式安全渲染。
4. 重试复用未改变逻辑意图key；快速切选区与关闭时旧响应不可覆盖新状态；新attempt/权限不用旧缓存绕过交付。
5. “继续问”只带入冻结选区+原版本/页码，沿既有StudyContextTools预填，不自动发送；questionProtected时保持现有限制，从原题帮助入口继续。
6. Esc优先关闭预览不退出整个Reader；焦点/滚动恢复。使用现有Dialog/工具槽，禁用原生CSS/inline style。
7. 后端不支持的activity/turn来源明确保留原提问入口，不造假预览；后续专片补服务能力。
8. 跑定向unit：状态、陈旧请求、保护态、身份、公式/引用、关闭/深问。必要hook测试用项目既有React测试方式；不要求子代理自行开浏览器。

### UI2 课堂与回答锚点

待UI1确定组件接口后处理。先做纯remarkConceptAnchors及边界测试，候选来自允许的已核对映射；不可通过匹配label访问全库。无node/authority映射时不生成假锚点。扩展preview服务activity/turn支持需独立后端片，不把仅前端形式标完成。

## 本地测试资源

本轮只读确认已有隔离 PostgreSQL：127.0.0.1:55439，role aistudy，数据库 aistudy_opening_test，独立进程data dir为本仓`.local/sprint-runtime/pg`。只在串行验收时使用 `OPENING_TEST_DB=1 OPENING_TEST_DATABASE_URL=postgresql://aistudy@127.0.0.1:55439/aistudy_opening_test`，仍走scripts/opening-test-db校验。不得连接16/main_aistudy生产集群，不得重置该本地库或与其他任务并发跑会清数据的integration。实际运行前检查占用，测试表隔离沿现有fixture。

## 验收回传模板

1. 实际修改路径；2. 行为与未覆盖范围；3. 真实运行命令/退出码/测试数；4. 已知阻塞；5. 共享接口说明。主代理读取diff和关键文件，运行必要集成/类型，不仅复述子代理的成功声明。
