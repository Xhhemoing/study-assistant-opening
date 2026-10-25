# PR-C：Explore 1–2A（默认关闭）

## 本切片边界

基于 UI v5 / PR-A `1b8507d2`，仅应用 `d30188a6..49868690` 的 Explore 源码增量；现有 UI 文件按 patch 合并，未整文件覆盖导航、助理全页及产出/记忆栏。不引入 `a038f2b2` 后续内容。

- 阶段 1：隔离的固定示例课、连续会话/原草稿回归。
- 阶段 2A：材料固定版本/物理页的原文片段预览、课堂可见选区预览、调用方显式映射的概念锚点、只读上下文审阅。真实材料预览不是纯读取：服务端验证后发放 exposure receipt；不自动确认已读/掌握。
- **阶段 3–4 冻结**：没有 self-explanation draft/panel、StudyContextTools 新 tab、自述解释评分、自动学习记录或阶段 3–4 调用。也不包含 `conversation-branch-context` 持久分支准备、持久支线或多引用写入。
- 概念锚点只是显式候选映射的渲染能力，不声称自动知识图谱标注完成。

## 单一配置所有者与回滚

`packages/config/src/registry.ts` 定义 `OPENING_EXPLORE_PREVIEW`，缺省 OFF；只在受控试用时设 `1`（也接受现有布尔解析器支持的 true）。不新增 `NEXT_PUBLIC_*`；统一通过现有 `/api/opening/capabilities` → `OpeningCapabilitiesProvider` → `useOpeningCapabilities().explorePreview` 展示。未收到有效 capabilities、匿名用户均关闭。

服务端每次请求重新读取原开关，客户端不是授权依据：

- API `/api/opening/concepts/preview`：未设置或 OFF 时返回 403 / `Cache-Control: no-store`，在 scope、正文解析、service/repository 与 exposure 写入前拒绝。ON 仍走原认证/CSRF scope 和材料 owner/version/manifest/open-attempt 裁决。
- `/demo/learning`：强制动态，未设置或 OFF 时 `notFound()`；ON 保留 AuthGate。不把构建期的值当运行时权限。
- OFF 不挂载材料概念预览、不发 preview 请求，不显示课堂片段、概念锚点或 readiness demo 链接；助理不挂载 ContextReview，恢复原提问背景、帮助范围、返回原内容、选区文字与诊断。已有问选中内容/做卡片、隐藏答案选区拒绝、原题帮助保护保留。
- 旧标签页若仍显示旧 ON UI，API 也在服务端关闭后拒绝；客户端不会凭旧 capabilities 绕过授权。

回滚先将开关设为 0 并按既有受管部署流程重启 Web；不要删除 exposure、原答或 B 分类数据。C 无 migration，不操作生产配置。

## B 依赖：不能跳过

C repository 依赖 PR-B 的 `materialPageRole`、`readMaterialManifest`、source/version manifest 与 revision 字段，以及 B 的 study-context/实际 exposure 隔离链。接口以 `dd92c69d` 为参照，本次未复制/修改 B 文件。database public index **只增加** concept repository export，不删除/替换 B exports。主代理须先整合 B，再做 C API/DB/类型验收；单独 A+C 不可当成可发布构建，flag OFF 也不能消除静态依赖。

## 2026-10-25 收尾验证（优先于下方早期记录）

- 当前 C 分支已经接入 B 的精确提交 `f2043303`，没有复制 B 文件或更改其迁移；相对 B 的差异仍仅为 Explore 1–2A 与其验证。默认 OFF 与阶段 3–4 冻结不变。
- 首批定向 unit：20 文件 227 项，224 通过、3 失败；失败集中在旧 `SelectionAsk` 手工 hook 夹具把所有 `useContext` 返回 null。生产 capabilities 有非空 CLOSED 默认，修复测试为明确 OFF，不改产品空值语义。修后原失败文件与 ON/OFF 相邻课堂预览 2 文件 10 项通过；独立 demo 3 文件 10 项通过（批次重叠，不求和）。
- 原生隔离 PG：`opening-concept-preview.test.ts` 11 项通过，含 unset/OFF 无 exposure、ON 跨 owner 不披露、固定版本/manifest/原题保护、单连接不死锁及回放冲突；旧客户端 ON→OFF 拒绝另由 route 单元覆盖。
- Config、Database 类型通过。Web 初次类型发现新增测试中 7 处 mock-call 数组可能为空，修为显式存在校验或仍会断言失败的可选读取；2 文件 19 项复查、最终完整 Web 类型与三文件 lint 均通过，不使用 any/ts-ignore 或排除文件。
- 环境示例一致性通过。上述为非浏览器行为/SQL/语义类型证据，不是浏览器、真实模型或部署验收。准备推送本切片和 draft PR，完整 CI 仍需精确新 head；未合并/部署。

