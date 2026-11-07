# ACCEPT: Hermes GLM malformed answer JSON (`parseOutput`)

**Date:** 2026-10-10 (Asia/Shanghai) · **Branch:** `feat/opening-release` · **Repo:** `study-assistant-opening`

## Verdict: **ACCEPT**

## Diff scope reviewed

- `packages/ai/src/opening/provider.ts` — bare `JSON.parse` in `parseOutput` replaced by `parseAnswerContent` (trim + strip ```/```json fences → try parse → first `{`…last `}` extract → non-empty plain text wrap `{ text, citedChunkIds: [], candidates: [] }`; empty still throws `PROVIDER_RESPONSE`).
- `packages/ai/src/opening/provider.test.ts` — added strict / fence / glm-wrapper / plain-text degrade / empty-reject cases; removed `"unstructured answer"` from the hard-fail table (now degrades).
- Evidence: `hermes-glm-malformed-answer-json.md` (+ this accept).
- **Not in this commit:** `budgeted-call` / BC1, TZ01, Q03, egg-info.

## Reject gates (none tripped)

| Gate | Result |
|------|--------|
| Still bare `JSON.parse` only on content | **PASS** — `parseOutput` calls `parseAnswerContent`; no bare content parse |
| Regresses valid JSON | **PASS** — “parses strict JSON content unchanged” + prior structured cases |

## Tests

`npx vitest run packages/ai/src/opening/provider.test.ts` → **18 passed** (2026-10-10 ~00:11 CST).

## BC1 / reserved budget on hard parse failure (PM confirm)

**Hard parse failure does NOT release reserved.** It still throws `OpeningProviderError` with code `PROVIDER_RESPONSE`, and BC1 `ledgerActionForProviderError("PROVIDER_RESPONSE")` → **`markUnknown`** (not `release`). See `apps/worker/src/runtime/budgeted-call.ts` cases `PROVIDER_RESPONSE` / default → `markUnknown`. This slice does **not** change `budgeted-call`; successful tolerate/degrade paths can settle on success as before.

| Path | Ledger action |
|------|----------------|
| Empty / still-unusable content → `PROVIDER_RESPONSE` | **markUnknown** (reservation left unknown; not released) |
| Fence / extract / plain-text degrade succeeds | settle on success (unchanged) |
| AUTH / RATE_LIMIT / MEDIA_UNSUPPORTED | release (unchanged; N/A to this parse path) |

## Accept-ready for commit+push

Yes. Message: `fix(ai): tolerate malformed GLM answer JSON in parseOutput`
