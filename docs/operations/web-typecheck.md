# Web 类型检查分层

`npm run typecheck` 仍动态发现全部 workspace 与 E2E 配置；Web manifest 的
`aistudy.typecheck.projects` 依次选择 `tsconfig.json`、`tsconfig.tests.json`，
各运行 `tsc -p <叶子> --noEmit`。直接运行 `npm run typecheck -w @aistudy/web`
也按相同顺序检查，任一失败即返回非零退出码。

- 两个独立 noEmit/incremental 叶子分别写 `.cache/product.tsbuildinfo`、
  `.cache/tests.tsbuildinfo`（已有 `*.tsbuildinfo` 忽略规则）。
- 产品保留原 src/next-env/`.next/types/**/*.ts` 及完整原 exclude（包括原来就在
  产品检查里的 `.test.tsx`）。测试叶子检查 `.test.ts`、`.test.tsx` 与相同 Next
  生成类型，也补上此前排除的 `.test.ts`，没有删除旧检查输入。
  `.test.ts`/`.test.tsx` 同名时 TypeScript 根文件发现可能优先 `.ts`，因此不能
  直接把全部 `.test.tsx` 从产品排除；保留产品原集合以避免弱化。
  测试与产品重叠是有意保留的限制。
- 所有原依赖包检查与根 E2E 检查原样保留。两个 Web 叶子的源码 paths 不变，
  跨包源码错误依然可检出，不靠旧声明或 `skipLibCheck` 隐藏源码错误。
- CI 的 quality / Worker recovery 作业设置 `NODE_OPTIONS=--max-old-space-size=6144`，
  原 Typecheck 与 Build 步骤保留；本地不强制此上限。

## 弃用 build mode 的原因

TypeScript 5.8.3 的 `tsc -b` 热缓存检查可按根文件时间戳认定项目 up to date：
当只修改经 paths 导入的非根依赖源码时，即使引入 TS2322，也可能返回 0。
`--force` 能发现错误，但放弃了增量收益。因此删除空 solution 与 build-mode
调度，改用普通 `tsc -p` 的 incremental 检查；它比较程序内导入源码的版本，
回归测试覆盖两个缓存均已预热后仅修改非根依赖文件的情况，要求失败退出。

## 有意保留的限制

这不是“产品消费测试/依赖声明”的全图 composite 改造：测试导入产品、产品导入
跨包源码时仍会在叶子内重复检查。分层只提供独立检查输入与各叶子的增量缓存，
不能宣称已实现声明隔离、冷检查时间/峰值内存改善或完全有界的传递图。
依赖包 manifest 的 `types`/`exports` 指向源码，基础配置关闭 declaration，
Web 使用源码别名；真正隔离需要另行设计跨包声明输出、rootDir/include 与运行时
入口，不能简单加 composite 或把独立 noEmit 叶子互相引用。

Zod 的 `z.infer` 和 schema `.extend` 出现次数不能证明性能根因。
没有 trace 或可归因的实例化性能数据时，不改 schema、不扩宽类型、不引入 `any`
或删除校验。后续热点应通过受控单进程的 `--extendedDiagnostics`、
`--generateTrace` 定位后再做最小修复。本切片不声称耗时或内存收益。

## 验证

轻量配置解析与 `node scripts/typecheck.mjs --list` 可确认两个 Web 叶子和原全部
workspace/E2E 项目。`tests/tooling/typecheck-projects.test.mjs` 被现有 tooling CI
覆盖：验证动态推导/project 参数、旧输入集合包含性、真实小型双叶子的冷/暖检查、
测试类型错误、热缓存非根依赖错误和 Next generated types 错误，以及修复后恢复。
原 orchestrator contract tests 保留并发、失败、超时与锁回收检查。

本地定向验证（共享主机重任务锁串行执行）：

```sh
HERMES_HEAVY_LOCK_TIMEOUT=2400 node scripts/run-heavy.mjs node --test tests/tooling/typecheck-projects.test.mjs
HERMES_HEAVY_LOCK_TIMEOUT=2400 node scripts/run-heavy.mjs npx vitest run --project contract tests/contract/typecheck-orchestrator.test.ts
```

完整仓库检查与构建交现有 CI，本地定向测试不能替代其结果。
首次新增测试叶子可能暴露原未检查的 `.test.ts` 错误，应修正真实类型，不移除叶子或
缩减 inputs。Next 生成类型存在时检查；干净 checkout 没有生成文件时，原 Next build
仍负责生成与再次类型检查。

### 2026-10-25 新增覆盖收尾

首次 CI `40129160892` 在新测试叶子发现既有夹具类型错误；已补齐真实接口/记录字段、
mock 方法签名、数组存在性与判别联合收窄，不排除测试或加入 any/ts-ignore。
两处生产签名仅声明实际依赖（assessment 的 learningEvents、access-policy 的环境字段），
授权及运行逻辑不变。最终本地 `npm run typecheck -w @aistudy/web` 的产品和测试叶子均
退出 0；49 文件 623 项近测、修改路径 lint 通过，最后 exam fixture 调整另有 9 项复查
（批次重叠，不相加）。独立静态复审未发现 P1/P2。新提交仍等待自己的完整 CI，
不能用旧 head 的 Worker/PDF 成功代替；没有本地浏览器、真实模型、合并或部署验收。
