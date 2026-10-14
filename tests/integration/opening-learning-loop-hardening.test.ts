import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSqlClient, applyMigrations, createIdentityRepository, createOpeningOnboardingRepository, createOpeningPlanningAgentRepository,
  createOpeningGuidanceSettingsRepository, createOpeningPlanningSettingsRepository, createOpeningPlansRepository } from "@aistudy/database";
import { DEFAULT_OPENING_GUIDANCE_SETTINGS, type Scope } from "@aistudy/contracts";
const url = process.env.DATABASE_URL;
if (!url) throw new Error("isolated DATABASE_URL is required");
const sql = createSqlClient(url);
async function workspace(): Promise<Scope> {
  const { user, workspace } = await createIdentityRepository(sql).createUserWithWorkspace({ email: `loop-${randomUUID()}@example.com`, displayName: "Learning test", passwordHash: "unused-test-only" });
  return { workspaceId: workspace.id, ownerUserId: user.id };
}
function intent(key = randomUUID()) { return { action: "complete" as const, clientKey: key, subject: "线性代数", scenario: "final" as const,
  examDate: null, timeZone: "Asia/Shanghai", sourceIds: [] as string[] }; }
beforeAll(async () => { await applyMigrations(sql); });
afterAll(async () => { await sql.end({ timeout: 5 }); });
describe("opening first-run and saved guidance", () => {
  it("detects provisioned empty accounts and atomically saves real intent, settings, course and tasks", async () => {
    const scope = await workspace(), repo = createOpeningOnboardingRepository(sql);
    expect((await repo.status(scope)).needsOnboarding).toBe(true);
    const input = intent(), results = await Promise.all([repo.complete(scope, input), repo.complete(scope, input)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0]!.taskIds).toHaveLength(3);
    expect((await repo.status(scope)).needsOnboarding).toBe(false);
    const tasks = await createOpeningPlansRepository(sql).listTasks(scope);
    expect(tasks).toHaveLength(3);
    expect(tasks.every(t => t.courseId === results[0]!.courseId && t.dueAt === null)).toBe(true);
    expect((await createOpeningPlanningSettingsRepository(sql).get(scope)).saved).toBe(true);
    await expect(repo.complete(scope, intent())).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("does not manufacture learning sessions or assessment evidence", async () => {
    const scope = await workspace();
    await createOpeningOnboardingRepository(sql).complete(scope, intent());
    const rows = await sql`SELECT opening_onboarding FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
    expect(rows[0]!.opening_onboarding.goal.status).toBe("unobserved");
    const counts = await sql`SELECT count(*)::int AS n FROM opening_learning_sessions WHERE workspace_id=${scope.workspaceId}`;
    expect(counts[0]!.n).toBe(0);
  });
  it("supports a material-first skip and denies cross-workspace onboarding reads", async () => {
    const a = await workspace(), b = await workspace(), repo = createOpeningOnboardingRepository(sql);
    await expect(repo.status({ ...a, ownerUserId: b.ownerUserId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await repo.complete(a, { action: "skip", clientKey: randomUUID() });
    expect((await repo.status(a)).needsOnboarding).toBe(false);
    expect(await createOpeningPlansRepository(sql).listTasks(a)).toHaveLength(0);
    expect((await createOpeningPlanningSettingsRepository(sql).get(a)).saved).toBe(false);
  });
  it("rolls back all first-run work when a source is not authorized", async () => {
    const scope = await workspace(), repo = createOpeningOnboardingRepository(sql);
    await expect(repo.complete(scope, { ...intent(), sourceIds: [randomUUID()] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await repo.status(scope)).needsOnboarding).toBe(true);
    expect(await createOpeningPlansRepository(sql).listTasks(scope)).toHaveLength(0);
  });
  it("persists bounded coach preferences without enabling automatic mutations", async () => {
    const scope = await workspace(), other = await workspace(), repo = createOpeningGuidanceSettingsRepository(sql);
    expect(await repo.get(scope)).toEqual(DEFAULT_OPENING_GUIDANCE_SETTINGS);
    const saved = { mode: "coach", protectedSlots: [{ start: "19:00", end: "20:00" }], dailyMinutes: 45 };
    await repo.save(scope, saved);
    expect(await repo.get(scope)).toEqual(saved);
    await expect(repo.save({ ...scope, ownerUserId: other.ownerUserId }, saved)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.save(scope, { ...saved, dailyMinutes: -1 })).rejects.toThrow();
  });
});
describe("bounded agent runs and confirmation fences", () => {
  async function seeded() {
    const scope = await workspace();
    await createOpeningOnboardingRepository(sql).complete(scope, intent());
    const repo = createOpeningPlanningAgentRepository(sql), day = "2099-01-01";
    const snapshot = await repo.snapshot(scope, day);
    const task = snapshot.tasks[0]!;
    const blocks = [{ taskId: task.id, start: `${day}T10:00:00.000Z`, end: `${day}T10:10:00.000Z`, reason: "test" }];
    return { scope, repo, day, snapshot, blocks };
  }
  it("readonly snapshots never create daily drafts or accepted state", async () => {
    const { scope, snapshot } = await seeded();
    expect(snapshot.goal).toMatchObject({ subject: "线性代数", status: "unobserved" });
    const rows = await sql`SELECT count(*)::int AS n FROM opening_plan_drafts WHERE workspace_id=${scope.workspaceId}`;
    expect(rows[0]!.n).toBe(0);
    expect(snapshot.state).toBeNull();
  });
  it("allows only one concurrent run and replays completed results without re-execution", async () => {
    const { scope, repo } = await seeded();
    const input = { text: "安排今天", courseId: null, clientKey: randomUUID() };
    const results = await Promise.allSettled([repo.start(scope, input, 0), repo.start(scope, input, 0)]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    const run = results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof repo.start>>>;
    expect(run.value.kind).toBe("new");
    if (run.value.kind !== "new") throw new Error("expected new run");
    const result = { runId: run.value.id, message: "不需要修改", draft: null, tasks: [], timeZone: "Asia/Shanghai", modelCalls: 1 };
    await repo.complete(scope, run.value.id, result, 0);
    expect(await repo.start(scope, input, 0)).toEqual({ kind: "replayed", result });
    await expect(repo.start(scope, { ...input, text: "different" }, 0)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("redacts cached explanations when the workspace privacy epoch changes", async () => {
    const { scope, repo } = await seeded();
    const run = await repo.start(scope, { text: "安排今天", courseId: null, clientKey: randomUUID() }, 0);
    if (run.kind !== "new") throw new Error("expected new");
    await repo.complete(scope, run.id, { runId: run.id, message: "private derived summary", draft: null, tasks: [], timeZone: "Asia/Shanghai", modelCalls: 1 }, 0);
    await sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
    const rows = await sql`SELECT result,status FROM opening_planning_agent_runs WHERE id=${run.id}`;
    expect(rows[0]!.result).toBeNull();
    expect(rows[0]!.status).toBe("unknown");
  });
  it("does not re-run uncertain operations or expose a previous privacy epoch", async () => {
    const { scope, repo } = await seeded();
    const input = { text: "安排今天", courseId: null, clientKey: randomUUID() };
    const run = await repo.start(scope, input, 0);
    if (run.kind !== "new") throw new Error("expected new");
    await repo.fail(scope, run.id);
    await expect(repo.start(scope, input, 0)).rejects.toMatchObject({ code: "CONFLICT" });
    await sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
    await expect(repo.start(scope, input, 1)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("proposes without modifying formal state and accepts exactly once", async () => {
    const { scope, repo, day, snapshot, blocks } = await seeded();
    const draft = await repo.saveDraft(scope, { date: day, tasks: snapshot.tasks, free: [], blocks, unscheduledTaskIds: [], clientKey: randomUUID() },
      { stateHash: snapshot.stateHash, epoch: 0, expiresAt: new Date(Date.now() + 120000).toISOString() }, []);
    const plans = createOpeningPlansRepository(sql);
    expect(await plans.getToday(scope, day)).toBeNull();
    const input = { draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() };
    const accepted = await Promise.all([plans.acceptPlan(scope, input), plans.acceptPlan(scope, input)]);
    expect(accepted[0]).toEqual(accepted[1]);
    expect(accepted[0]!.status).toBe("accepted");
    expect((await plans.getToday(scope, day))?.acceptedVersion).toBe(1);
  });
  it.each(["task", "guidance", "privacy", "expired"])("rejects stale %s on confirmation", async cause => {
    const { scope, repo, day, snapshot, blocks } = await seeded();
    const draft = await repo.saveDraft(scope, { date: day, tasks: snapshot.tasks, free: [], blocks, unscheduledTaskIds: [], clientKey: randomUUID() },
      { stateHash: snapshot.stateHash, epoch: 0, expiresAt: new Date(Date.now() + 120000).toISOString() }, []);
    if (cause === "task") await sql`UPDATE opening_tasks SET version=version+1 WHERE id=${snapshot.tasks[0]!.id}`;
    if (cause === "guidance") await createOpeningGuidanceSettingsRepository(sql).save(scope, { ...DEFAULT_OPENING_GUIDANCE_SETTINGS, dailyMinutes: 30 });
    if (cause === "privacy") await sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
    if (cause === "expired") await sql`UPDATE opening_plan_drafts SET input_snapshot=jsonb_set(input_snapshot,'{agentGuard,expiresAt}','"2000-01-01T00:00:00Z"') WHERE id=${draft.id}`;
    await expect(createOpeningPlansRepository(sql).acceptPlan(scope, { draftId: draft.id, expectedBaseVersion: 0, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("makes rejection replay-safe while denying foreign ownership", async () => {
    const { scope, repo, day, snapshot, blocks } = await seeded();
    const draft = await repo.saveDraft(scope, { date: day, tasks: snapshot.tasks, free: [], blocks, unscheduledTaskIds: [], clientKey: randomUUID() },
      { stateHash: snapshot.stateHash, epoch: 0, expiresAt: new Date(Date.now() + 120000).toISOString() }, []);
    const plans = createOpeningPlansRepository(sql), other = await workspace();
    await expect(plans.rejectPlan(other, draft.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await plans.rejectPlan(scope, draft.id)).toEqual(await plans.rejectPlan(scope, draft.id));
  });
});
