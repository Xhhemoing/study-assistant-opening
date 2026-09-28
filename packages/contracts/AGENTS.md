# @aistudy/contracts

TypeScript 契约层:共享请求/响应类型、领域对象与 API 边界。所有跨包数据形状的定义所有者。

- 共享数据形状先改这里,再同步受影响消费方;仅不兼容变更按破坏性变更处理,兼容新增不额外冻结契约或建立发布流程。
- 验证:`npm run typecheck -w @aistudy/contracts`。
- 运行时 schema/解析行为变化覆盖有效输入和相关拒绝路径;纯 TypeScript 类型/导出变更用类型检查及受影响消费方编译验证,不新增仅断言导出存在的测试。
