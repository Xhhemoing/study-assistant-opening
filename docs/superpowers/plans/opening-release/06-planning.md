# Timetable and Negotiated Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans; time correctness and confirmation are functional gates.

**Goal:** Turn real course weeks, deadlines and rest constraints into small, reviewable daily plans.

2026-09-14扩展：P01–P03为排程与协商基础；邮箱/钉钉通知归并、知识证据驱动的主动建议和减少确认负担由[11-proactive-acceptance.md](11-proactive-acceptance.md)的P04/U04验收。
**Architecture:** Pure schedule rules propose; database transactions accept. AI may explain/extract candidates but cannot bypass conflicts or mutate accepted plans.
**Tech Stack:** TypeScript, PostgreSQL; read-excel-file 9.3.10 (MIT metadata checked), @js-temporal/polyfill 0.5.1 candidate for explicit timezone/DST handling, pinned and tested before use.

## Global Constraints

No inferred grading formula, GPA prediction or missing-course-as-free-time assumption. Deadline extraction with ambiguous relative dates stays unconfirmed. First release does not synchronize arbitrary external calendars.

### P01: Academic-week timetable and hard time blocks

**Owner:** EXPERIENCE (domain). **Depends:** F02.
**Create:** `packages/domain/src/opening/timetable.ts`, `packages/domain/src/opening/timetable.test.ts`, `apps/web/src/features/opening/timetable/xlsx-reader.ts`, `apps/web/src/features/opening/timetable/xlsx-reader.test.ts`, `apps/web/src/features/opening/timetable/timezone.ts`, `tests/fixtures/opening/timetable-synthetic.xlsx`.
**Modify:** relevant workspace package.json/lock only through INTEGRATOR.
**Interfaces:** `normalizeWeekSessions(rows:WeekSession[]):WeekSession[]`; `expandWeekSessions(rows,{weekOneMonday,periodTimes,timeZone}):TimeBlock[]`. Reader outputs WeekSession, not calendar events. `periodTimes` is `{[period:number]:{start:string;end:string}}`, with HH:mm validation.

- [ ] Write failing dedup test:
```ts
import { expect, it } from 'vitest';
import { normalizeWeekSessions } from './timetable';
it('deduplicates repeated spreadsheet display without removing week differences', () => {
  const row = {courseName:'数学I',weekday:6,weeks:[2],startPeriod:1,endPeriod:4};
  expect(normalizeWeekSessions([row,row,{...row,weeks:[3]}])).toHaveLength(2);
});
```
- [ ] Run timetable and xlsx-reader unit tests red. Use sanitized synthetic workbook, never commit the user's identifiable timetable.
- [ ] Parse cell course names/bracketed week ranges/session ranges; ignore layout-only repeated cells. Validate 1..7 weekdays, sorted unique weeks, start≤end. Missing week-one date or clock map blocks absolute expansion with an actionable message. Preserve raw parse provenance for correction.
- [ ] Use timezone-aware conversion; reject ambiguous/nonexistent DST times until user confirms, don't shift silently. Preserve classes, meals, sleep and locked blocks as hard constraints. Reproduce the original workbook's structure in local private validation, not as a public fixture.
- [ ] Rerun golden cases: Saturday, split week ranges, repeated cell, partial parse, missing English course warning, invalid date, DST gap. Commit rule and reader separately from persistence; no fabricated calendar dates.

### P02: Tasks, plan drafts and atomic acceptance

**Owner:** DATA+EXPERIENCE. **Depends:** P01,F03,L01 (migration0024 after M02/0023; L01 remains a retest integration dependency).
**Create:** `packages/database/src/schema/opening-planning.ts`, `packages/database/src/migrations/0024_opening_planning.sql`, `packages/database/src/repositories/opening-plans.ts`, `packages/domain/src/opening/day-planner.ts`, `packages/domain/src/opening/day-planner.test.ts`, `apps/web/src/features/opening/planning/plan-service.ts`, `apps/web/src/app/api/opening/tasks/route.ts`, `apps/web/src/app/api/opening/timetable/route.ts`, `apps/web/src/app/api/opening/today/route.ts`, `apps/web/src/app/api/opening/plans/route.ts`, `apps/web/src/app/api/opening/plans/[id]/accept/route.ts`, `tests/integration/handler/opening-plans.test.ts`.
**Interfaces:** `planDay(tasks:TaskItem[],free:TimeBlock[]):{blocks:PlannedBlock[];unscheduledTaskIds:string[]}`; proposePlan/acceptPlan from interfaces.md; task status changes require user action and version. Existing old goal model is not silently reused as every campus task.

