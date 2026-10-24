# Web 类型检查分层

`npm run typecheck` 仍动态发现全部 workspace 与 E2E 配置；Web manifest 的
`aistudy.typecheck` 选择 `tsconfig.typecheck.json`，运行 TypeScript 5.8 的 build mode。
直接运行 `npm run typecheck -w @aistudy/web` 使用同一 solution。

- solution 的真实 references 指向两个**独立** noEmit/incremental 叶子：产品
  `tsconfig.json` 与 `tsconfig.tests.json`，分别写 `.cache/product.tsbuildinfo`、
  `.cache/tests.tsbuildinfo`（已有 `*.tsbuildinfo` 忽略规则）。不是用 `tsc -p`
  检查空 solution。`--stopBuildOnErrors` 保留失败退出码并停止后继叶子。
- 产品保留原 src/next-env/`.next/types/**/*.ts` 及完整原 exclude（包括原来就在
  产品检查里的 `.test.tsx`）。测试叶子检查 `.test.ts`、`.test.tsx` 与相同 Next
  生成类型，也补上此前排除的 `.test.ts`，没有删除旧检查输入。
  `.test.ts`/`.test.tsx` 同名时 TypeScript 根文件发现可能优先 `.ts`，因此不能
  直接把全部 `.test.tsx` 从产品排除；静态输入并集复核曾发现此操作漏掉两个文件，
  现保留产品原集合以避免弱化。测试与产品重叠是有意保留的限制。
- 所有原依赖包检查与根 E2E 检查原样保留。两个 Web 叶子的源码 paths 不变，
  跨包源码错误依然可检出，不靠旧声明或 `skipLibCheck` 隐藏源码错误。
- CI 的 quality / Worker recovery 作业设置 `NODE_OPTIONS=--max-old-space-size=6144`，
  原 Typecheck 与 Build 步骤不变；本地不强制此上限，不在共享 4GB VM 上使用 6GB。

## 有意保留的限制

这不是“产品消费测试/依赖声明”的全图 composite 改造：测试导入产品、产品导入
跨包源码时仍会在叶子内重复检查。solution references 只提供检查调度与各叶子的
增量缓存，不能宣称已实现声明隔离、冷检查时间/峰值内存改善或完全有界的传递图。
依赖包 manifest 的 `types`/`exports` 均指向 `src/*.ts`，基础配置关闭 declaration，
Web 使用源码别名；真正隔离需要另行设计跨包声明输出、rootDir/include 与运行时
入口，而不能简单加 composite 或把独立 noEmit 叶子互相引用。

Zod 静态排查确认 contracts/Web 广泛使用 `z.infer` 和 schema `.extend`（例如
`packages/contracts/src/practice-content.ts`、`exploration.ts`）；没有 trace 或
可归因的实例化性能数据，不能由出现次数认定根因。本切片不改 schema、不扩宽类型、
不引入 `any` 或删除校验。现有 1536MB Web 检查已能通过，不将旧 OOM 视为永久状态。
若后续仍有热点，受控单进程对旧/新 SHA 使用 `--extendedDiagnostics`、
`--generateTrace` 定位后再做最小修复。

## 验证

轻量配置解析与 `node scripts/typecheck.mjs --list` 可确认 CI 选择 solution。
`tests/tooling/typecheck-projects.test.mjs` 被现有 `tests/tooling/*.test.mjs` CI 命令覆盖：
验证动态推导/build 参数、旧输入集合包含性、真实小型 solution 的冷/暖检查、
测试类型错误、跨目录依赖错误和 Next generated types 错误；原 orchestrator
contract tests 继续验证并发、失败、超时与锁回收。

由主代理/CI 按共享主机重任务锁串行执行：

```sh
node scripts/run-heavy.mjs node --test tests/tooling/typecheck-projects.test.mjs
npm test -- --project contract tests/contract/typecheck-orchestrator.test.ts
npm run typecheck -w @aistudy/web
npm run typecheck
npm run build
```

首次新增测试叶子可能暴露原未检查的 `.test.ts` 错误，应修正真实类型，不移除叶子或
缩减 inputs。Next 生成类型存在时检查；干净 checkout 没有生成文件时，原 Next build
仍负责生成与再次类型检查。本切片未执行重类型/测试/build；不报告未执行检查通过。
