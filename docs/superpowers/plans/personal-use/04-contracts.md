# Personal-use Shared Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Execute PU01 before parallel consumers; checkboxes do not certify execution.

**Goal:** 为接续、学习证据与恢复冻结唯一跨包契约，避免多个agent各自发明数据结构。

**Architecture:** 复用现有Scope、ConversationResume、ProblemRef、HelpExposure；新增严格Zod DTO。业务写入、模型调用和恢复事务仍属于对应lane，契约冻结不实现这些行为。

**Tech Stack:** TypeScript、Zod、Vitest、既有npm workspace。

## Global Constraints

- PU01由COORDINATOR单写，依赖PU00真实snapshotCommit。每个新改文件≤200行；只改必需契约，不重构整个contracts包。
- 命令使用pwsh，首行`$ErrorActionPreference = 'Stop'`；文本读写UTF8。保留既有public字段，危险输入资格由服务端验证；wire与授权不是同一层。
- 类型完整定义以本页指向的唯一子计划代码块为准；冻结时复核引用的是实际已存在类型，禁止复制出第二个互相漂移的定义。
- 向既有API增加字段须有兼容测试，旧consumer继续解析既有字段。严禁修改原43项任务状态来表示PU01完成。

## PU01：接口、导出、迁移预约与下游fixture冻结

**Owner:** COORDINATOR。**Files (Create):** `packages/contracts/src/opening/continuity.ts`、`continuity.test.ts`、`learning-evaluation.ts`、`learning-evaluation.test.ts`、`recovery.ts`、`recovery.test.ts`。
**Files (Modify):** `packages/contracts/src/opening/index.ts`、`packages/contracts/src/index.ts`；`learning.ts`只有必要兼容定义时修改；超长文件先提取新定义到新文件，旧导出保留。
**Planning-only follow-up:** 按PU00分配结果，协调者同步原opening总计划、09-connections/10-media-knowledge/interfaces中尚未落盘的迁移预约并验证；不得批量改已发布SQL。

| 契约 | 唯一定义与精确导出 | 消费者与约束 |
| --- | --- | --- |
| 接续只读投影 | `01-continuity.md`的ContinuityMaterial、ContinuityCheckpoint、OpeningContinuityRead；导出`continuityMaterialSchema`、`continuityCheckpointSchema`、`openingContinuityReadSchema` | PU02读取，PU03展示；不含signed URL、模型推理、正式掌握结论；confirmedNextStep固定null，完整R2c未因此完成 |
| 学习资格上下文 | `02-learning-value.md`的LearningEvidenceContext；导出`learningEvidenceContextSchema` | 仅服务端可信组装给PU04；ProblemRef/HelpExposure来自现有learning.ts，不能由浏览器声明referenceCheck |
| 评估记录 | 同文件的EvaluationCase、CaseReview、CaseResult、EvaluationReport、OfflineResponseFixture、PilotAttemptRecord、PersonalUsePilotEntry；对应小写首字母+Schema导出 | PU04/PU07使用；函数型EvaluationRunInput、domain SummarizeOptions及operator内部OperatorBudgetSnapshot/reader接口留PU04实现模块，不作为跨包wire schema；PilotAttemptRecord校验至少一个记录引用及时间先后 |
| 隐私检查点与恢复回执 | `03-reliability.md`的PrivacyCheckpoint、RecoveryReceipt；导出`privacyCheckpointSchema`、`recoveryReceiptSchema` | PU05/PU08使用；sha256是完整性校验，不能替代可信来源或owner授权 |

**结构不变量：** UUID复用foundation，时间为ISO字符串，数组/文本有上限；材料最多32，接续候选recent最多3，原问题截取最多280字符且标为用户原文；评估用例最多100、评估question≤20000、reference.text≤20000、reason≤2000；未知值用显式null/枚举，不以空字符串当成功。
**评估路径安全：** 合成fixture必须在`tests/fixtures/`或`tests/evaluation/`规范化根内；私有真实数据仅通过独立获准根读取；拒绝路径逃逸、重解析点、HTTP URL与任意环境展开。评估报告仅保存私有artifact相对引用，不把正文复制进普通日志。
**恢复安全：** checkpoint的sourceIds/memoryIds去重、合法UUID，epoch/version为非负安全整数，sha256为64位hex；未配置规模上限先拒绝超大输入而非无限装载。具体上限由PU05按既有backup size limit保持一致；参数变化有边界测试。

- [ ] 1. 从PU00 snapshotCommit读取所有消费方，确认上述真实现有类型和函数；将接口文件/版本/hash写入`.local/personal-use/contracts.json`的`contractRevision,baseSha,files[{path,sha256}]`，初始revision=1。
- [ ] 2. 先新增strict schema失败测试：拒绝伪confirmedNextStep、负版本、跨字段无参照的可信判定、未知status、非法UUID、恢复checkpoint污染字段。以合成完整对象测试，不用`as unknown as`掩盖缺字段。
```ts
import { expect, it } from 'vitest';
import { openingContinuityReadSchema } from './continuity';
it('accepts an empty read without invented learning state', () => {
  expect(openingContinuityReadSchema.parse({checkpoint:null,
    pendingSuggestions:{count:0,recent:[]}})).toEqual({checkpoint:null,
    pendingSuggestions:{count:0,recent:[]}});
});
it('rejects hidden user-state escalation', () => {
  expect(openingContinuityReadSchema.safeParse({checkpoint:null,
    pendingSuggestions:{count:0,recent:[]},mastered:true}).success).toBe(false);
});
```
- [ ] 3. 运行下方同一unit命令记录red，随后实现schema、导出与推导类型；不要在contracts读取DB、调用模型或塞入恢复实现。
- [ ] 4. 为learning-evaluation添加case/response/review ID不对应、版本缺失、manual≠pass和unknown费用的合法/非法夹具；ID集合一致性属于runner/domain测试，schema仅验证单条形状。
- [ ] 5. 为recovery添加epoch/journal倒退的domain消费用例，以及schema只能验证形状不能证明日志可信的测试；不将`parse()`成功当授权。
- [ ] 6. 跑contracts/index出口回归与下游类型检查；旧ConversationResume/SourceDownload/ObservationInput形状不被无必要改写。公共reference_checked的拒绝由PU04服务行为测试承担，不能只从schema删除字段掩盖问题。
- [ ] 7. 交付revision=1及三类合成fixture给各lane；同一schema文件任何后续变动先协调者升revision，再由受影响agent合并并重跑对应consumer测试。

```powershell
$ErrorActionPreference = 'Stop'
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/continuity.test.ts packages/contracts/src/opening/learning-evaluation.test.ts packages/contracts/src/opening/recovery.test.ts
if ($LASTEXITCODE -ne 0) { throw 'PU01 contract tests failed' }
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { throw 'PU01 contracts typecheck failed' }
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json --noEmit
if ($LASTEXITCODE -ne 0) { throw 'PU01 consumer typecheck failed' }
node scripts/validate-opening-plan.mjs
if ($LASTEXITCODE -ne 0) { throw 'Existing task/migration plan invalid' }
```

**验收：** 新schema的成功/失败夹具通过；旧公共契约兼容；唯一owner和revision已通知消费者；原任务图/预约无冲突。此处尚未验证UI、provider或恢复效果。
**回退：** 下游未发布时撤销新增契约提交；已有消费者时先停相应入口并一起回退consumer，避免返回无法解析的DTO；不删数据库数据。
