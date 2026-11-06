# CI opening-retrieval AI contract fix — ACCEPT

**Date:** 2026-10-11 (Asia/Shanghai / CST)  
**Agent:** Integrator ACCEPT (executor)  
**Baseline tip HEAD:** `8ae33536e5193da7740ed41bd83491911697e1b2` (`feat/opening-release`)  
**Implement evidence:** `docs/superpowers/evidence/2026-10-11-opening-release/ci-opening-retrieval-ai-fix-implement.md`  
**Verdict:** **ACCEPT**  
**Constraints:** No commit / push / stash / reset / hermes. Did not touch `0053_*`.

## Scope under review

Align `tests/integration/opening-retrieval.test.ts` with accepted Package C (`selectContext` zero-score backfill) and Package D (`resolveCitations` soft default).

| Path | Role | Diff vs tip |
|---|---|---|
| `tests/integration/opening-retrieval.test.ts` | Integration expectations only | **6+/2−** (only file in this fix) |
| `packages/ai/src/opening/context.ts` | `selectContext` / `renderContext` / `fillBudget` | **unchanged** (0 bytes diff) |
| `packages/ai/src/opening/citations.ts` | `resolveCitations` soft/`{ soft: false }` | **unchanged** |
| `packages/ai/src/opening/context.test.ts` | Package C unit contract | **unchanged** |
| `packages/ai/src/opening/citations.test.ts` | Soft/strict citation unit contract | **unchanged** |

Other dirty trees on the branch (backup/learning, reminder delivery, V2-04 teaching, contracts) are **out of scope** for this accept and were not reviewed as part of the AI contract fix. `0053_opening_teaching_activities.sql` remains untracked; md5 `878e49c1bb366552121911a7f875e67c`; not modified by this accept.

## Verification matrix

| # | Check | Result | Evidence |
|---|---|---|---|
| 1 | Only intentional test-file change for this claim | **PASS** | `git diff HEAD --numstat -- tests/integration/opening-retrieval.test.ts` → `6 2`; AI opening production/unit paths 0-byte diff |
| 2 | Production `selectContext` / `renderContext` / `resolveCitations` untouched | **PASS** | No working-tree diff under `packages/ai/src/opening/{context,citations}.ts` |
| 3 | Package C: zero-score miss backfills (not `[]`) → 3 chunk texts | **PASS** | Quantum query expects `["Bayes theorem", "Selected material", "Unrelated filler"]`; matches `context.ts` miss path → usable + `fillBudget` + page/id order (pages 1→2→3) |
| 4 | Package D: soft default `[]`; `{ soft: false }` throws | **PASS** | Integration asserts `toEqual([])` then `toThrow(/unknown citation/)` with `{ soft: false }`; matches `citations.ts` `soft = options?.soft !== false` |
| 5 | Unit context+citations re-run | **PASS** | 2 files, **31 passed** (~481ms) |
| 6 | Integration suite | **SKIPPED** | `OPENING_TEST_DB` unset / no `OPENING_TEST_DATABASE_URL` (same as implement claim) |
| 7 | selectContext fallback semantics not changed by this PR | **PASS** | Production `context.ts` untouched; test only updated expectations |
| 8 | `0053_*` untouched | **PASS** | Accept wrote only this evidence md; migration file not edited |

## Diff summary (reviewed)

```diff
-    expect(selectContext({ ...options, query: "quantum" })).toEqual([]);
+    // Package C miss-fallback: non-blank query with all scores 0 and no preference → usable chunks via fillBudget (not []).
+    expect(selectContext({ ...options, query: "quantum" }).map((item) => item.text)).toEqual([
+      "Bayes theorem", "Selected material", "Unrelated filler",
+    ]);
-    expect(() => resolveCitations([injected.id], [])).toThrow(/unknown citation/);
+    expect(resolveCitations([injected.id], [])).toEqual([]);
+    expect(() => resolveCitations([injected.id], [], { soft: false })).toThrow(/unknown citation/);
```

## Tests re-run by Integrator

```text
node node_modules/vitest/vitest.mjs run --project unit \
  packages/ai/src/opening/context.test.ts \
  packages/ai/src/opening/citations.test.ts

Test Files  2 passed (2)
Tests       31 passed (31)
Duration    481ms
```

Integration `tests/integration/opening-retrieval.test.ts` not executed (needs `OPENING_TEST_DB=1` + DB URL).

## Hard-rules compliance

- No commit / push / stash / reset  
- No hermes  
- No modification of `0053_*`  
- No change to production selectContext fallback semantics  

## Verdict

**ACCEPT** — Integration test expectations match Package C zero-score backfill (3 chunks) and soft citations + strict `{ soft: false }`; production AI modules untouched; context+citations units 31/31 green; integration deferred on missing test DB.
