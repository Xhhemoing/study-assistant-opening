# BC1 P0 预算·费用契约 — 最小补丁（Accept-ready）

**Date:** 2026-10-09 ~23:54 CST (Asia/Shanghai)  
**Branch:** `feat/opening-release`（**未 commit / 未 push**）  
**Owner:** AIstudy AI  
**依据:** Integrator 决策（stable codes / 码→账本表 / overage cap+audit / operationId 中期）  
**tasks.json:** 未改（勿 mark verified）  
**Hermes:** 未重开（vision soft 另见 `hermes-vision-soft-readiness.md`）

## 决策落地表

| # | Integrator 决策 | 实现 |
|---|---|---|
| 1 | `amountCents<=0` → `BUDGET_INVALID_RESERVE`；provider 调用数=0 | `runBudgetedCall` 本地短路；`opening-budget.reserve` 同步改码（安全门禁保留） |
| 2 | 抽出 `ledgerActionForProviderError` + 单测锁表 | AUTH/RATE_LIMIT/MEDIA_UNSUPPORTED → release；REQUEST 默认 release，`requestSent:true` → markUnknown；UNAVAILABLE/timeout/… → markUnknown |
| 3 | overage：`actual > reserved` → **cap-to-reserved + audit**（非 markUnknown） | `settleCentsForActual` + 可选 `budget.noteOverage` |
| 4 | 重试占用：短期文档双占；中期 optional `operationId` | 无 operationId：测试锁双占；有 operationId：ledger 用其作 idempotency key 复用预留 |
| 5 | discovery `it.fails` → 正断言 | 已全部翻转 |

## 文件变更

| 文件 | 变更 |
|---|---|
| `apps/worker/src/runtime/budgeted-call.ts` | `BUDGET_INVALID_RESERVE` 前置；`ledgerActionForProviderError`；`settleCentsForActual`；overage audit hook；optional `operationId` |
| `apps/worker/src/runtime/budgeted-call.test.ts` | 表锁、overage、REQUEST release、operationId 复用、非法 reserve |
| `apps/worker/src/runtime/budget-contract-discovery.test.ts` | 四族正断言（原 4× `it.fails` 已消除） |
| `packages/database/src/repositories/opening-budget.ts` | `OpeningBudgetErrorCode` 增 `BUDGET_INVALID_RESERVE`；`amountCents<=0` 抛该码 |

**未改 contracts 公共 schema。** worker 侧 additive：`BudgetedCallOptions.operationId`、`BudgetedRepository.noteOverage?`。若提升为共享字段需 Integrator。

## 安全门禁（保留）

- 正数预留（`reservedCents` / `amountCents` > 0）
- 缺 usage → markUnknown（不以 0 结算）
- AUTH / RATE_LIMIT release
- settle 失败不 release
- budget_disabled / PROVIDER_DISABLED 零调用
- 禁止无策略 over-reserve booking（强制 cap 策略）

## 测试命令与结果

```text
node node_modules/vitest/vitest.mjs run --project unit \
  apps/worker/src/runtime/budget-contract-discovery.test.ts \
  apps/worker/src/runtime/budgeted-call.test.ts \
  packages/ai/src/opening/errors.test.ts \
  packages/ai/src/opening/usage.test.ts
→ Test Files  4 passed (4)
→ Tests       33 passed (33)
→ Duration    ~1.83s
```

## Contracts / Integrator 备注

1. **数据库错误码 additive：** `BUDGET_INVALID_RESERVE`（与既有 `BUDGET_EXCEEDED` 同族）。
2. **worker-only additive（未进 contracts）：**
   - `operationId?: string` — 同逻辑操作重试复用预留
   - `noteOverage?(audit)` — overage 审计钩子
3. 调用方（tutor-turn / ephemeral）暂未传 `operationId`；默认行为仍为按 `requestId` 独立预留（短期双占已测锁）。接线 operationId 为后续可选增强。

## Accept-ready

**是** — 四族补丁已落地，discovery 与回归单测全绿，门禁未删，无 commit/push，未改 tasks.json。
