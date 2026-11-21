import type { ConversationPlanMetadata } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { consumeOpeningConversationPlanCandidate, conversationPlanSuggestion } from "./opening-conversation-plan";
import { acceptOpeningPlan } from "./opening-plan-accept";
import { insertOpeningTaskWithOutcome } from "./opening-retest-task";

vi.mock("./opening-learning-management-draft", () => ({ assertOpeningLearningManagementDraft: vi.fn() }));
vi.mock("./opening-local-replan-validation", () => ({ validateOpeningLocalReplan: vi.fn() }));

const scope = { workspaceId: "11111111-1111-4111-8111-111111111111", ownerUserId: "22222222-2222-4222-8222-222222222222" };
const metadata: ConversationPlanMetadata = {
  kind: "conversation_plan_v1", candidateId: "33333333-3333-4333-8333-333333333333", expectedCandidateVersion: 0,
  sourceTurnId: "44444444-4444-4444-8444-444444444444", taskId: "55555555-5555-4555-8555-555555555555",
  sourceIds: [], title: "Do the exercise", minutes: 15, courseId: null, dueText: null,
};
const payload = { kind: "task", title: metadata.title, minutes: metadata.minutes, dueText: metadata.dueText };
const day = "2026-11-21";
const draftId = "77777777-7777-4777-8777-777777777777";
const draft = {
  id: draftId, day, origin: "agent", status: "draft", base_version: 0, hard_blocks_fingerprint: "",
  strategy_version: "local-replan-v1", input_snapshot: { conversationPlan: metadata },
  suggested_tasks: [conversationPlanSuggestion(metadata)],
  blocks: [{ taskId: metadata.taskId, start: `${day}T10:00:00Z`, end: `${day}T10:15:00Z`, reason: "Practice" }],
};

function deferred() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function blockedAcceptance(blockedRow: "candidate" | "task" | "course" | "planTaskInsert" | "planReceiptInsert", hasMemoryDependencies = true) {
  const waiting = deferred();
  const lock = deferred();
  const writes: string[] = [];
  const committedWrites: string[] = [];
  const probes: boolean[] = [];
  let clock = 0;
  const expiresAt = 1;
  async function read(query: string) {
    if (query.startsWith("SELECT id FROM workspaces") || query.startsWith("SELECT s.id FROM opening_sources")
      || query.startsWith("SELECT c.id FROM opening_assistant_candidates c JOIN") || query.startsWith("SELECT 1 FROM courses")) return [{ id: metadata.candidateId }];
    if (query.startsWith("SELECT c.payload")) {
      return [{ payload, source_turn_id: metadata.sourceTurnId, has_memory_dependencies: hasMemoryDependencies }];
    }
    if (query.startsWith("SELECT t.id FROM opening_turns")) {
      expect(query).toContain("clock_timestamp()");
      const active = clock < expiresAt;
      probes.push(active);
      return active ? [{ id: metadata.sourceTurnId }] : [];
    }
    if (query.startsWith("SELECT status, task_result_ref") || query.startsWith("SELECT c.id, c.status")) {
      expect(query).toContain("FOR UPDATE");
      if (blockedRow === "candidate") {
        waiting.release();
        await lock.promise;
      }
      return [{ id: metadata.candidateId, status: "pending", payload, source_turn_id: metadata.sourceTurnId, source_ids: [] }];
    }
    if (query.startsWith("SELECT id FROM opening_tasks")) {
      expect(query).toContain("FOR UPDATE");
      if (blockedRow === "task") {
        waiting.release();
        await lock.promise;
      }
      return [];
    }
    if (query.startsWith("SELECT day FROM opening_plan_drafts")) return [{ day }];
    if (query.startsWith("SELECT accepted_version, accepted_blocks")) {
      return [{ accepted_version: 0, accepted_blocks: [], hard_blocks_fingerprint: "" }];
    }
    if (query.startsWith("SELECT * FROM opening_plan_drafts")) return [draft];
    if (query.startsWith("SELECT draft_id, payload_hash") || query.startsWith("SELECT pg_advisory_xact_lock")
      || query.includes("opening_workspace_history_revisions")) return [];
    const insertsTask = query.startsWith("INSERT INTO opening_tasks");
    const insertsReceipt = query.startsWith("INSERT INTO opening_plan_acceptances");
    if (insertsTask || insertsReceipt || query.startsWith("UPDATE opening_assistant_candidates")
      || query.startsWith("INSERT INTO opening_plan_state") || query.startsWith("UPDATE opening_plan_state")
      || query.startsWith("UPDATE opening_plan_drafts")) {
      if ((insertsTask && (blockedRow === "course" || blockedRow === "planTaskInsert"))
        || (insertsReceipt && blockedRow === "planReceiptInsert")) {
        waiting.release();
        await lock.promise;
      }
      writes.push(query);
      if (query.startsWith("UPDATE opening_plan_drafts")) return [{ ...draft, status: "accepted", version: 1 }];
      return [{ id: metadata.taskId, title: payload.title, minutes: payload.minutes, priority: 0, status: "pending", version: 1 }];
    }
    throw new Error(`Unexpected SQL: ${query}`);
  }
  const tag = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const query = parts.reduce((text, part, index) => text + part + (index < values.length ? String(values[index]) : ""), "")
      .replace(/\s+/g, " ").trim();
    return { toString: () => query, then: (resolve: (rows: unknown[]) => unknown, reject: (error: unknown) => unknown) =>
      read(query).then(resolve, reject) };
  };
  const sql = Object.assign(tag, {
    json: JSON.stringify,
    begin: async (work: (tx: TransactionSql) => Promise<unknown>) => {
      const result = await work(tag as unknown as TransactionSql);
      committedWrites.push(...writes);
      return result;
    },
  }) as unknown as Sql;
  return { sql, waiting: waiting.promise, expireAncestor: () => { clock = expiresAt; },
    rollBackLockHolder: lock.release, writes, committedWrites, probes };
}

