# @aistudy/web (Next.js App Router)

Web UI:页面、路由处理器与 `src/features/*` 功能模块。面向用户的变更主要发生在此。

- UI 用 Tailwind 工具类,图标用 lucide-react;不要新增原生 CSS 文件或内联 style。
- 客户端重定向与加载态的浏览器验收由用户负责:浏览器可见状态是可用的判定标准,HTTP 200 外壳不算成功。遵循根目录 `AGENTS.md` 的浏览器验收分工;Agent 提供验收步骤,未获反馈标记“待用户浏览器验收”,不自行运行浏览器,也不因此阻塞后续开发。
- 验证:`npm run typecheck -w @aistudy/web`;行为变更需配套 `*.test.ts(x)` 或 `*.spec.ts`。
- 涉及工作区偏好/路由等 API 时,先确认 `.env` 配置完整再断言可用。
