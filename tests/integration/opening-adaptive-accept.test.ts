/** C3 accepts the server's stored selection atomically; no browser or provider is involved. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AcceptPlanInput, PlannedBlock, Scope, SuggestedTask, TaskItem } from "@aistudy/contracts";
import { createOpeningPlansRepository } from "@aistudy/database";
import { ADAPTIVE_STRATEGY_VERSION, suggestionIdentity, suggestionKey } from "@aistudy/domain";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

const day = "2026-10-21";
const now = new Date(`${day}T08:00:00.000Z`);
const at = (hour: number, minute = 0) => `${day}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00.000Z`;
let fixture: OpeningFixture;

beforeEach(async () => { fixture = await createOpeningFixture(); });
afterEach(async () => { await fixture?.close(); });

const repository = (clock = now) => createOpeningPlansRepository(fixture.sql, { now: () => clock });

async function seedCourse() {
  const { sql, scope } = fixture;
  const sourceId = await backupRows(sql, scope).source();
  await backupRows(sql, scope).chunk(sourceId);
  const courseId = randomUUID();
  await sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${scope.workspaceId}, 'Acceptance course', ${courseId})`;
  await sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${scope.workspaceId}, ${courseId}, 'source', ${sourceId}, 'core', 0, 'course')`;
  return { courseId, sourceId };
}

function suggestion(courseId: string | null, skillLabel: string | null = "fractions"): SuggestedTask {
  const kind = courseId === null ? "review_cards" : "weak_skill";
  const label = courseId === null ? null : skillLabel;
  return {
    id: randomUUID(), key: suggestionKey(day, suggestionIdentity(kind, courseId, label)),
    kind, courseId, skillLabel: label, title: courseId ? `Practice ${label}` : "Review due cards",
    minutes: courseId ? 25 : 5, reasonCode: kind, reason: "Verified planning reason",
  };
}

function block(taskId: string, index = 0, minutes = 25): PlannedBlock {
  const start = new Date(Date.parse(at(9)) + index * 30 * 60_000);
  return { taskId, start: start.toISOString(), end: new Date(start.getTime() + minutes * 60_000).toISOString(), reason: "Stored draft block" };
}

async function seedDraft(input: {
  suggestions?: SuggestedTask[];
  tasks?: TaskItem[];
  blocks?: PlannedBlock[];
  unscheduledTaskIds?: string[];
  plain?: boolean;
} = {}) {
  const { sql, scope } = fixture;
  const id = randomUUID();
  const suggestions = input.suggestions ?? [];
  const tasks = input.tasks ?? [];
  const unscheduledTaskIds = input.unscheduledTaskIds ?? [];
  const blocks = input.blocks ?? [...tasks, ...suggestions]
    .filter(task => !unscheduledTaskIds.includes(task.id))
    .map((task, index) => block(task.id, index, task.minutes));
  await sql`INSERT INTO opening_plan_drafts
    (id, workspace_id, owner_user_id, day, version, base_version, status, blocks, unscheduled_task_ids,
      input_snapshot, hard_blocks_fingerprint, origin, suggested_tasks, reasons, strategy_version)
    VALUES (${id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${day}::date, 0, 0, 'draft',
      ${sql.json(blocks)}, ${sql.json(unscheduledTaskIds)}, ${sql.json({ tasks })}, 'acceptance-fixture',
      ${input.plain ? "user" : "auto_draft"}, ${sql.json(suggestions)}, '{}'::jsonb,
      ${input.plain ? null : ADAPTIVE_STRATEGY_VERSION})`;
  return { id, blocks, suggestions };
}

function acceptance(draftId: string, overrides: Partial<AcceptPlanInput> = {}): AcceptPlanInput {
  return { draftId, expectedBaseVersion: 0, clientKey: randomUUID(), ...overrides };
}

async function ledger(scope: Scope = fixture.scope) {
  const { sql } = fixture;
  const [tasks, states, receipts, drafts] = await Promise.all([
    sql`SELECT id, title, minutes, status, version, client_key, course_id, skill_label, origin FROM opening_tasks
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} ORDER BY id`,
    sql`SELECT day, accepted_version, accepted_blocks, hard_blocks_fingerprint FROM opening_plan_state
      WHERE workspace_id=${scope.workspaceId} ORDER BY day`,
    sql`SELECT client_key, draft_id, accepted_version, payload_hash FROM opening_plan_acceptances
      WHERE workspace_id=${scope.workspaceId} ORDER BY client_key`,
    sql`SELECT id, status, version, blocks FROM opening_plan_drafts
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} ORDER BY id`,
  ]);
  return { tasks: [...tasks], states: [...states], receipts: [...receipts], drafts: [...drafts] };
}

async function rejectsAtomically(input: AcceptPlanInput, error: { code: string; reason?: string }, clock = now) {
  const before = await ledger();
  await expect(repository(clock).acceptPlan(fixture.scope, input)).rejects.toMatchObject(error);
  expect(await ledger()).toEqual(before);
}

async function ownTask() {
  return repository().createTask(fixture.scope, {
    title: "Own assignment", minutes: 20, dueAt: null, priority: 1, candidateId: null,
  });
}

async function insertExistingSuggestion(item: SuggestedTask, status = "pending", version = 1) {
  const { sql, scope } = fixture;
  await sql`INSERT INTO opening_tasks
    (id, workspace_id, owner_user_id, title, minutes, due_at, priority, status, version, client_key, course_id, skill_label, origin)
    VALUES (${item.id}, ${scope.workspaceId}, ${scope.ownerUserId}, ${item.title}, ${item.minutes}, NULL, 0,
      ${status}, ${version}, ${item.key}, ${item.courseId}, ${item.skillLabel}, 'planner')`;
}

describe("adaptive draft acceptance", () => {
  it("omits keys to accept all placed suggestions using server-stored task content", async () => {
    const course = await seedCourse();
    const suggestions = [suggestion(course.courseId), suggestion(null)];
    const draft = await seedDraft({ suggestions });
    const accepted = await repository().acceptPlan(fixture.scope, acceptance(draft.id));
    expect(accepted).toMatchObject({ id: draft.id, status: "accepted", version: 1, blocks: draft.blocks });
    const saved = await ledger();
    expect(saved.tasks).toHaveLength(2);
    for (const item of suggestions) {
      expect(saved.tasks).toContainEqual(expect.objectContaining({
        id: item.id, title: item.title, minutes: item.minutes, client_key: item.key,
        course_id: item.courseId, skill_label: item.skillLabel, status: "pending", version: 1, origin: "planner",
      }));
    }
    expect(saved.states).toEqual([expect.objectContaining({ accepted_version: 1, accepted_blocks: draft.blocks })]);
    expect(saved.receipts).toHaveLength(1);
  });

  it("accepts an empty selection without creating suggestions and preserves the learner's own task", async () => {
    const task = await ownTask();
    const item = suggestion(null);
    const draft = await seedDraft({ tasks: [task], suggestions: [item] });
    const accepted = await repository().acceptPlan(fixture.scope, acceptance(draft.id, { acceptSuggestedKeys: [] }));
    expect(accepted.blocks.map(entry => entry.taskId)).toEqual([task.id]);
    const saved = await ledger();
    expect(saved.tasks.map(row => row.id)).toEqual([task.id]);
    expect(saved.states[0]!.accepted_blocks).toEqual(accepted.blocks);
  });

  it("creates neither unchecked suggestions nor selected suggestions that have no scheduled slot", async () => {
    const { courseId } = await seedCourse();
    const chosen = suggestion(courseId, "fractions"), unchecked = suggestion(courseId, "limits"), unplaced = suggestion(courseId, "derivatives");
    const draft = await seedDraft({ suggestions: [chosen, unchecked, unplaced], unscheduledTaskIds: [unplaced.id] });
    const accepted = await repository().acceptPlan(fixture.scope, acceptance(draft.id, { acceptSuggestedKeys: [chosen.key, unplaced.key] }));
    expect(accepted.blocks.map(entry => entry.taskId)).toEqual([chosen.id]);
    expect((await ledger()).tasks.map(row => row.id)).toEqual([chosen.id]);
  });

  it("normalizes selection ordering and duplicate keys on replay without adding tasks, receipts or versions", async () => {
    const { courseId } = await seedCourse();
    const first = suggestion(courseId, "fractions"), second = suggestion(courseId, "limits");
    const draft = await seedDraft({ suggestions: [first, second] });
    const input = acceptance(draft.id);
    const accepted = await repository().acceptPlan(fixture.scope, input);
    const before = await ledger();
    const replay = await repository().acceptPlan(fixture.scope, {
      ...input, acceptSuggestedKeys: [second.key, first.key, second.key, first.key],
    });
    expect(replay).toEqual(accepted);
    expect(await repository().acceptPlan(fixture.scope, { ...input, acceptSuggestedKeys: [first.key, second.key] })).toEqual(accepted);
    expect(await ledger()).toEqual(before);
  });

  it("rejects a different selection with the same client key and leaves the prior accepted state intact", async () => {
    const { courseId } = await seedCourse();
    const first = suggestion(courseId, "fractions"), second = suggestion(courseId, "limits");
    const draft = await seedDraft({ suggestions: [first, second] });
    const input = acceptance(draft.id, { acceptSuggestedKeys: [first.key] });
    await repository().acceptPlan(fixture.scope, input);
    await rejectsAtomically({ ...input, acceptSuggestedKeys: [first.key, second.key] }, { code: "CONFLICT", reason: "selection_mismatch" });
  });

  it("rejects an unknown selected key without leaving a newly inserted plan-state row", async () => {
    const draft = await seedDraft({ suggestions: [suggestion(null)] });
    expect((await ledger()).states).toEqual([]);
    await rejectsAtomically(acceptance(draft.id, { acceptSuggestedKeys: [suggestionKey(day, "not-in-the-draft")] }), { code: "VALIDATION" });
  });

  it("serializes two first accepts for the same day so exactly one draft and task set win", async () => {
    const { courseId } = await seedCourse();
    const first = await seedDraft({ suggestions: [suggestion(courseId, "fractions")] });
    const second = await seedDraft({ suggestions: [suggestion(courseId, "limits")] });
    expect((await ledger()).states).toEqual([]);
    const results = await Promise.allSettled([
      repository().acceptPlan(fixture.scope, acceptance(first.id)),
      repository().acceptPlan(fixture.scope, acceptance(second.id)),
    ]);
    const successes = results.filter(result => result.status === "fulfilled");
    const failures = results.filter(result => result.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.reason).toMatchObject({ code: "CONFLICT", reason: "stale_version" });
    const winner = successes[0]!.value;
    const saved = await ledger();
    expect(saved.tasks.map(row => row.id)).toEqual(winner.blocks.map(entry => entry.taskId));
    expect(saved.states).toEqual([expect.objectContaining({ accepted_version: 1, accepted_blocks: winner.blocks })]);
    expect(saved.receipts).toEqual([expect.objectContaining({ draft_id: winner.id, accepted_version: 1 })]);
    expect(saved.drafts.filter(row => row.status === "accepted")).toHaveLength(1);
    expect(saved.drafts.filter(row => row.status === "draft")).toHaveLength(1);
  });

  it.each(["done", "version"] as const)("rejects an own task whose %s changed after the draft", async (change) => {
    const task = await ownTask();
    const draft = await seedDraft({ tasks: [task], suggestions: [suggestion(null)] });
    if (change === "done") await fixture.sql`UPDATE opening_tasks SET status='done', version=version+1 WHERE id=${task.id}`;
    else await fixture.sql`UPDATE opening_tasks SET title='Edited assignment', version=version+1 WHERE id=${task.id}`;
    await rejectsAtomically(acceptance(draft.id), { code: "CONFLICT", reason: "task_changed" });
  });

  it.each(["done", "version"] as const)("does not revive an existing suggested task with changed %s and rolls back earlier inserts", async (change) => {
    const { courseId } = await seedCourse();
    const item = suggestion(courseId), preceding = suggestion(null);
    await insertExistingSuggestion(item, change === "done" ? "done" : "pending", change === "version" ? 2 : 1);
    const draft = await seedDraft({ suggestions: [preceding, item] });
    await rejectsAtomically(acceptance(draft.id), { code: "CONFLICT", reason: "task_changed" });
    expect((await ledger()).tasks).toHaveLength(1);
  });

  it("reuses an unchanged pre-existing planner task rather than creating a duplicate", async () => {
    const { courseId } = await seedCourse();
    const item = suggestion(courseId);
    await insertExistingSuggestion(item);
    const draft = await seedDraft({ suggestions: [item] });
    await repository().acceptPlan(fixture.scope, acceptance(draft.id));
    expect((await ledger()).tasks.map(row => row.id)).toEqual([item.id]);
  });

  it.each(["archived", "privacy_excluded", "membership_removed"] as const)("revalidates %s material and rolls back a previously inserted review task", async (change) => {
    const { courseId, sourceId } = await seedCourse();
    const first = suggestion(null), unavailable = suggestion(courseId);
    const draft = await seedDraft({ suggestions: [first, unavailable] });
    if (change === "archived") await fixture.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    else if (change === "privacy_excluded") await backupRows(fixture.sql, fixture.scope).exclude(sourceId);
    else await fixture.sql`DELETE FROM course_asset_memberships WHERE course_id=${courseId} AND asset_id=${sourceId}`;
    await rejectsAtomically(acceptance(draft.id), { code: "CONFLICT", reason: "source_unavailable" });
  });

  it("refuses an expired adaptive slot without writing any acceptance state", async () => {
    const draft = await seedDraft({ suggestions: [suggestion(null)] });
    await rejectsAtomically(acceptance(draft.id), { code: "CONFLICT", reason: "slot_expired" }, new Date(at(9, 1)));
  });

  it("rejects a changed base version without partial task creation", async () => {
    const draft = await seedDraft({ suggestions: [suggestion(null)] });
    await rejectsAtomically(acceptance(draft.id, { expectedBaseVersion: 1 }), { code: "CONFLICT", reason: "stale_version" });
  });

  it("keeps ordinary versioned drafts compatible with historical slots and idempotent receipts", async () => {
    const task = await ownTask();
    const past = { ...block(task.id, 0, task.minutes), start: at(7), end: at(7, 20) };
    const draft = await seedDraft({ tasks: [task], blocks: [past], plain: true });
    const input = acceptance(draft.id);
    const accepted = await repository().acceptPlan(fixture.scope, input);
    expect(accepted).toMatchObject({ status: "accepted", version: 1, blocks: [past] });
    expect(accepted.strategyVersion).toBeUndefined();
    await fixture.sql`UPDATE opening_tasks SET status='done', version=version+1 WHERE id=${task.id}`;
    const before = await ledger();
    expect(await repository().acceptPlan(fixture.scope, { ...input, acceptSuggestedKeys: [] })).toEqual(accepted);
    expect(await ledger()).toEqual(before);
  });

  it("does not let another workspace or a mismatched owner accept or inspect this draft", async () => {
    const draft = await seedDraft({ suggestions: [suggestion(null)] });
    const before = await ledger();
    const otherBefore = await ledger(fixture.otherScope);
    for (const scope of [fixture.otherScope, { ...fixture.scope, ownerUserId: fixture.otherScope.ownerUserId }]) {
      await expect(repository().acceptPlan(scope, acceptance(draft.id))).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(await ledger()).toEqual(before);
    expect(await ledger(fixture.otherScope)).toEqual(otherBefore);
  });

  it("rejects a stored block that references another workspace's task", async () => {
    const otherTask = await repository().createTask(fixture.otherScope, {
      title: "Other owner's task", minutes: 20, dueAt: null, priority: 1, candidateId: null,
    });
    const draft = await seedDraft({ tasks: [otherTask], suggestions: [suggestion(null)] });
    const otherBefore = await ledger(fixture.otherScope);
    await rejectsAtomically(acceptance(draft.id), { code: "CONFLICT", reason: "task_changed" });
    expect(await ledger(fixture.otherScope)).toEqual(otherBefore);
  });
});
