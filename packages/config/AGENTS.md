# @aistudy/config

环境配置与运行时配置校验。环境变量定义与默认值的所有者。

- 新增环境变量必须同时更新 `.env.example` 与 `env.test.ts`。
- 验证:`npm run typecheck -w @aistudy/config` + `env.test.ts`。
