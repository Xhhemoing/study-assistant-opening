# Memory and Daily Conversation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; privacy gates are release blockers, not polish.

**Goal:** Useful continuity without turning guesses or temporary emotions into permanent labels.
**Architecture:** Explicit memory records and source relationships; optimistic versions and workspace privacy epochs; saved and ephemeral conversation paths separated.
**Tech Stack:** TypeScript, PostgreSQL, existing provider/context interfaces.

## Global Constraints

Candidate memory is not a fact. Temporary state expires. No clinical/personality diagnosis. Long-term personal inference needs confirmation. Raw private chat never appears in ordinary logs or metrics.

### M01: Candidate, confirmed and temporary memory lifecycle

**Owner:** AI+DATA. **Depends:** T03.
**Create:** `packages/database/src/schema/opening-memory.ts`, `packages/database/src/migrations/0022_opening_memory_privacy.sql`, `packages/database/src/repositories/opening-memory.ts`, `packages/domain/src/opening/memory-policy.ts`, `packages/domain/src/opening/memory-policy.test.ts`, `apps/web/src/features/opening/memory/memory-service.ts`, `apps/web/src/app/api/opening/memory/route.ts`, `apps/web/src/app/api/opening/memory/[id]/decision/route.ts`, `tests/integration/handler/opening-memory.test.ts`.
**Interfaces:** MemoryItem/MemoryDecision and listMemory/decideMemory from interfaces.md; `isMemoryEligible(item:MemoryItem,now:string):boolean` for context selection; `proposeMemory(scope,{text,sourceTurnIds,expiresAt:null|string})` creates candidate/temporary only.

- [ ] Write failing pure test:
```ts
import { expect, it } from 'vitest';
import { isMemoryEligible } from './memory-policy';
it('never treats an expired state or candidate as a fact', () => {
  const item = {id:'m',workspaceId:'w',kind:'candidate' as const,text:'喜欢提示',sourceTurnIds:[],version:1,expiresAt:null,status:'active' as const};
  expect(isMemoryEligible(item,'2026-09-12T10:00:00Z')).toBe(false);
  expect(isMemoryEligible({...item,kind:'temporary',expiresAt:'2026-09-12T09:00:00Z'},'2026-09-12T10:00:00Z')).toBe(false);
});
```
- [ ] Run memory-policy unit file red. Add guarded handler tests before service implementation.
- [ ] Persist kind/source/version/expiry/status; expose T03 pending memory candidates as candidate projections, not confirmed facts. Confirmation transaction consumes the candidate and creates/version-updates the memory item once; no second background extractor is required. User decision uses expectedVersion+clientKey. Confirmation route derives principal and rejects model/job callers. Content assembly includes active confirmed and unexpired explicitly stated temporary facts; candidate displayed separately for review.
- [ ] Corrected facts produce new version; contradictory old fact becomes inactive. A rejection suppresses repeated equivalent proposals from the same source. Do not infer preferences from one skipped task. All memory cards expose why and when.
- [ ] Test other-workspace denial, stale decision409, double-confirm idempotency, expiry, conflict and rejection suppression. Commit after M01 tests, but do not enable sensitive long-term capture until M02.

### M02: Deletion, epoch races and restore exclusion

**Owner:** DATA. **Depends:** M01.
**Create:** `packages/database/src/repositories/opening-privacy.ts`, `apps/worker/src/runtime/privacy-guard.ts`, `apps/worker/src/runtime/privacy-guard.test.ts`, `tests/integration/opening-privacy.test.ts`, `apps/web/src/features/opening/memory/privacy-service.ts`.
**Modify:** `apps/worker/src/runtime/run-job.ts`, `apps/worker/src/jobs/tutor-turn.ts`, `packages/database/src/repositories/opening-memory.ts` and new opening backup adapter in Q03, not legacy event triggers.
**Interfaces:** `assertCurrentEpoch(jobEpoch:number,currentEpoch:number):void`; `deleteMemory(scope,{id,expectedVersion,deleteSourceText:boolean,clientKey})`; returns deletion receipt with no deleted content.

- [ ] Add failing guard test:
```ts
import { expect, it } from 'vitest';
import { assertCurrentEpoch } from './privacy-guard';
it('rejects a worker built from deleted personal context', () => {
  expect(() => assertCurrentEpoch(2,3)).toThrow();
  expect(() => assertCurrentEpoch(3,3)).not.toThrow();
});
```
- [ ] Run unit red; guarded integration begins with a paused worker after context-read and before writeback.
- [ ] In one transaction tombstone memory, increment privacyEpoch, revoke linked summaries/chunks and record source exclusions; optionally erase opening conversation text. Workers check epoch before reading and atomically with final write. Cancellation alone is insufficient. Caches key by epoch; no automatic re-extraction from excluded sources.
- [ ] Keep a content-free deletion journal outside the set overwritten by restore; Q03 restores must apply the current journal before making restored records visible. A backup lacking required privacy metadata is rejected with an explicit recovery explanation, not silently restored. Third-party vendor retention is disclosed and not falsely promised deleted.
- [ ] Test delete racing with writeback, cached retrieval, source-text-kept exclusion, duplicate delete, old backup and cross-user access. Do not disable existing append-only event guards as a shortcut. Commit only after deletion/readback and race assertions pass.

### M03: Listening, temporary state and no-save mode

**Owner:** AI. **Depends:** T03,M02.
**Create:** `packages/ai/src/opening/conversation-policy.ts`, `packages/ai/src/opening/conversation-policy.test.ts`, `apps/web/src/features/opening/tutor/ephemeral-service.ts`, `apps/web/src/app/api/opening/ephemeral/route.ts`, `tests/integration/handler/opening-ephemeral.test.ts`.
**Interfaces:** `EphemeralTurnInput={text:string;sourceIds:string[];mode:TutorMode;history:Array<{role:'user'|'assistant';text:string}>}`; `replyEphemeral(scope,input,signal):Promise<ProviderOutput>`; `canProposeTask(mode:TutorMode):boolean`. Ephemeral route returns response directly and never uses saved submitTurn.

- [ ] Add failing policy test:
```ts
import { expect, it } from 'vitest';
import { canProposeTask } from './conversation-policy';
it('does not turn listening into a task generator', () => {
  expect(canProposeTask('listen')).toBe(false);
  expect(canProposeTask('think_together')).toBe(true);
});
```
- [ ] Run policy unit red and handler persistence tests red.
- [ ] UI selects listen/think_together without a personality quiz. User-stated fatigue can become expiring state only with clear visibility. No-save mode keeps history in current tab memory; refresh intentionally clears it and warns upfront. Limit ephemeral history to16 turns/24000 characters and reject over-limit input.
- [ ] Call T01 with budget metadata but no persisted text, prompt, citations containing private quote, or model response body; strip candidates from the ephemeral response and never persist them. Abort/timeout does not enqueue durable conversation jobs. Telemetry and errors are content-free. Material retrieval still needs normal object authorization and vendor-upload consent.
- [ ] Test DB tables remain unchanged for content, history absent after reload, no memory proposal, logs redacted and provider failure does not create saved fallback. Commit with no-save behavior explicitly documented; do not claim provider-side zero retention.
