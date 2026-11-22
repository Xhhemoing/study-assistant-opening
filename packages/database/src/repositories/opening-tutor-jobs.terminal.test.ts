import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";

const fence = vi.hoisted(() => ({ call: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./opening-tutor-stream-fence", async original => ({
  ...await original<typeof import("./opening-tutor-stream-fence")>(),
  fenceCancelledOpeningTutorStream: fence.call,
}));

import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";

const mixedWorkspaceId = "ABCDEFAB-ABCD-4ABC-8ABC-ABCDEFABCDEF";
const mixedJobId = "12345678-1234-4123-8123-123456789ABC";
const canonicalWorkspaceId = mixedWorkspaceId.toLowerCase();
const canonicalJobId = mixedJobId.toLowerCase();

function fakeSql(events: string[]) {
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("SELECT owner_user_id FROM workspaces")) {
      return Promise.resolve([{ owner_user_id: "owner" }]);
    }
    if (query.includes("SELECT id, owner_user_id FROM workspaces")) {
      return Promise.resolve([{ id: canonicalWorkspaceId, owner_user_id: "owner" }]);
    }
    if (query.includes("UPDATE opening_tutor_jobs SET status = 'failed'")) {
      return Promise.resolve([{
        id: canonicalJobId, workspace_id: canonicalWorkspaceId, assistant_turn_id: "assistant", timing_execution_id: "execution",
      }]);
    }
    if (query.includes("UPDATE opening_tutor_jobs SET status = 'outcome_unknown'")) {
      return Promise.resolve([{
        id: canonicalJobId, workspace_id: canonicalWorkspaceId, assistant_turn_id: "assistant", timing_execution_id: "execution",
      }]);
    }
    if (query.includes("UPDATE opening_turns")) {
      events.push("turn");
      return Promise.resolve([]);
    }
    throw new Error(`unexpected query ${query} values ${JSON.stringify(values)}`);
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return sql;
}

