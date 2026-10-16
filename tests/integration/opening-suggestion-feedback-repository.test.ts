import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { SuggestedTask } from "@aistudy/contracts";
import { createOpeningPlansRepository, createOpeningPlanningSettingsRepository, recordOpeningSuggestionFeedback,
  readOpeningSuppressedSuggestionIdentities } from "@aistudy/database";
import { suggestionFeedbackIdentity, suggestionIdentity, suggestionKey } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

let f: OpeningFixture;
beforeEach(async () => { f = await createOpeningFixture(); });
afterEach(async () => { await f?.close(); });
const day = "2026-10-21", now = new Date(`${day}T07:00:00Z`);
function suggestion(requirementKey: string | null = null): SuggestedTask {
  return { id: randomUUID(), key: suggestionKey(day, suggestionIdentity("review_cards", null, null, requirementKey)) + (requirementKey ?? ""),
    kind: "review_cards", title: "Review", minutes: 10, courseId: null, skillLabel: null, requirementKey,
    reasonCode: "review_cards", reason: "Due cards" };
}
async function draft(items = [suggestion()]) {
  const repo = createOpeningPlansRepository(f.sql, { now: () => now });
  await createOpeningPlanningSettingsRepository(f.sql).set(f.scope, { weekOneMonday: "2026-10-19", timeZone: "Etc/UTC",
    periodTimes: { "1": { start: "08:00", end: "08:45" } }, dailyWindow: { start: "08:00", end: "12:00" },
    lunch: { start: "12:00", end: "13:00" }, dinner: { start: "17:30", end: "18:30" }, sleep: { start: "23:00", end: "07:00" } });
  const saved = await repo.proposePlan(f.scope, { date: day, tasks: [], free: [{ kind: "free", start: `${day}T08:00:00Z`, end: `${day}T12:00:00Z` }],
    blocks: items.map((item, i) => ({ taskId: item.id, start: `${day}T${String(8 + i).padStart(2, "0")}:00:00Z`, end: `${day}T${String(8 + i).padStart(2, "0")}:10:00Z`, reason: "Review" })),
    unscheduledTaskIds: [], clientKey: randomUUID() });
  await f.sql`UPDATE opening_plan_drafts SET origin='auto_draft',strategy_version='adaptive-2',suggested_tasks=${f.sql.json(items)} WHERE id=${saved.id}`;
  return { ...saved, items };
}
const feedbackInput = (saved: Awaited<ReturnType<typeof draft>>, extra = {}) => ({ draftId: saved.id,
  expectedDraftVersion: saved.version, suggestionKey: saved.items[0]!.key, clientKey: randomUUID(), ...extra });