## 本地实际检查（早期历史）

- `git diff --check` 通过；env examples 重新从 registry 生成，`node --import tsx scripts/env-examples.ts --check` 通过。
- 轻量 unit：env 19、LearningProse 概念 11、demo route 4 通过；reader 5、课堂片段 6、readiness 17 通过。仅为定向单元，不代表 API/SQL/类型/浏览器验收。
- API route unit 加载失败：C 当前树未合入 B，`opening-material-manifest` 模块缺失。未用替身掩盖包依赖，待 B 合入重跑。
- 助理 OFF/ON 帮助范围回归第一次因新增测试夹具错误携入不在 attempt.sourceIds 内的 source，触发原预检而无后续按钮；已移除该不合法 source，保留背景/诊断/返回入口及 purpose 断言。修正后第一次重跑在共享主机 75 秒超时；后续使用 150 秒进程上限定向验证，实际 31.09 秒完成，8 项全部通过（包括 Explore OFF/ON 帮助范围与请求身份、背景、诊断、返回入口）。
- 最终改动 41 个 TS/TSX 文件经 TypeScript `transpileModule` 语法检查 0 错误；此项不是语义类型检查。
- 首次 `npm run env:examples` 中 tsx CLI 超时；直接 Node loader 成功，后续命令使用 `node --import tsx`。没有继续盲目重试 CLI。
- 未运行重类型、全仓、PG 集成、build、浏览器或真实模型；未 commit/push/部署。浏览器待用户。

## 主代理验收命令（B 整合后，按共享主机执行约束串行）

```sh
node --import tsx scripts/env-examples.ts --check
node node_modules/vitest/vitest.mjs run --project unit packages/config/src/env.test.ts packages/config/src/server-config.test.ts apps/web/src/app/api/opening/concepts/preview/route.test.ts apps/web/src/app/demo/learning/page.test.tsx --maxWorkers 1
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/concepts apps/web/src/features/opening/demo apps/web/src/features/opening/assistant/learning-prose-concepts.test.tsx apps/web/src/features/opening/assistant/context-review.test.tsx apps/web/src/features/opening/inbox/source-reader-preview.test.tsx apps/web/src/features/opening/teaching/lesson-concept-preview.test.tsx apps/web/src/features/opening/teaching/selection-ask.test.ts apps/web/src/features/opening/assistant/ai-readiness.test.ts --maxWorkers 1
node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/assistant/assistant-intent-interaction.test.tsx apps/web/src/features/opening/assistant/assistant-drawer.test.tsx apps/web/src/features/opening/assistant/assistant-session.test.tsx apps/web/src/features/opening/assistant/conversation-companion.test.tsx --maxWorkers 1
# 已准备原生 PostgreSQL 与迁移，并确认 B tests/fixtures 接口后：
npm run test:integration -- tests/integration/opening-concept-preview.test.ts
npm run typecheck -w @aistudy/config
npm run typecheck -w @aistudy/database
npm run typecheck -w @aistudy/web
```

新增授权回归覆盖 unset/OFF 403、no-store、scope/service 零调用、ON→OFF 旧客户端；SQL 用例检查 OFF exposure 数量不变、ON 跨 owner 不披露；原有固定版本、manifest restriction、open attempt、伪造选区、回放冲突回归保留。demo route 单元覆盖 unset/OFF 404 与 ON AuthGate。

用户浏览器验收：未设置/OFF 下直接访问 demo 得 404，材料/课堂选区只有原问 AI/做卡片入口，原题仍需先存原答；助理带选区/题目时原背景、帮助范围和返回原内容可用，开启 diagnostics 后可见诊断。ON 下进入 `/demo/learning` 验固定例不调用模型；材料选区显式打开预览再继续问，保留原草稿/版本/页；切回 OFF 后旧页面直接调用 API 应 403。保留 UI v5 助理全页产出与记忆栏、导航和会话恢复。
