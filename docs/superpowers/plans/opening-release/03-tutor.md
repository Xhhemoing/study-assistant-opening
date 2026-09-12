# Tutor and Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; no paid call without configured budget authorization.

**Goal:** Deliver real material-grounded tutoring with bounded cost and recoverable conversations.
**Architecture:** One model adapter boundary; program-owned citations and budgets; saved conversations processed by durable jobs.
**Tech Stack:** TypeScript, server-side fetch, existing AI role policies, PostgreSQL, BullMQ.

## Global Constraints

Provider bodies are untrusted. No arbitrary tool execution. Hidden prompts, credentials, source text and signed object URLs are excluded from ordinary logs. Default daily limit is zero; fake provider is test-only.

### T01: Model adapter, budget reservation and usage ledger

**Owner:** AI. **Depends:** F03.
**Create:** `packages/ai/src/opening/provider.ts`, `packages/ai/src/opening/provider.test.ts`, `packages/ai/src/opening/errors.ts`, `packages/ai/src/opening/usage.ts`, `packages/ai/src/opening/usage.test.ts`, `apps/worker/src/runtime/budgeted-call.ts`, `tests/integration/opening-budget.test.ts`.
**Modify:** `packages/ai/src/index.ts`, `packages/config/src/env.ts` (INTEGRATOR merges config changes).
**Interfaces:** `createOpeningProvider({baseUrl,apiKey,model,fetchImpl}): {complete(input:ProviderInput):Promise<ProviderOutput>}`; `classifyProviderFailure(status:number):{retryable:boolean;code:string}`; ledger `reserve(scope,{requestKey,jobId:null|string,maxCents})`, `settle(reservationId,usage)`, `markUnknown(reservationId)`.

- [ ] Add failing tests:
```ts
import { expect, it } from 'vitest';
import { classifyProviderFailure } from './errors';
it('never blindly retries authentication errors', () => {
  expect(classifyProviderFailure(401)).toEqual({retryable:false,code:'PROVIDER_AUTH'});
  expect(classifyProviderFailure(429).code).toBe('PROVIDER_RATE_LIMIT');
});
```
- [ ] Run `node node_modules/vitest/vitest.mjs run --project unit packages/ai/src/opening/provider.test.ts packages/ai/src/opening/usage.test.ts`; require red.
- [ ] Implement provider with explicit timeout/AbortSignal, output-token limit, schema validation and configured model. Allow HTTPS configured endpoints only (loopback HTTP only explicit dev). Network-free fake fetch fixtures cover valid answer, malformed JSON, refusal, missing usage, 401/429/500 and abort. No fallback to another paid model without policy/budget.
- [ ] Reserve pessimistic cost in a DB transaction before sending; count concurrent reservations toward cap. Missing usage does not mean zero cost: retain estimate marked estimated. Ephemeral requests may have null jobId, but a unique requestKey; budget metadata contains no chat text. Remote outcome unknown retains reserve until reconciliation.
- [ ] Run guarded budget concurrency tests: two calls cannot exceed cap; failed pre-send releases reservation; unknown post-send does not. Test disabled config produces503 and zero network requests. Commit only after offline tests and DB invariants pass; real-model quality remains Q02.

### T02: Context selection and verifiable citations

**Owner:** AI. **Depends:** I02,T01.
**Create:** `packages/ai/src/opening/context.ts`, `packages/ai/src/opening/context.test.ts`, `packages/ai/src/opening/citations.ts`, `packages/ai/src/opening/citations.test.ts`, `packages/database/src/repositories/opening-chunks.ts`, `tests/integration/opening-retrieval.test.ts`.
**Interfaces:** `resolveCitations(ids:string[],chunks:SourceChunk[]):Citation[]`; `selectContext({chunks,query,maxCharacters}):SourceChunk[]`. First retrieve only authorized selected material/current course; use exact/keyword ordering, not GraphRAG. Vector search is a separate future optimization, not a first-release dependency.

