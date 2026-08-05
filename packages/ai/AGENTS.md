# @aistudy/ai

AI 能力封装:模型提供者适配、角色定义与提示编排。所有 LLM 调用边界的所有者。

- 不改动公共 API 形状时保持向后兼容;provider 适配在 `src/providers`。
- 验证:`npm run typecheck -w @aistudy/ai` + `roles.test.ts`。
