# @aistudy/domain

纯领域逻辑:评估、规划、搜索等无副作用规则。禁止在此包引入 HTTP/DB 依赖。

- 保持纯函数与类型化领域对象;依赖注入由外层完成。
- 验证:`npm run typecheck -w @aistudy/domain` + 对应 `*.test.ts`。