it("persists only server-owned metadata, bumps the draft atomically and replays the same intent", async () => {
  const saved = await draft(), input = feedbackInput(saved);
  const result = await recordOpeningSuggestionFeedback(f.sql, f.scope, input);
  expect(result.draft).toMatchObject({ id: saved.id, version: saved.version + 1, rejectedSuggestedKeys: [input.suggestionKey] });
  expect(result.draft.suggestedTasks).toHaveLength(1);
  expect(await recordOpeningSuggestionFeedback(f.sql, f.scope, input)).toEqual(result);
  const [event] = await f.sql`SELECT day,identity,suggestion_kind,course_id,requirement_key,reason FROM opening_suggestion_feedback WHERE id=${result.feedbackId}`;
  expect(event).toMatchObject({ identity: suggestionFeedbackIdentity(saved.items[0]!), suggestion_kind: "review_cards", course_id: null,
    requirement_key: null, reason: null });
  expect(new Date(event!.day as string | Date).toISOString().slice(0, 10)).toBe(day);
  await expect(recordOpeningSuggestionFeedback(f.sql, f.scope, { ...input, reason: "too_hard" })).rejects.toMatchObject({ code: "CONFLICT" });
  expect(await f.sql`SELECT id FROM opening_suggestion_feedback WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  expect(await f.sql`SELECT id FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT id FROM opening_learning_observations WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
});

it("isolates ownership, stale versions, nonexistent keys and same-day identities without suppressing a different requirement or day", async () => {
  const saved = await draft([suggestion("R1"), suggestion("R2")]);
  const input = feedbackInput(saved, { reason: "too_hard" });
  await expect(recordOpeningSuggestionFeedback(f.sql, f.otherScope, input)).rejects.toMatchObject({ code: "NOT_FOUND" });
  await expect(recordOpeningSuggestionFeedback(f.sql, f.scope, { ...input, suggestionKey: "made-up-key" })).rejects.toMatchObject({ code: "VALIDATION" });
  await expect(recordOpeningSuggestionFeedback(f.sql, f.scope, { ...input, expectedDraftVersion: saved.version + 1 })).rejects.toMatchObject({ code: "CONFLICT" });
  const result = await recordOpeningSuggestionFeedback(f.sql, f.scope, input);
  expect(result.draft.rejectedSuggestedKeys).toEqual([saved.items[0]!.key]);
  expect(await readOpeningSuppressedSuggestionIdentities(f.sql, f.scope, "2026-10-22")).toEqual([]);
  await expect(recordOpeningSuggestionFeedback(f.sql, f.scope, { ...input, expectedDraftVersion: saved.version + 1, clientKey: randomUUID() }))
    .rejects.toMatchObject({ code: "CONFLICT" });
  const second = await recordOpeningSuggestionFeedback(f.sql, f.scope, { ...input, expectedDraftVersion: saved.version + 1,
    suggestionKey: saved.items[1]!.key, clientKey: randomUUID() });
  expect(second.draft.rejectedSuggestedKeys).toHaveLength(2);
});

it("rolls back feedback insertion when draft version update fails", async () => {
  const saved = await draft();
  const failed = new Proxy(f.sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(tx => work(new Proxy(tx, {
      apply(query, thisArg, args: [TemplateStringsArray, ...unknown[]]) {
        if (args[0].join("?").includes("UPDATE opening_plan_drafts SET version=version+1")) throw new Error("injected version failure");
        return Reflect.apply(query, thisArg, args);
      },
    })));
  } });
  await expect(recordOpeningSuggestionFeedback(failed, f.scope, feedbackInput(saved))).rejects.toThrow("injected version failure");
  expect(await f.sql`SELECT id FROM opening_suggestion_feedback WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
  expect(await f.sql`SELECT version FROM opening_plan_drafts WHERE id=${saved.id}`).toEqual([{ version: saved.version }]);
});

function beforeCommit(sql: Sql) {
  let release = () => undefined as void, entered = () => undefined as void;
  const opened = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const gated = new Proxy(sql, { get(target, property) {
    if (property !== "begin") return Reflect.get(target, property);
    return (work: (tx: TransactionSql) => Promise<unknown>) => target.begin(async tx => { const result = await work(tx); entered(); await gate; return result; });
  } });
  return { sql: gated, opened, release };
}

it.each(["feedback", "accept"] as const)("serializes a real %s winner against the competing acceptance/feedback", async winnerKind => {
  const saved = await draft(), input = feedbackInput(saved);
  const accept = { draftId: saved.id, expectedBaseVersion: saved.baseVersion, clientKey: randomUUID(), acceptSuggestedKeys: [input.suggestionKey] };
  const a = await openRaceSession().ready, b = await openRaceSession().ready, barrier = beforeCommit(a.sql);
  const winner = track<unknown>(winnerKind === "feedback" ? recordOpeningSuggestionFeedback(barrier.sql, f.scope, input)
    : createOpeningPlansRepository(barrier.sql, { now: () => now }).acceptPlan(f.scope, accept));
  const pending: Promise<unknown>[] = [winner];
  try {
    await Promise.race([barrier.opened, winner.then(() => { throw new Error("winner bypassed barrier"); })]);
    const loser = track<unknown>(winnerKind === "feedback" ? createOpeningPlansRepository(b.sql, { now: () => now }).acceptPlan(f.scope, accept)
      : recordOpeningSuggestionFeedback(b.sql, f.scope, input));
    pending.push(loser); await waitUntilBlocked(f.sql, b.pid, a.pid, `suggestion-${winnerKind}`);
    barrier.release(); await winner;
    await expect(loser).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_suggestion_feedback WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(winnerKind === "feedback" ? 1 : 0);
    expect(await f.sql`SELECT id FROM opening_tasks WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(winnerKind === "accept" ? 1 : 0);
  } finally { barrier.release(); await Promise.allSettled(pending); await closeRace(b.sql); await closeRace(a.sql); }
}, 15_000);

it("replays concurrent identical feedback once rather than bumping the draft twice", async () => {
  const saved = await draft(), input = feedbackInput(saved);
  const a = await openRaceSession().ready, b = await openRaceSession().ready, barrier = beforeCommit(a.sql);
  const first = track(recordOpeningSuggestionFeedback(barrier.sql, f.scope, input)), pending: Promise<unknown>[] = [first];
  try {
    await Promise.race([barrier.opened, first.then(() => { throw new Error("winner bypassed barrier"); })]);
    const second = track(recordOpeningSuggestionFeedback(b.sql, f.scope, input)); pending.push(second);
    await waitUntilBlocked(f.sql, b.pid, a.pid, "same-suggestion-feedback"); barrier.release();
    expect(await second).toEqual(await first);
    expect(await f.sql`SELECT version FROM opening_plan_drafts WHERE id=${saved.id}`).toEqual([{ version: saved.version + 1 }]);
    expect(await f.sql`SELECT id FROM opening_suggestion_feedback WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(1);
  } finally { barrier.release(); await Promise.allSettled(pending); await closeRace(b.sql); await closeRace(a.sql); }
}, 15_000);
