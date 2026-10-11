# GHA — opening-reminder-delivery planning-settings fixture — ACCEPT

**Date:** 2026-10-11 (Asia/Shanghai)  
**Agent:** Experience (accept)  
**Tip context:** local `8ae3353`; implement evidence at `gha-reminder-planning-settings-fixture-implement.md`  
**No commit / push / stash / reset / hermes**

## Verdict: ACCEPT

Data's root-cause and fix match the working tree for the reminder fixture path.

## Verification

### 1. Export / import of `DEFAULT_OPENING_PLANNING_SETTINGS`

| Check | Result |
| --- | --- |
| Defined in `@aistudy/contracts` (`packages/contracts/src/opening/planning-settings.ts`) | Yes — includes `weekOneMonday`, `periodTimes`, `dailyWindow`, `lunch`, `dinner`, `sleep`, `timeZone` |
| Re-exported from `@aistudy/database` (`packages/database/src/index.ts`) | Yes — `export { DEFAULT_OPENING_PLANNING_SETTINGS } from "@aistudy/contracts"` |
| Pre-fix HEAD database index | Did **not** export `DEFAULT_*` (only `createOpeningPlanningSettingsRepository`) — confirms the undefined-spread footgun from `ee1cced` |
| Runtime re-export | `fromContracts === fromDb` (same binding) |

### 2. Diff — fixture / reminder delivery + database index

`tests/integration/opening-reminder-delivery.test.ts`:

- Import moved from `@aistudy/database` → `@aistudy/contracts`.
- `.set(...)` uses explicit fields: `weekOneMonday`, `periodTimes`, `dailyWindow`, `lunch`, `dinner`, `sleep`, plus `timeZone: "UTC"` (preserves `ee1cced` UTC pin).

`packages/database/src/index.ts`:

- Adds the contracts re-export of `DEFAULT_OPENING_PLANNING_SETTINGS`.
- Note: same unstaged file also contains unrelated V2-04 teaching-activity exports; those are outside this fixture claim and were not used as accept criteria.

### 3. Schema parse of fixture object

`openingPlanningSettingsSchema.parse` of the explicit fixture object succeeds with `timeZone: "UTC"` and all required fields present.

### 4. Tests re-run

| Suite | Result |
| --- | --- |
| `npx vitest run packages/contracts/src/opening/planning-settings.test.ts --project unit` | **3 passed** |
| Zod/tsx fixture parse against `openingPlanningSettingsSchema` | **ok** |
| Integration `tests/integration/opening-reminder-delivery.test.ts` | **Skipped** — `OPENING_TEST_DB` and `REDIS_URL` unset in this environment |

### 5. Scope notes (claim honesty)

- **0053:** Fixture fix files do not edit `0053_*`. An untracked `0053_opening_teaching_activities.sql` exists from separate V2-04 work; not part of this accept.
- **opening-retrieval:** Not in Data's claimed fix files. A separate working-tree diff on `tests/integration/opening-retrieval.test.ts` updates Package C miss-fallback / soft-citation expectations (AI-scope); left out of this ACCEPT.

## Conclusion

Cause (missing database export → undefined spread) and fix (contracts import + explicit required fields + database re-export) are verified. Unit/contract coverage for planning settings passes; Redis/DB integration not re-run locally for lack of env.

**ACCEPT**
