# CI opening-retrieval AI contract fix (implement)

**Date:** 2026-10-11 (Asia/Shanghai)  
**Branch:** `feat/opening-release` (tip ~`8ae3353`)  
**GHA:** 38105066698  
**Scope:** align integration expectations with accepted Package C / Package D contracts.

## Root cause

`tests/integration/opening-retrieval.test.ts` still asserted pre-contract behavior:

1. **Package C (`selectContext`):** `query: "quantum"` with all lexical scores 0 and no preference expected `[]`. Accepted contract falls back to usable chunks + `fillBudget` (deterministic order by `sourceId` / `page` / `id`), same as unit test “falls back to deterministic budget-fill when the query has no lexical match”.
2. **Package D (`resolveCitations`):** injected id with empty authorized chunks expected a throw. Accepted default is soft-filter (`[]`); strict throw requires `{ soft: false }`.

## Contract alignment

- Quantum miss → expect `["Bayes theorem", "Selected material", "Unrelated filler"]` with a one-line Package C miss-fallback comment.
- Soft default: `expect(resolveCitations([injected.id], [])).toEqual([]);`
- Strict: `expect(() => resolveCitations([injected.id], [], { soft: false })).toThrow(/unknown citation/);`
- Unchanged: Bayes match, preferPage/preferChunkId, empty input, maxCharacters 5 drops oversized injected, `renderContext` UNTRUSTED.

## Files touched

- **Edited only:** `tests/integration/opening-retrieval.test.ts`
- **Not edited:** Data V2-04 dirty trees under `packages/database`, `packages/contracts`, `packages/domain`, migrations, `tasks.json`
- **No** git commit / push / stash / reset / hermes

## Commands run

```bash
node node_modules/vitest/vitest.mjs run --project unit \
  packages/ai/src/opening/context.test.ts \
  packages/ai/src/opening/citations.test.ts
```

**Result:** 2 files passed, 31 tests passed (~503ms). Integration suite not re-run here (needs `OPENING_TEST_DB=1` + DB URL).

## Diff summary (test file)

- + Package C comment + quantum expectation maps to 3 chunk texts (was `toEqual([])`).
- Soft `resolveCitations` empty-array assert; strict `{ soft: false }` throw retained.
- Net: 6 insertions, 2 deletions on that file only.
