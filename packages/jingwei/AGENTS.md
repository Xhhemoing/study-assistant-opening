# @aistudy/jingwei

经纬：宿主无关的自适应表达核心。经 = 成果内容与修订（不随视图变化），纬 = 文字/静态/交互等呈现方式。

- 只依赖 `zod`。不得 import `@aistudy/*` 其他包、React、Next 或 Node 内置模块；教学、笔记、对话等概念留在宿主适配层（`boundary.test.ts` 守住）。
- 模型输出、持久化 JSON、外部 Agent 输入都是信任边界：经 `parseArtifact` / `decideBlock` 后才能渲染。核心不提供 `eval`、原始 HTML 或写权限；动作只以 intent 交给宿主。
- 显示偏好只改视图，不改内容和 `revision`；内容修改走 `reviseArtifact`。
- 验证：`npx vitest run --project unit packages/jingwei` 与 `npm run typecheck -w @aistudy/jingwei`。
