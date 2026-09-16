# F02 opening contracts freeze → verified (2026-09-13)

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY (no GitHub).

## Acceptance checklist

| Plan item | Status |
|---|---|
| Create `packages/contracts/src/opening/{foundation,sources,jobs,tutor,memory,learning,planning,index}.ts` + `contracts.test.ts` | Done (+ `conversations.ts` for RU-02) |
| Grouped export from contracts package | Done |
| `interfaces.md` field/signature sync (incl. RU-02/03 page+resume, RU-04 learning helpers, RU-05/06 helpers) | Done |
| Zod `.strict()` inputs; UUID/ISO/bounds; temporary memory needs `expiresAt`; startPeriod≤endPeriod | Done |
| Fixtures/tests: traversal names, unknown fields, link/unlink, resume `historyTruncated`, page optional, independent gates, timeConfig version, memory scope helpers | Done |
| `vitest … packages/contracts/src/opening/contracts.test.ts` | **18 passed** (2026-09-13) |
| `npm run typecheck -w @aistudy/contracts` | **OK** |
| `validate-opening-plan.mjs` | **PASS** (27 tasks) |

## Commands

```
node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/contracts.test.ts
npm run typecheck -w @aistudy/contracts
node scripts/validate-opening-plan.mjs
```

## Not in F02 scope (explicit gaps / downstream)

- F01 still `planned` (separate task; F02 depends on B02 only)
- Handler/DB membership 422, WeekSession date invention rules, T02/M01 scope execution — documented in interfaces, not wire expansion
- Opening HTTP (tutor/sources) — T03 / materials blocker track, not F02 contracts

## Freeze artifacts

- `docs/superpowers/plans/opening-release/f02-source-membership-freeze.md`
- `docs/quality/opening-ru04-f02-contract-gaps.md` (G1–G5 合约已齐)
