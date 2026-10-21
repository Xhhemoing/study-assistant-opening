import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import { TUTOR_FAILURE_MESSAGE, TUTOR_UNKNOWN_MESSAGE, TUTOR_CANCELLED_MESSAGE } from "@aistudy/domain";
import { createOpeningConversationRepository } from "./opening-conversations";
import { createOpeningTutorJobsRepository } from "./opening-tutor-jobs";

const id = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: id, ownerUserId: id };
const created = "2026-10-21T00:00:00Z";
const diagnostic = "SQL SELECT password FROM credentials at /private/server.ts:4";

function database(jobStatus: string, turnStatus: string) {
  const job = { id, workspace_id: id, conversation_id: id, user_turn_id: id, assistant_turn_id: id,
    status: jobStatus, error: { message: diagnostic }, mode: "explain", created_at: created, updated_at: created, turn_status: turnStatus };
  const turn = { id, conversation_id: id, mode: "explain", text: diagnostic, created_at: created, citations: [],
    job_status: jobStatus, job_error: job.error, system_query: null };
  const turns = [{ ...turn, role: "user", status: "complete" }, { ...turn, role: "assistant", status: turnStatus }];
  const sql = Object.assign(vi.fn((strings: TemplateStringsArray) => {
    const query = strings.join(" ");
    if (query.includes("SELECT id, title, course_id")) return [{ id, title: "history", course_id: null, updated_at: created }];
    if (query.includes("SELECT j.*") || query.includes("SELECT j.id, j.status")) return [job];
    if (query.includes("FROM opening_turns t")) return query.includes("t.status IN ('complete', 'pending')")
      ? turns.filter(row => row.status === "complete" || row.status === "pending") : turns;
    // Nested privacy SQL fragments are composed into the parent query, not read here.
    return [];
  }), { unsafe: () => "" });
  return sql as unknown as Sql;
}

describe("historical tutor privacy at repository reads", () => {
  it.each([
    ["failed", "failed", TUTOR_FAILURE_MESSAGE],
    ["cancelled", "failed", TUTOR_CANCELLED_MESSAGE],
    ["outcome_unknown", "outcome_unknown", TUTOR_UNKNOWN_MESSAGE],
    ["outcome_unknown", "pending", TUTOR_UNKNOWN_MESSAGE],
  ])("protects legacy %s/%s errors while preserving the user's technical question", async (jobStatus, turnStatus, expected) => {
    const sql = database(jobStatus, turnStatus);
    const jobs = createOpeningTutorJobsRepository(sql);
    const conversations = createOpeningConversationRepository(sql);
    expect((await jobs.get(scope, id))?.error?.message).toBe(expected);
    expect((await conversations.listTurns(scope, id)).map(turn => turn.text)).toEqual([diagnostic, expected]);
    expect((await conversations.loadContinuityTurns(scope, id)).map(turn => turn.text))
      .toEqual(turnStatus === "pending" ? [diagnostic, expected] : [diagnostic]);
    if (jobStatus === "outcome_unknown") expect(await jobs.findPendingForConversation(scope, id))
      .toMatchObject({ id, status: jobStatus, error: { message: expected } });
  });
  it("never rewrites a completed assistant answer because its text looks like an error", async () => {
    const conversations = createOpeningConversationRepository(database("succeeded", "complete"));
    expect((await conversations.listTurns(scope, id)).map(turn => turn.text)).toEqual([diagnostic, diagnostic]);
    expect((await conversations.loadContinuityTurns(scope, id)).map(turn => turn.text)).toEqual([diagnostic, diagnostic]);
  });
});
