import type { Sql } from "postgres";
import { expect, it, vi } from "vitest";

const fence = vi.hoisted(() => ({ call: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./opening-learning-facts", () => ({ lockWorkspaceLearningHistory: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./opening-tutor-stream-fence", () => ({ fenceCancelledOpeningTutorStream: fence.call }));

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
