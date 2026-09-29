import { describe, expect, it } from "vitest";
import { validateOpeningRestore, type OpeningBackup } from "./backup-policy";

const SOURCE = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const OWNER = "33333333-3333-4333-8333-333333333333";
const COURSE = "44444444-4444-4444-8444-444444444444";
const TASK = "55555555-5555-4555-8555-555555555555";
const ACTIVITY = "66666666-6666-4666-8666-666666666666";
const JOB = "77777777-7777-4777-8777-777777777777";
const CONVERSATION = "88888888-8888-4888-8888-888888888888";
const CANDIDATE = "99999999-9999-4999-8999-999999999999";
const TURN = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const FOREIGN_OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function backup(overrides: Partial<OpeningBackup> = {}): OpeningBackup {
  return {
    format: "opening-backup",
    version: 1,
    workspaceId: WORKSPACE,
    privacyEpoch: 4,
    deletionJournal: [{ sourceId: SOURCE, deletedAt: "2026-09-21T00:00:00.000Z" }],
    tables: { opening_sources: [{ id: SOURCE, workspace_id: WORKSPACE, version: 1, bytes: 12, sha256: "ab".repeat(32) }] },
    objects: [{ sourceId: SOURCE, sha256: "ab".repeat(32), bytes: 12, archivePath: "objects/a.bin" }],
    ...overrides,
  };
}

describe("opening restore preview", () => {
  it("rejects a deleted source, a wrong hash, and an unknown backup version", () => {
    const deleted = validateOpeningRestore(backup(), [{ sourceId: SOURCE, deletedAt: "2026-09-22T00:00:00.000Z" }]);
    expect(deleted.allowed).toBe(false);
    expect(deleted.errors.join(" ")).toMatch(/deleted/i);

    const wrongHash = validateOpeningRestore(
      backup({ deletionJournal: [], objects: [{ sourceId: SOURCE, sha256: "cd".repeat(32), bytes: 12, archivePath: "objects/a.bin", actualSha256: "ab".repeat(32) }] }),
      [],
    );
    expect(wrongHash.allowed).toBe(false);
    expect(wrongHash.errors.join(" ")).toMatch(/hash/i);

    const unknown = validateOpeningRestore({ ...backup({ deletionJournal: [] }), version: 2 }, []);
    expect(unknown.allowed).toBe(false);
    expect(unknown.errors.join(" ")).toMatch(/version/i);
  });

  it("rejects transport candidate references and dangling activity links", () => {
    const result = validateOpeningRestore(backup({
      deletionJournal: [],
      tables: {
        opening_sources: [{ id: SOURCE, workspace_id: WORKSPACE, version: 1, bytes: 12, sha256: "ab".repeat(32) }],
        opening_tasks: [{ id: TASK, workspace_id: WORKSPACE, owner_user_id: OWNER, candidate_id: JOB }],
        opening_retest_activities: [{
          id: ACTIVITY, workspace_id: WORKSPACE, owner_user_id: OWNER, course_id: COURSE,
          candidate_id: JOB, task_id: "88888888-8888-4888-8888-888888888888",
          reopened_from_activity_id: "99999999-9999-4999-8999-999999999999",
        }],
        opening_learning_observations: [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspace_id: WORKSPACE, owner_user_id: OWNER,
          retest_id: JOB,
        }],
      },
    }), []);

    expect(result.allowed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/candidate.*transport|transport.*candidate/i);
    expect(result.errors.join(" ")).toMatch(/task/i);
    expect(result.errors.join(" ")).toMatch(/reopened|activity/i);
  });

  it("accepts sanitized activity references that are present in the backup", () => {
    const result = validateOpeningRestore(backup({
      deletionJournal: [],
      tables: {
        opening_sources: [{ id: SOURCE, workspace_id: WORKSPACE, version: 1, bytes: 12, sha256: "ab".repeat(32) }],
        opening_tasks: [{ id: TASK, workspace_id: WORKSPACE, owner_user_id: OWNER, candidate_id: null }],
        opening_retest_activities: [{
          id: ACTIVITY, workspace_id: WORKSPACE, owner_user_id: OWNER, course_id: COURSE, skill_label: "fractions",
          candidate_id: null, task_id: TASK, reopened_from_activity_id: null,
        }],
        opening_learning_observations: [{
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", workspace_id: WORKSPACE, owner_user_id: OWNER,
          course_id: COURSE, skill_label: "fractions", retest_id: ACTIVITY,
        }],
      },
    }), []);

    expect(result.allowed).toBe(true);
  });

  it("accepts a task reference to an included assistant candidate owned by the conversation", () => {
    const result = validateOpeningRestore(backup({
      deletionJournal: [],
      tables: {
        opening_sources: [{ id: SOURCE, workspace_id: WORKSPACE, version: 1, bytes: 12, sha256: "ab".repeat(32) }],
        opening_conversations: [{ id: CONVERSATION, workspace_id: WORKSPACE, owner_user_id: OWNER }],
        opening_turns: [{ id: TURN, workspace_id: WORKSPACE, conversation_id: CONVERSATION, role: "assistant", context_source_refs: [] }],
        opening_assistant_candidates: [{
          id: CANDIDATE, workspace_id: WORKSPACE, conversation_id: CONVERSATION, source_turn_id: TURN,
          source_ids: [], payload: {}, status: "accepted",
        }],
        opening_tasks: [{ id: TASK, workspace_id: WORKSPACE, owner_user_id: OWNER, candidate_id: CANDIDATE }],
      },
    }), []);

    expect(result.allowed).toBe(true);
  });

  it("rejects a task reference when the included assistant candidate belongs to another owner", () => {
    const result = validateOpeningRestore(backup({
      deletionJournal: [],
      tables: {
        opening_sources: [{ id: SOURCE, workspace_id: WORKSPACE, version: 1, bytes: 12, sha256: "ab".repeat(32) }],
        opening_conversations: [{ id: CONVERSATION, workspace_id: WORKSPACE, owner_user_id: FOREIGN_OWNER }],
        opening_turns: [{ id: TURN, workspace_id: WORKSPACE, conversation_id: CONVERSATION, role: "assistant", context_source_refs: [] }],
        opening_assistant_candidates: [{
          id: CANDIDATE, workspace_id: WORKSPACE, conversation_id: CONVERSATION, source_turn_id: TURN,
          source_ids: [], payload: {}, status: "accepted",
        }],
        opening_tasks: [{ id: TASK, workspace_id: WORKSPACE, owner_user_id: OWNER, candidate_id: CANDIDATE }],
      },
    }), []);

    expect(result.allowed).toBe(false);
    expect(result.errors.join(" ")).toMatch(/candidate.*owner|owner.*candidate/i);
  });
});
