# @aistudy/contracts

TypeScript 契约层:共享请求/响应类型、领域对象与 API 边界。所有跨包数据形状的定义所有者。

- 变更先改这里,再改消费方;契约变更是破坏性变更,需同步更新测试。
- 验证:`npm run typecheck -w @aistudy/contracts`。
- 新增类型必须带对应 `*.test.ts` 或在 index 导出测试覆盖。
