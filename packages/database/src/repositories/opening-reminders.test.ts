import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { createOpeningReminderRepository } from "./opening-reminders";

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const taskId = "33333333-3333-4333-8333-333333333333";
const otherTaskId = "44444444-4444-4444-8444-444444444444";
const courseId = "55555555-5555-4555-8555-555555555555";
const dueAt = "2026-09-28T00:00:00.000Z";
const now = new Date("2026-09-30T04:00:00.000Z");
const single = { clientKey: "single-due-request", channel: "in_app" as const, taskId, expectedVersion: 1 };

/** SQL is the external boundary. Lock and SQL semantics are covered by integration tests. */
function fixture(options: { linked?: boolean; status?: string; version?: number; dueAt?: string; privacyEpoch?: number; config?: unknown } = {}) {
  const tasks = [
    { id: taskId, title: "Selected task", due_at: options.dueAt ?? dueAt, status: options.status ?? "pending", version: options.version ?? 1 },
    { id: otherTaskId, title: "Unrelated old task", due_at: dueAt, status: "pending", version: 1 },
  ];
  const activity = { id: "66666666-6666-4666-8666-666666666666", evidence_cycle_id: "77777777-7777-4777-8777-777777777777",
    course_id: courseId, skill_label: "ratios", task_id: taskId, status: "accepted", version: 2,
    accepted_at: dueAt, recommended_at: options.dueAt ?? dueAt };
  const jobs: Array<Record<string, unknown>> = [];
  const outbox: Array<{ jobId: unknown; payload: unknown }> = [];
  const tag = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown[]> => {
    const query = strings.join("?");
    if (query.includes("INSERT INTO opening_outbox")) {
      outbox.push({ jobId: values[1], payload: values[2] });
      return [];
    }
    if (query.includes("FROM opening_outbox")) return outbox.filter(event => values.includes(event.jobId));
    if (query.includes("SELECT payload FROM opening_jobs")) return "config" in options ? [{ payload: options.config }] : [];
    if (query.includes("FROM workspaces w JOIN courses")) return [{ account_assessment: true, account_retest: false,
      account_reminders: false, archived_at: dueAt, retest_enabled_at: null, reminders_enabled_at: null }];
    if (query.includes("FROM workspaces")) return [{ id: scope.workspaceId, privacy_epoch: options.privacyEpoch ?? 0 }];
    if (query.includes("FROM courses")) return [{ id: courseId }];
    if (query.includes("FROM opening_retest_activities")) {
      return options.linked && (!values.some(value => value === otherTaskId)) ? [activity] : [];
    }
    if (query.includes("FROM opening_tasks")) {
      const selected = values.find(value => value === taskId || value === otherTaskId);
      return selected ? tasks.filter(task => task.id === selected) : tasks;
    }
    if (query.includes("INSERT INTO opening_jobs")) {
      const payload = values.find(value => !!value && typeof value === "object" && "taskId" in value);
      const row = { id: values[0], workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId,
        key: values.find(value => typeof value === "string" && value.startsWith("remind:")), payload, state: "queued", privacy_epoch: values.at(-1) };
      const existing = jobs.find(job => job.key === row.key);
      if (existing) return [];
      jobs.push(row);
      return [row];
    }
    if (query.includes("UPDATE opening_jobs")) {
      const row = jobs.find(job => values.includes(job.id));
      if (!row) return [];
      if (query.includes("result =")) {
        if (row.state !== "running") return [];
        row.state = values[0];
        row.payload = { ...(row.payload as object), ...(values[1] as object) };
        row.result = values[2];
        return [row];
      }
      row.payload = { ...(row.payload as object), ...(values[0] as object) };
      row.state = values[1];
      row.privacy_epoch = values[2];
      return [row];
    }
    if (query.includes("planning_settings FROM workspace_preferences")) {
      return [{ planning_settings: { timeZone: "Asia/Shanghai" } }];
    }
    if (query.includes("FROM opening_jobs")) return jobs;
    throw new Error(`Unexpected reminder SQL operation: ${query}`);
  };
  const sql = Object.assign(tag, { json: (value: unknown) => value,
    begin: async (run: (tx: Sql) => Promise<unknown>) => run(sql as unknown as Sql) }) as unknown as Sql;
  return { repo: createOpeningReminderRepository(sql), jobs, tasks, outbox };
}