- [ ] Add failing citation test:
```ts
import { expect, it } from 'vitest';
import { resolveCitations } from './citations';
it('cannot fabricate an attachment citation', () => {
  expect(() => resolveCitations(['invented'],[])).toThrow();
  expect(resolveCitations([],[])).toEqual([]);
});
```
- [ ] Run context/citation unit files; require red. Add a fixed English/Spanish/Chinese glossary fixture and source-version fixture.
- [ ] Authorize source IDs before reading; fetch immutable chunks at the exact version; preserve source/page/timestamp label. Selected files outrank other course material; approved memory is a separate bounded section. Unconfirmed personal candidates do not become facts. Include clear delimiter marking source text as untrusted data.
- [ ] Enforce context budget deterministically; unknown citation IDs fail validation. General explanations can have no citations but UI labels them as general, not sourced teacher statements. Citation existence is program-checked; semantic support is sampled in Q02, not assumed.
- [ ] Run retrieval isolation tests with two workspaces and stale versions. Test revoked source, zero chunks, oversized input and source injection. Commit without adding graph/vector infrastructure before a measured retrieval need.

### T03: Saved conversations, tutoring jobs and polling API

**Owner:** AI with DATA owning migration. **Depends:** T02,I03.
**Create:** `packages/database/src/schema/opening-conversations.ts`, `packages/database/src/migrations/0017_opening_conversations.sql`, `packages/database/src/repositories/opening-conversations.ts`, `packages/database/src/repositories/opening-candidates.ts`, `apps/web/src/app/api/opening/candidates/route.ts`, `apps/web/src/features/opening/tutor/tutor-service.ts`, `apps/worker/src/jobs/tutor-turn.ts`, `apps/worker/src/jobs/tutor-turn.test.ts`, `apps/web/src/app/api/opening/conversations/route.ts`, `apps/web/src/app/api/opening/conversations/[id]/turns/route.ts`, `apps/web/src/app/api/opening/turns/route.ts`, `apps/web/src/app/api/opening/jobs/[id]/route.ts`, `tests/integration/handler/opening-tutor.test.ts`.
**Interfaces:** submitTurn/listTurns/getJob from interfaces.md; `makeTutorInstruction(mode:TutorMode):string`; `POST conversations {title,courseId}` returns server ID. Saved endpoint rejects ephemeral until M03's separate endpoint is ready.

- [ ] Test mode policy before implementation:
```ts
import { expect, it } from 'vitest';
import { makeTutorInstruction } from './tutor-turn';
it('keeps listening distinct from unsolicited planning', () => {
  expect(makeTutorInstruction('listen')).toContain('不要自动创建任务');
  expect(makeTutorInstruction('hint')).toContain('下一步提示');
});
```
- [ ] Run tutor-turn unit tests red, then guarded handler tests red for conversation ownership and duplicate clientKey.
- [ ] Persist user turn + pending assistant turn + outbox transactionally; job stores IDs, mode and versions, not arbitrary execution directives. Migration0017 also creates `opening_assistant_candidates`; validated ProviderOutput candidates are saved pending with program-assigned sourceTurnId/sourceIds, never executed. GET candidates exposes only current-user pending suggestions. M01 and P02 later consume them with user confirmation, without a reverse dependency from T03. Worker builds context via T02, calls T01, stores validated response once. Polling returns actual progress/errors; page can close and resume. No token streaming is required for the first durable path.
- [ ] Mode hint focuses first unresolved step; explain allows full answer and records reveal intent for L01; listen/think_together cannot directly mutate plans. Stale/deleted source stops writeback or returns explicit unavailable citation. Auth errors map to safe API failures.
- [ ] Tests cover duplicate same key, conflicting same key, other conversation, model failure, browser reload, cancellation and mode changes. M03 later routes ephemeral separately, without serializing its body into this job path. Commit a real saved-conversation vertical slice; not just mocked UI.