- [ ] Write failing pure test:
```ts
import { expect, it } from 'vitest';
import { planDay } from './day-planner';
it('leaves tasks unscheduled instead of stealing sleep', () => {
  const task = {id:'t',title:'物理作业',minutes:60,dueAt:null,priority:1,status:'pending' as const};
  expect(planDay([task],[])).toEqual({blocks:[],unscheduledTaskIds:['t']});
});
```
- [ ] Run planner unit red, then guarded plan tests red.
- [ ] Normalize free slots after subtracting all hard blocks; sort tasks by confirmed deadline risk, user priority, then stable ID. Fit non-overlapping blocks, list unplaced tasks instead of inventing time. T03 task candidates are visible pending suggestions: POST tasks accepts candidateId plus user-confirmed title/minutes/dueAt and consumes the candidate transactionally. Estimates are shown as estimates; ambiguous dueText stays pending and cannot become a formal deadline without confirmation.
- [ ] Draft stores baseVersion and input snapshot. Accept transaction locks today's plan, checks expected version and current hard blocks, writes a new accepted version once using clientKey. Concurrent old draft gets409. Reject leaves current plan unchanged. Change of user availability invalidates stale draft.
- [ ] Test two accepts racing, same-key changed payload, rejected draft, incomplete timetable, task done elsewhere, newly inserted class and protected sleep. Commit migration0024 only after migration ordering passes. Do not use the original working tree's uncommitted plan-state code without separate review.

### P03: Due items and honest reminder delivery status

**Owner:** PIPELINE. **Depends:** P02,I03.
**Create:** `apps/worker/src/jobs/remind.ts`, `apps/worker/src/jobs/remind.test.ts`, `apps/worker/src/channels/feishu-reminder.ts`, `apps/web/src/app/api/opening/reminders/route.ts`, `packages/domain/src/opening/reminder-policy.ts`, `packages/domain/src/opening/reminder-policy.test.ts`, `tests/integration/opening-reminders.test.ts`.
**Interfaces:** `reminderDeliveryState({channel,configured,receiptId}):Reminder['status']`; Feishu adapter `send({recipientId,text,idempotencyKey},signal):Promise<{receiptId:string}>`. Recipient is configured owner only; no model-selected recipient.

- [ ] Add failing state test:
```ts
import { expect, it } from 'vitest';
import { reminderDeliveryState } from './reminder-policy';
it('does not claim an unconfigured push was delivered', () => {
  expect(reminderDeliveryState({channel:'feishu',configured:false,receiptId:null})).toBe('disabled');
  expect(reminderDeliveryState({channel:'in_app',configured:true,receiptId:null})).toBe('due');
});
```
- [ ] Run reminder-policy/remind unit tests red.
- [ ] In-app queue always works from DB; opening a list is not push delivery. External channel disabled by default; explicit recipient/credentials/quiet hours enable it. Queue only accepted tasks. Persist attempts and receipts, deduplicate by task/version/dueAt/channel; status sent only after provider acknowledgement.
- [ ] Rescheduled/deleted task cancels old reminder; worker restart doesn't duplicate business sends. Unknown provider outcome remains visible rather than infinite resends. Respect user quiet hours; no aggressive retry spam. First-release channel adapter can be offline-tested before credentials are supplied.
- [ ] Test restart, duplicate trigger, changed due date, quiet interval, invalid credential, rate limit and missing configuration. Actual external delivery requires a real receipt during Q02; without it release notes state only in-app reminders available.
