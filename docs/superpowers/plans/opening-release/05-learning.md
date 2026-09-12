# Learning Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; never replace observable evidence with model confidence.

**Goal:** Observe paper-based learning without forcing every exercise into the app; distinguish assistance and unverified answers.
**Architecture:** New observations sit beside existing formal LearningEvent v1. Only appropriately verified, mapped work is projected into the old boolean-correct event system.
**Tech Stack:** TypeScript pure rules, PostgreSQL, existing practice/review services.

## Global Constraints

Unknown is allowed. Uploaded difficult examples are a biased sample. No classroom-level mastery inference from a few uploads. A hint on one learning session must not contaminate an independent future retest.

### L01: Paper sessions, assistance exposure and observations

**Owner:** DATA. **Depends:** T03,M01 (0019 follows0018).
**Create:** `packages/database/src/schema/opening-learning.ts`, `packages/database/src/migrations/0019_opening_learning.sql`, `packages/database/src/repositories/opening-learning.ts`, `packages/domain/src/opening/assistance.ts`, `packages/domain/src/opening/assistance.test.ts`, `apps/web/src/features/opening/learning/observation-service.ts`, `apps/web/src/app/api/opening/learning-sessions/route.ts`, `apps/web/src/app/api/opening/observations/route.ts`, `tests/integration/handler/opening-observations.test.ts`.
**Modify:** `apps/worker/src/jobs/tutor-turn.ts` to record exposures tied to an explicit learningSessionId; F02 contracts via INTEGRATOR.
**Interfaces:** `resolveAssistance(declared:ObservationInput['assistance'], exposures:Array<'hinted'|'revealed'>):ObservationInput['assistance']`; `POST learning-sessions {courseId,skillLabel,sourceIds}` -> `{id}`. ObservationInput gains required sessionId. Server adds `verdictSource:'self_report'|'reference_checked'|'model_suggestion'|'unknown'` and optional reference source ID.

- [ ] Add failing test:
```ts
import { expect, it } from 'vitest';
import { resolveAssistance } from './assistance';
it('does not let the browser erase known answer exposure', () => {
  expect(resolveAssistance('independent',['hinted'])).toBe('hinted');
  expect(resolveAssistance('independent',['hinted','revealed'])).toBe('revealed');
  expect(resolveAssistance('unknown',[])).toBe('unknown');
});
```
- [ ] Run assistance test red and guarded observation tests red.
- [ ] Store learning-session ownership, source version and exposure timestamps. Client assistance cannot override server-known exposure for that same session. In a new retest session no exposure is inherited automatically. Record help actually delivered, not merely a failed request for help.
- [ ] Treat client correctness as self_report unless a reference-checked path is completed; model opinion is model_suggestion. Open proofs/ambiguous handwriting stay unverified. Existing attempt endpoints continue authoritative grading of their versioned content; no fake boolean for unknown work. Correcting an observation creates a linked revision, not an invisible rewrite.
- [ ] Test spoofed independence, cross-session isolation, duplicate clientKey, other source IDs, unknown outcomes, invalid reference and replay. Commit with explicit distinction between informal observation and formal graded event.

### L02: Explainable state and small retest queue

**Owner:** EXPERIENCE (domain rules). **Depends:** L01.
**Create:** `packages/domain/src/opening/learning-summary.ts`, `packages/domain/src/opening/learning-summary.test.ts`, `packages/domain/src/opening/retest-policy.ts`, `packages/domain/src/opening/retest-policy.test.ts`, `apps/worker/src/jobs/retest-candidate.ts`, `apps/web/src/app/api/opening/retests/[id]/accept/route.ts`.
**Interfaces:** `summarizeObservations(observations:LearningObservation[],now:string):LearningSummary[]`; `suggestRetestAt(occurredAt:string,delayDays:number):string`; candidate generator uses sources and T01 budget, proposal not a formal assigned task until accepted.

- [ ] Add failing state test:
```ts
import { expect, it } from 'vitest';
import { summarizeObservations } from './learning-summary';
it('does not manufacture mastery with no evidence', () => {
  expect(summarizeObservations([],'2026-09-12T10:00:00Z')).toEqual([]);
});
```
- [ ] Add complete observation fixtures for hinted-correct, unverified, independent reference-checked and stale evidence, then run both domain tests red.
- [ ] Rules: unverified/model-only/self-report -> needs_check; independent reference-checked correct -> observed_independent (label explicitly means limited observed evidence, not mastery); accepted due retest -> needs_review. Evidence IDs and source labels remain visible. Missing upload yields no negative evidence.
- [ ] Generate at most a small candidate batch, default one problem; check source references and distinguish generated answer from verified reference. Default retest suggestion is two days, editable; it is a heuristic, not a calibrated retention model. No FSRS/BKT training in this release.
- [ ] Run rule tests with fixed clocks and duplicate evidence; verify hinting one exercise cannot make a skill stable. Candidate acceptance creates a user-visible task via P02 integration adapter once available; until then store accepted due entry without claiming calendar scheduling.

### L03: Real learning read API and no-Mock opening client

**Owner:** EXPERIENCE. **Depends:** L02.
**Create:** `apps/web/src/features/opening/learning/read-service.ts`, `apps/web/src/app/api/opening/courses/[id]/learning/route.ts`, `apps/web/src/features/opening/client/learning-client.ts`, `apps/web/src/features/opening/client/learning-client.test.ts`, `tests/contract/opening-no-mock.test.ts`.
**Modify:** opening routes/nav guards added in U01; legacy `useStudyProvider` is not rewritten wholesale and cannot be used by new opening routes.
**Interfaces:** summarizeLearning from interfaces.md; `createOpeningLearningClient(fetchImpl:typeof fetch)` exposes `getSummary(courseId)` and `submitObservation(input)`. HTTP errors are errors, never fake successful data.

- [ ] Add failing network test:
```ts
import { expect, it } from 'vitest';
import { createOpeningLearningClient } from './learning-client';
it('does not fill a failed backend with demo learning results', async () => {
  const client = createOpeningLearningClient(async () => new Response('unavailable',{status:503}));
  await expect(client.getSummary('course-1')).rejects.toThrow();
});
```
- [ ] Run learning-client test red and add contract scan rejecting imports from `/lib/data/mock/` or `createMockProvider` under opening feature/routes.
- [ ] Read observations and formal mapped events from server for authenticated course; server computes summary using L02. Return empty known state when no observations, not seeded goals or examples. Test fixtures only under test paths. LocalStorage may hold unsent text drafts, never formal learning results.
- [ ] Opening UI accesses this client only. Production opening mode redirects legacy demo routes to genuine equivalents; keep old prototype code for the original platform without presenting it as released functionality.
- [ ] Run no-Mock contract test plus real handler test across two browser sessions: a saved observation on phone appears on computer after refresh. Failure/unauthorized states remain explicit. Commit without claiming all historical platform features are converted.
