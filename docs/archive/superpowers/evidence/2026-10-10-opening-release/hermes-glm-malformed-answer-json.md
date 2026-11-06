# Hermes: Lant/glm-5.3 malformed answer JSON

**Job:** `3d31a597-…` · **Symptom:** `provider returned malformed answer JSON`; reserved budget not settled to an answer turn.

## Root cause

`packages/ai/src/opening/provider.ts` `parseOutput` did a bare `JSON.parse` on `choices[0].message.content`. Lant/`glm-5.3` commonly returns non-strict payloads (```json fences, leading/trailing prose, or plain text). Parse threw `PROVIDER_RESPONSE` before a structured answer existed, so the tutor turn failed and BC1 `runBudgetedCall` took the `markUnknown` path for that code (reservation left unsettled from the user-facing "no answer" perspective).

## Fix (minimal, answer-parse only)

In `parseAnswerContent` / `parseOutput`:

1. Trim + strip markdown ``` / ```json fences.
2. On `JSON.parse` failure, extract first `{` … last `}` (same pattern as `build-course-knowledge.ts`).
3. If still unparsable but content is non-empty → degrade to `{ text, citedChunkIds: [], candidates: [] }` so the user still gets a reply and budget can settle on success.
4. Empty content still throws `provider returned malformed answer JSON`. Invalid structured objects (bad UUIDs / candidates / injected keys) still rejected — no provenance fabrication. Did **not** edit `budgeted-call` / BC1.

## Verification

`npx vitest run packages/ai/src/opening/provider.test.ts` → **18 passed** (strict JSON, fences, glm-style prose wrappers, plain-text degrade, empty reject, prior safety cases).

**Accept-ready:** yes (Integrator). No commit/push from this executor.
