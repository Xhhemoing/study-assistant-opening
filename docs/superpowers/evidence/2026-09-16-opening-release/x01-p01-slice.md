# X01 capability contracts / P01 timetable slice evidence — 2026-09-16

Repo: `E:/Project/study-assistant-opening`; branch `feat/opening-release`. LOCAL-ONLY.
Executed by `xhh/gpt-5.6-luna-fast` subagent runs (`mu3oaw29-69aaebe3` X01; P01 runs `mu3oaw28-e25f5736`/`mu3pgrhi-7c12d032`/`mu3pje6j-32d11b5f` failed with connection errors — xhh origin returned HTTP 526, lead finished the P01 slice directly).

## 1) X01 — verified

Delivered: `packages/contracts/src/opening/{connections,imports,media,knowledge,proactive}.ts`, additive `sources.ts`/`index.ts`, `capabilities.test.ts`, adoption report `docs/quality/opening-x01-library-adoption.md`.

Lead re-verification after fixing an eslint `no-control-regex` in `sources.ts` (NUL check rewritten without control-char regex):

```text
$ node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening/capabilities.test.ts packages/contracts/src/opening/contracts.test.ts
Test Files  2 passed (2)   Tests  23 passed (23)
$ node node_modules/vitest/vitest.mjs run --project unit packages/contracts/src/opening packages/domain/src/opening
Test Files  6 passed (6)   Tests  64 passed (64)
$ npm --script-shell=... run typecheck -w @aistudy/contracts
CONTRACTS_TC_EXIT=0
$ npx eslint packages/domain/src/opening packages/contracts/src/opening
LINT_CLEAN
```

Registry artifacts (metadata only, NOT installed/runtime-verified): `imapflow 2.0.5` MIT Node>=20; `mailparser 3.9.28` MIT Node>=20. EmailEngine not introduced. `apps/worker/package.json`/lockfile intentionally untouched — version pinning is the INTEGRATOR's change, gated before C02.

## 2) P01 — slice 1 of 2 (active, not verified)

Delivered: `packages/domain/src/opening/timetable.ts` + tests (dedup UX12, weekday 1..7, sorted unique weeks, start<=end, HH:mm validation, actionable missing weekOneMonday/periodTimes errors, DST nonexistent AND ambiguous rejection, Saturday/split-week coverage), additive `packages/domain/src/index.ts` export.

```text
$ node node_modules/vitest/vitest.mjs run --project unit packages/domain/src/opening
Test Files  4 passed (4)   Tests  41 passed (41)
$ npx tsc -p packages/domain/tsconfig.json --noEmit
DOMAIN_TSC_CLEAN
```

Deferred (§P01 item 2): `xlsx-reader.ts` + synthetic fixture need an INTEGRATOR-approved pinned xlsx parsing dependency (package.json/lockfile changes are INTEGRATOR-owned); P01 → verified only after that slice plus its tests. No fabricated calendar dates committed.
