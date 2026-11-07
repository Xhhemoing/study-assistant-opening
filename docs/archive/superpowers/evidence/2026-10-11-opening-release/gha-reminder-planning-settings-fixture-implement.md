# GHA — opening-reminder-delivery planning-settings fixture

**Date:** 2026-10-11 (Asia/Shanghai)  
**Agent:** AIstudy Data  
**Tip at work:** `8ae3353` (local; GHA fail was tip `aa3f81b` run 38105066698)  
**No push / no hermes / no 0053 edits**

## Root cause
`tests/integration/opening-reminder-delivery.test.ts` imported `DEFAULT_OPENING_PLANNING_SETTINGS` from `@aistudy/database`, but database **did not export** that symbol. At runtime it was `undefined`, so:

```ts
{ ...DEFAULT_OPENING_PLANNING_SETTINGS, timeZone: "UTC" } // → { timeZone: "UTC" }
```

Zod then reported missing `weekOneMonday` / `periodTimes` / `dailyWindow` / `lunch` / `dinner` / `sleep`.

## Fix
1. Import `DEFAULT_OPENING_PLANNING_SETTINGS` from `@aistudy/contracts`.
2. Pass explicit required fields in `.set(...)` (plus `timeZone: "UTC"`).
3. Re-export `DEFAULT_OPENING_PLANNING_SETTINGS` from `packages/database/src/index.ts` to prevent the footgun.

## opening-retrieval.test.ts
GHA also failed `selectContext(... query: "quantum")` expecting `[]` but receiving all stored chunks, and `resolveCitations` not throwing.

Current `@aistudy/ai` `selectContext` (Package C honesty) **falls back to usable chunks when every query score is 0**. That is AI behavior, not a Data fixture/schema gap. **Out of Data fix scope** — needs PM → AI (or Experience) to update test expectations or ranking policy.

## Verification
```text
npx vitest run packages/contracts/src/opening/planning-settings.test.ts --project unit  # 3 passed
tsx parse of fixture object against openingPlanningSettingsSchema  # ok
```
Full Redis-backed `opening-reminder-delivery` integration test not re-run here (needs OPENING_TEST_DB/REDIS_URL in CI).

## Files
- `tests/integration/opening-reminder-delivery.test.ts`
- `packages/database/src/index.ts`