describe("single due reminder repository", () => {
  const config = { enabled: true, recipientId: scope.ownerUserId, quietHours: null };
  it.each([
    null, [], "invalid", { ...config, enabled: "false" }, { ...config, enabled: null },
    { ...config, recipientId: { id: scope.ownerUserId } },
    { ...config, quietHours: { startMinute: 0, endMinute: "x" } },
    { ...config, quietHours: { startMinute: -1, endMinute: 1440 } },
    { ...config, quietHours: { startMinute: 0.5, endMinute: 60 } },
  ].map(stored => ({ stored })))("disables malformed persisted external configuration $stored", async ({ stored }) => {
    const { repo } = fixture({ config: stored });
    expect(await repo.getExternalConfig(scope)).toBeNull();
  });

  it.each([
    { ...config, enabled: false }, { ...config, recipientId: null },
    { ...config, quietHours: { startMinute: 1320, endMinute: 420 } },
  ])("preserves legitimate persisted configuration %j", async stored => {
    const { repo } = fixture({ config: stored });
    expect(await repo.getExternalConfig(scope)).toEqual(stored);
  });

  it("requeues a quiet attempt exactly once and writes no transport event after a failed CAS", async () => {
    const { repo, jobs, outbox } = fixture();
    const [first] = await repo.enqueue(scope, single, now);
    jobs[0]!.state = "running";
    const input = { receiptId: null, outcome: "quiet" as const, state: "queued" as const,
      availableAt: "2026-10-01T00:00:00.000Z" };
    expect(await repo.recordAttempt(first!.id, input)).toBe(true);
    expect(await repo.recordAttempt(first!.id, input)).toBe(false);
    expect(outbox).toEqual([
      { jobId: first!.id, payload: { jobId: first!.id, kind: "remind" } },
      { jobId: first!.id, payload: { jobId: first!.id, kind: "remind", availableAt: input.availableAt } },
    ]);
  });

  it("publishes one transport event for a new reminder and none for a replay", async () => {
    const { repo, outbox } = fixture();
    const [first] = await repo.enqueue(scope, single, now);
    await repo.enqueue(scope, single, now);
    expect(outbox).toEqual([{ jobId: first!.id, payload: { jobId: first!.id, kind: "remind" } }]);
  });
  it.each([null, "quiet"] as const)("repairs a legacy queued %s occurrence without duplicating its event", async outcome => {
    const { repo, jobs, outbox } = fixture();
    const [first] = await repo.enqueue(scope, single, now);
    outbox.splice(0);
    jobs[0]!.payload = { ...(jobs[0]!.payload as object), explicitDue: undefined, outcome };
    await repo.enqueue(scope, single, now);
    await repo.enqueue(scope, { ...single, clientKey: "legacy-replay" }, now);
    expect(jobs).toHaveLength(1);
    expect(outbox).toEqual([{ jobId: first!.id, payload: { jobId: first!.id, kind: "remind" } }]);
  });
  it("queues only the selected archived-course retest without reopening its automation", async () => {
    const { repo, jobs, outbox } = fixture({ linked: true });
    const result = await repo.enqueue(scope, single, now);
    expect(result.map(item => item.taskId)).toEqual([taskId]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({ taskId, taskVersion: 1, dueAt, explicitDue: true });
    expect(outbox).toHaveLength(1);
  });

  it("does not broaden an explicit manual task into other due tasks", async () => {
    const { repo } = fixture();
    expect((await repo.enqueue(scope, single, now)).map(item => item.taskId)).toEqual([taskId]);
  });

  it("rejects a stale task version", async () => {
    const { repo, jobs } = fixture({ version: 2 });
    await expect(repo.enqueue(scope, single, now)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(jobs).toEqual([]);
  });

  it.each([{ status: "done" }, { dueAt: "2026-10-02T00:00:00.000Z" }])("rejects a non-due selection %j", async options => {
    const { repo, jobs } = fixture(options);
    await expect(repo.enqueue(scope, single, now)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(jobs).toEqual([]);
  });

  it("uses the current workspace privacy epoch for a newly authorized occurrence", async () => {
    const { repo, jobs } = fixture({ privacyEpoch: 7 });
    await repo.enqueue(scope, single, now);
    expect(jobs[0]?.privacy_epoch).toBe(7);
  });

  it("replays the same selected occurrence without creating a second job", async () => {
    const { repo, jobs } = fixture({ linked: true });
    const first = await repo.enqueue(scope, single, now);
    expect(await repo.enqueue(scope, { ...single, clientKey: "another-click" }, now))
      .toMatchObject([{ id: first[0]!.id, taskId, created: false }]);
    expect(jobs).toHaveLength(1);
  });

  it("recovers only a known-unsent suppressed job for the selected occurrence", async () => {
    const { repo, jobs } = fixture({ linked: true });
    const first = await repo.enqueue(scope, single, now);
    const stored = jobs[0]!;
    stored.state = "succeeded";
    stored.payload = { ...(stored.payload as object), explicitDue: undefined, suppressed: true };
    expect(await repo.enqueue(scope, single, now)).toMatchObject([{ id: first[0]!.id, created: false }]);
    expect(stored).toMatchObject({ state: "queued", payload: { explicitDue: true, suppressed: false } });
    expect(jobs).toHaveLength(1);
  });

  it.each([
    { state: "succeeded", receiptId: "receipt", outcome: "acknowledged" },
    { state: "outcome_unknown", receiptId: null, outcome: "unknown" },
    { state: "failed", receiptId: null, outcome: "rate_limited" },
    { state: "failed", receiptId: null, outcome: "rejected" },
  ])("preserves a previous provider outcome without requeueing %j", async previous => {
    const { repo, jobs } = fixture();
    await repo.enqueue(scope, single, now);
    const stored = jobs[0]!;
    stored.state = previous.state;
    stored.payload = { ...(stored.payload as object), ...previous, explicitDue: undefined, suppressed: true };
    const before = structuredClone(stored);
    await repo.enqueue(scope, single, now);
    expect(stored).toEqual(before);
    expect(jobs).toHaveLength(1);
  });

  it("does not promote an automatic reminder already being processed", async () => {
    const { repo, jobs } = fixture();
    await repo.enqueue(scope, single, now);
    jobs[0]!.state = "running";
    jobs[0]!.payload = { ...(jobs[0]!.payload as object), explicitDue: undefined };
    await expect(repo.enqueue(scope, single, now)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(jobs[0]!.state).toBe("running");
  });

  it("lists an explicit archived-course in-app occurrence but not its changed version", async () => {
    const { repo, tasks } = fixture({ linked: true });
    await repo.enqueue(scope, single, now);
    expect((await repo.list(scope, now)).reminders.some(item => item.taskId === taskId)).toBe(true);
    tasks[0]!.version = 2;
    expect((await repo.list(scope, now)).reminders.some(item => item.taskId === taskId)).toBe(false);
  });
});