it.each(["fail", "markUnknown"] as const)(
  "%s fences using returned canonical IDs after updating the terminal turn",
  async method => {
    fence.call.mockClear();
    const events: string[] = [];
    fence.call.mockImplementation(async () => { events.push("fence"); });
    const sql = fakeSql(events);
    const jobs = createOpeningTutorJobsRepository(sql, { tutorStreamRedisUrl: "redis://localhost:6379" });
    const repositoryMethod = method === "fail"
      ? jobs.fail({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "failed", undefined, "claim")
      : jobs.markUnknown({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "unknown", "claim");

    await repositoryMethod;
    expect(fence.call).toHaveBeenCalledWith(canonicalWorkspaceId, canonicalJobId, "execution", "redis://localhost:6379");
    expect(events).toEqual(["turn", "fence"]);
  },
);

it.each(["fail", "markUnknown", "cancel"] as const)(
  "%s commits PostgreSQL termination and clears timing_execution_id even during a Redis outage",
  async method => {
    fence.call.mockReset();
    fence.call.mockRejectedValueOnce(new Error("Redis fence timed out"));
    const queries: string[] = [];
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      queries.push(query);
      if (query.includes("SELECT owner_user_id FROM workspaces")) return Promise.resolve([{ owner_user_id: "owner" }]);
      if (query.includes("SELECT id, owner_user_id FROM workspaces")) {
        return Promise.resolve([{ id: canonicalWorkspaceId, owner_user_id: "owner" }]);
      }
      if (query.includes("UPDATE opening_tutor_jobs j")) {
        return Promise.resolve([{
          id: canonicalJobId, workspace_id: canonicalWorkspaceId, conversation_id: "conv",
          user_turn_id: "user", assistant_turn_id: "assistant", status: "cancelled", mode: "hint",
          error: { message: "cancelled by user" }, created_at: "2026-11-20T00:00:00.000Z",
          updated_at: "2026-11-20T00:00:01.000Z", timing_execution_id: null, prior_execution_id: "execution",
        }]);
      }
      if (query.includes("UPDATE opening_tutor_jobs SET status =")) {
        return Promise.resolve([{
          id: canonicalJobId, workspace_id: canonicalWorkspaceId, assistant_turn_id: "assistant", timing_execution_id: "execution",
        }]);
      }
      if (query.includes("UPDATE opening_turns")) return Promise.resolve([]);
      throw new Error(`unexpected query ${query} values ${JSON.stringify(values)}`);
    }) as unknown as Sql;
    sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
    sql.json = ((value: unknown) => value) as Sql["json"];

    const jobs = createOpeningTutorJobsRepository(sql, { tutorStreamRedisUrl: "redis://localhost:6379" });
    if (method === "fail") {
      await expect(jobs.fail({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "failed", undefined, "claim"))
        .resolves.toBeUndefined();
    } else if (method === "markUnknown") {
      await expect(jobs.markUnknown({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId, "unknown", "claim"))
        .resolves.toBeUndefined();
    } else {
      await expect(jobs.cancel({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId))
        .resolves.toMatchObject({ id: canonicalJobId, status: "cancelled" });
    }
    expect(queries.some(query => query.includes("timing_execution_id = NULL"))).toBe(true);
    expect(fence.call).toHaveBeenCalledWith(canonicalWorkspaceId, canonicalJobId, "execution", "redis://localhost:6379");
  },
);

it("returns from cancel immediately without blocking on a hung post-commit Redis seal", async () => {
  fence.call.mockReset();
  fence.call.mockImplementationOnce(() => new Promise<void>(() => undefined));
  const sql = ((strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("SELECT owner_user_id FROM workspaces")) return Promise.resolve([{ owner_user_id: "owner" }]);
    if (query.includes("SELECT id, owner_user_id FROM workspaces")) return Promise.resolve([{ id: canonicalWorkspaceId, owner_user_id: "owner" }]);
    if (query.includes("UPDATE opening_tutor_jobs j")) {
      return Promise.resolve([{
        id: canonicalJobId, workspace_id: canonicalWorkspaceId, conversation_id: "conv",
        user_turn_id: "user", assistant_turn_id: "assistant", status: "cancelled", mode: "hint",
        error: { message: "cancelled by user" }, created_at: "2026-11-20T00:00:00.000Z",
        updated_at: "2026-11-20T00:00:01.000Z", timing_execution_id: null, prior_execution_id: "execution",
      }]);
    }
    if (query.includes("UPDATE opening_turns")) return Promise.resolve([]);
    throw new Error(`unexpected query ${query}`);
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];

  const jobs = createOpeningTutorJobsRepository(sql, { tutorStreamRedisUrl: "redis://localhost:6379" });
  await expect(jobs.cancel({ workspaceId: mixedWorkspaceId, ownerUserId: "owner" }, mixedJobId))
    .resolves.toMatchObject({ id: canonicalJobId, status: "cancelled" });
  expect(fence.call).toHaveBeenCalledWith(canonicalWorkspaceId, canonicalJobId, "execution", "redis://localhost:6379");
});

it("strips memoryDependencyIds metadata when appending completed-turn candidates", async () => {
  const docId = "11111111-1111-4111-8111-111111111111";
  const docId2 = "22222222-2222-4222-8222-222222222222";
  const memId = "33333333-3333-4333-8333-333333333333";
  const conversationId = "44444444-4444-4444-8444-444444444444";
  const assistantTurnId = "55555555-5555-4555-8555-555555555555";
  const userTurnId = "66666666-6666-4666-8666-666666666666";

  async function runWithRefs(contextSourceRefs: unknown) {
    const insertedSourceIds: unknown[] = [];
    const queries: string[] = [];
    const flatten = (value: unknown, values: unknown[]): string => {
      if (value && typeof value === "object" && "fragment" in value) {
        const nested = value as { strings: TemplateStringsArray; values: unknown[] };
        return nested.strings.reduce((acc, part, idx) => acc + part
          + (idx < nested.strings.length - 1 ? flatten(nested.values[idx], values) : ""), "");
      }
      values.push(value);
      return "?";
    };
    const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
      const fragment = { fragment: true, strings, values };
      return {
        ...fragment,
        then: (resolve: (rows: unknown[]) => void, reject: (error: unknown) => void) => {
          try {
            const flatValues: unknown[] = [];
            const query = flatten(fragment, flatValues);
            queries.push(query);
            if (query.includes("SELECT id FROM workspaces")) { resolve([{ id: canonicalWorkspaceId }]); return; }
            if (query.includes("FROM opening_tutor_jobs j")) {
              resolve([{
                conversation_id: conversationId,
                user_turn_id: userTurnId,
                mode: "explain",
                answer: "Saved answer",
                question: "Saved question",
                context_source_refs: contextSourceRefs,
              }]);
              return;
            }
            if (query.includes("INSERT INTO opening_assistant_candidates")) {
              insertedSourceIds.push(flatValues[4]);
              resolve([]);
              return;
            }
            throw new Error(`unexpected query ${query}`);
          } catch (error) {
            reject(error);
          }
        },
      };
    }) as unknown as Sql;
    sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
    sql.json = ((value: unknown) => value) as Sql["json"];

    const jobs = createOpeningTutorJobsRepository(sql);
    const ok = await jobs.appendCompletedTurnCandidates({
      scope: { workspaceId: canonicalWorkspaceId, ownerUserId: "owner" },
      jobId: canonicalJobId,
      assistantTurnId,
      candidates: [{ kind: "memory", text: "Candidate fact", temporary: false }],
    });
    return { ok, insertedSourceIds, queries };
  }

  // 1. Memory-only turn (documentless global memory): source_ids must be [], never [null].
  const memoryOnly = await runWithRefs([{ memoryDependencyIds: [memId] }]);
  expect(memoryOnly.ok).toBe(true);
  expect(memoryOnly.insertedSourceIds).toEqual([[]]);
  expect(memoryOnly.queries.some(q => q.includes("FROM opening_memories m") && q.includes("clock_timestamp()"))).toBe(true);

  // 2. Mixed document + memoryDependencyIds turn: source_ids keeps only canonical deduplicated document IDs.
  const mixed = await runWithRefs([
    { sourceId: docId.toUpperCase(), sourceVersion: 0, memoryOnly: true },
    { sourceId: docId2, sourceVersion: 1 },
    { sourceId: docId, sourceVersion: 1 },
    { memoryDependencyIds: [memId] },
  ]);
  expect(mixed.ok).toBe(true);
  expect(mixed.insertedSourceIds).toEqual([[docId, docId2]]);

  // 3. Malformed context_source_refs fails closed without inserting candidates.
  const malformed = await runWithRefs([{ memoryDependencyIds: [] }]);
  expect(malformed.ok).toBe(false);
  expect(malformed.insertedSourceIds).toEqual([]);
});