function acceptDirect(sql: Sql, courseId?: string) {
  return insertOpeningTaskWithOutcome(sql, scope, {
    candidateId: metadata.candidateId, title: metadata.title, minutes: metadata.minutes, dueAt: null, priority: 0, courseId,
  });
}

describe("task candidate acceptance after a row lock wait", () => {
  const acceptPlan = (sql: Sql) => sql.begin(tx =>
    consumeOpeningConversationPlanCandidate(tx, scope, metadata, conversationPlanSuggestion(metadata)));
  const cases = [
    { path: "direct accept", row: "candidate", accept: acceptDirect },
    { path: "conversation-plan accept", row: "candidate", accept: acceptPlan },
    { path: "conversation-plan accept", row: "task", accept: acceptPlan },
  ] as const;

  it.each(cases)("$path rejects expiry after the $row lock holder rolls back", async ({ row, accept }) => {
    const fixture = blockedAcceptance(row);
    const result = accept(fixture.sql);
    try {
      await Promise.race([fixture.waiting, result]);
      expect(fixture.probes).toEqual([true]);
      fixture.expireAncestor();
    } finally {
      // The prior holder rolls back without changing the pending candidate or creating a task.
      fixture.rollBackLockHolder();
    }
    await expect(result).rejects.toMatchObject({ code: "VALIDATION", message: "task candidate memory dependency is no longer active" });
    expect(fixture.probes).toEqual([true, false]);
    expect(fixture.writes).toEqual([]);
  });

  it("rolls back direct acceptance when a course foreign-key lock delays task insertion past expiry", async () => {
    const fixture = blockedAcceptance("course");
    const result = acceptDirect(fixture.sql, "66666666-6666-4666-8666-666666666666");
    try {
      await Promise.race([fixture.waiting, result]);
      expect(fixture.probes).toEqual([true, true]);
      fixture.expireAncestor();
    } finally {
      fixture.rollBackLockHolder();
    }
    await expect(result).rejects.toMatchObject({ code: "VALIDATION", message: "task candidate memory dependency is no longer active" });
    expect(fixture.probes).toEqual([true, true, false]);
    expect(fixture.writes).toEqual([
      expect.stringContaining("INSERT INTO opening_tasks"),
      expect.stringContaining("UPDATE opening_assistant_candidates"),
    ]);
    expect(fixture.committedWrites).toEqual([]);
  });

  it.each(cases.filter(({ row }) => row === "candidate"))("$path skips recursive checks for independent candidates", async ({ row, accept }) => {
    const fixture = blockedAcceptance(row, false);
    fixture.rollBackLockHolder();
    await expect(accept(fixture.sql)).resolves.toBeDefined();
    expect(fixture.probes).toEqual([]);
    expect(fixture.writes).toHaveLength(2);
  });
});

describe("conversation-plan acceptance after a write lock wait", () => {
  it.each([
    { blockedWrite: "planTaskInsert", laterWrites: [] },
    {
      blockedWrite: "planReceiptInsert",
      laterWrites: ["UPDATE opening_plan_state", "UPDATE opening_plan_drafts", "INSERT INTO opening_plan_acceptances"],
    },
  ] as const)("rolls back all writes when memory expires during $blockedWrite", async ({ blockedWrite, laterWrites }) => {
    const fixture = blockedAcceptance(blockedWrite);
    const result = acceptOpeningPlan(fixture.sql, scope, { draftId, expectedBaseVersion: 0, clientKey: "accept-plan" },
      new Date(`${day}T09:00:00Z`));
    try {
      await Promise.race([fixture.waiting, result]);
      expect(fixture.probes).toContain(true);
      fixture.expireAncestor();
    } finally {
      fixture.rollBackLockHolder();
    }
    await expect(result).rejects.toMatchObject({ code: "VALIDATION", message: "task candidate memory dependency is no longer active" });
    expect(fixture.probes.at(-1)).toBe(false);
    expect(fixture.writes).toEqual([
      "INSERT INTO opening_plan_state", "INSERT INTO opening_tasks", "UPDATE opening_assistant_candidates", ...laterWrites,
    ].map(prefix => expect.stringContaining(prefix)));
    expect(fixture.committedWrites).toEqual([]);
  });
});
