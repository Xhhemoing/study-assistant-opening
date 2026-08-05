# @aistudy/web (Next.js App Router)

Web UI:页面、路由处理器与 `src/features/*` 功能模块。面向用户的变更主要发生在此。

- UI 用 Tailwind 工具类,图标用 lucide-react;不要新增原生 CSS 文件或内联 style。
- 客户端重定向与加载态必须验证:浏览器可见状态是可用的判定标准,HTTP 200 外壳不算成功。
- 验证:`npm run typecheck -w @aistudy/web`;行为变更需配套 `*.test.ts(x)` 或 `*.spec.ts`。
- 涉及工作区偏好/路由等 API 时,先确认 `.env` 配置完整再断言可用。
