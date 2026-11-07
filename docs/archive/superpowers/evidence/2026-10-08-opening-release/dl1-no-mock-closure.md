# DL1 Opening entry no-Mock closure verified

- `apps/web/src/middleware.ts`: `LEGACY_OPENING_REDIRECTS` 扩展为前缀规则——`/learn/review*`、`/learn/practice*`、`/learn/goals*`、`/learn/exams*`、`/learn/marketplace*` 在 opening 模式重定向到 `/opening/today`；`/learn/courses*` 保持不重定向（既有测试断言保留）。
- `opening-shell.tsx`: 顶栏移除指向 `/learn/review` 的"复习卡片"链接及 `Layers` 图标导入；`/opening/cards` 入口待 DL4。
- `course-detail.tsx`: opening 分支不再调用 `useStudyProvider`，移除目标区与指导模式区；legacy 分支拆为 `LegacyCourseDetail` 子组件，经 `loadLegacyStudyProvider()`（`lib/data/react.ts` 新增 `createLegacyStudyProvider`）运行时动态加载，使 opening 入口的静态可达链不再触及 mock 模块。旧平台行为不变。
- `course-study-actions.tsx`: `goalCount` 改为可选，opening 模式只显示材料数。
- `goal-presentation.ts`（新增）：从 `goal-model.ts` 移出 `GOAL_SCENARIOS`/`scenarioLabel`/`formatExamDate`/`goalPath`，避免 opening 可达链引入 goals 模块；`goal-model.ts` 改为 re-export。
- `tests/contract/opening-no-mock.test.ts` 重写：从 `apps/web/src/app/(opening)` 页面入口出发沿相对与 `@/` import 递归收集可达文件（含 `import(...)` 动态导入、跳过注释参数），禁止命中 `lib/data/mock`、`createMockProvider`、`lib/data/react`；断言扫描覆盖 `course-detail.tsx` 且不包含 `lib/data/react.ts`。该扫描在实现前按预期因 `course-detail.tsx` 失败（红→绿）。
- `tests/e2e/opening-release-redirects.spec.ts` 仅补充重定向路径清单，未运行（浏览器验收归用户）。

## Verification

- `node node_modules/vitest/vitest.mjs run --project unit apps/web/src/features/opening/access-middleware.test.ts apps/web/src/features/opening/shell/navigation.test.ts apps/web/src/features/courses/course-study-actions.test.ts apps/web/src/features/goals/goal-model.test.ts` — 4 files, 33 tests passed.
- `node node_modules/vitest/vitest.mjs run --project contract tests/contract/opening-no-mock.test.ts` — 2 tests passed.
- `node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit` — passed（本机无 bash，替代 `npm run typecheck -w @aistudy/web`，见 13-daily-loop-gaps.md 全局约束）。
- 定向 ESLint（7 个改动文件）— passed.

## 待用户浏览器验收

- opening 模式访问 `/learn/review`、`/learn/practice/x`、`/learn/goals`、`/learn/goals/new`、`/learn/exams`、`/learn/marketplace` 应 307 到 `/opening/today`；`/learn/courses/123` 不重定向。
- 顶栏不再出现"复习卡片"链接；`/opening/courses/[id]` 不再显示目标区与指导模式区。
