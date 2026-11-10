import { afterEach, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { createOpeningAttemptService } from "./attempt-service";
import * as teachingEvaluator from "../../../../../../packages/database/src/repositories/opening-teaching-question-evaluation";

// Keep actual web submit -> LearningRepository -> observation dispatch ->
// teaching evaluator -> domain arithmetic. Only access/exposure/storage I/O
// and competing evaluators are replaced. No DB connection/model/DOM is used.
vi.mock("./auto-grade-policy", () => ({ resolveAutoGradePolicy: async () => ({ enabled: false, modelAvailable: false }) }));
vi.mock("@aistudy/database", async original => {
  const actual = await original<typeof import("@aistudy/database")>();
  return { ...actual,
    createOpeningLearningAttemptRepository: () => ({ assertAccess: async () => ({ id: id(1), sessionId: id(2), courseId: id(3),
      skillLabel: "arithmetic", sourceIds: [], problemId: id(4), itemVersionId: id(5), submittedAt: null }) }),
    readOpeningAttemptGradingUsesVision: async () => false,
    createOpeningLearningRepository: (sql: Sql) => ({ ...actual.createOpeningLearningRepository(sql), listDeliveredExposures: async () => [] }),
  };
});
vi.mock("../../../../../../packages/database/src/repositories/opening-learning-facts", async original => ({
  ...await original<typeof import("../../../../../../packages/database/src/repositories/opening-learning-facts")>(),
  lockWorkspaceLearningHistory: vi.fn(), lockLearningHistory: vi.fn(), admitLearningSources: async () => [],
  nextLearningHistoryRevision: async () => 1, nextWorkspaceLearningHistoryRevision: async () => 1,
  lockLearningSession: async () => ({ course_id: id(3), skill_label: "arithmetic", source_ids: [], activity_id: id(6) }),
}));
vi.mock("../../../../../../packages/database/src/repositories/opening-exam-integration-evaluation", () => ({ evaluateOpeningExamAttempt: async () => null }));
vi.mock("../../../../../../packages/database/src/repositories/opening-span-evaluation", () => ({ evaluateOpeningSpanAttempt: async () => null }));
vi.mock("../../../../../../packages/database/src/repositories/opening-matrix-evaluation", () => ({ evaluateOpeningMatrixAttempt: async () => null }));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(20), ownerUserId: id(21) };
const spec = { kind: "teaching_question", specVersion: "teaching-question-v1", activityId: id(6), teachingUnitId: id(7), documentId: id(8),
  revisionId: id(9), revisionNumber: 1, contentVersion: 1, blockId: id(10), answerBlockId: id(11) };
const stopBeforeWrites = new Error("intentional pre-write boundary");
function fixture(reference: string, stopAtInsert = false) {
  const blocks = [{ id: id(10), type: "prompt", content: { text: "2+2", interaction: { kind: "numeric" } } },
    { id: id(11), type: "answer_key", content: { answer: reference } }];
  const tx = vi.fn((parts: TemplateStringsArray, ..._values: unknown[]): unknown => {
    const query = parts.join("?").replace(/\s+/gu, " ").trim();
    if (query.startsWith("(v.teaching_revision_id IS NULL")) return { query };
    if (query.startsWith("FOR SHARE")) return { query };
    if (query.includes("clock_timestamp() AS at")) {
      if (stopAtInsert) return Promise.resolve([{ at: new Date("2026-11-10T12:00:00Z") }]);
      throw stopBeforeWrites;
    }
    if (query.startsWith("INSERT INTO opening_learning_observations")) throw stopBeforeWrites;
    if (query.includes("SELECT * FROM opening_learning_attempts")) return Promise.resolve([{ id: id(1), session_id: id(2), course_id: id(3),
      source_ids: [], problem_id: id(4), item_version_id: id(5), create_intent: { teachingBlock: { contentVersion: 1 } } }]);
    if (query.startsWith("SELECT v.evaluation_spec,r.blocks")) return Promise.resolve([{ evaluation_spec: spec, blocks }]);
    if (query.startsWith("SELECT r.blocks,s.block_order,s.source_refs")) return Promise.resolve([{ blocks, source_refs: [{ sourceId: id(12), version: 1 }],
      block_order: [{ blockId: id(10), position: 0, role: "prompt", blockType: "prompt" }, { blockId: id(11), position: 1, role: "answer_key", blockType: "answer_key" }] }]);
    if (query.startsWith("SELECT s.version,s.mime")) return Promise.resolve([{ version: 1, mime: "text/plain", has_figures: false }]);
    if (query.startsWith("SELECT status,content_version")) return Promise.resolve([{ status: "active", content_version: 1 }]);
    if (["SELECT id FROM workspaces", "SELECT * FROM opening_learning_observations", "SELECT status,checkpoint_json", "SELECT goal_json,create_intent FROM opening_teaching_activities", "SELECT o.id"]
      .some(prefix => query.startsWith(prefix))) return Promise.resolve([]);
    throw new Error(`Unexpected SQL: ${query}`);
  });
  Object.assign(tx, { json: (value: unknown) => value });
  const sql = Object.assign(tx, { begin: (fn: (tx: TransactionSql) => unknown) => fn(tx as unknown as TransactionSql) }) as unknown as Sql;
  return { sql, tx };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("web submit attempted row uses the real evaluator, never the client claim", () => {
  it.each([
    { key: "4", answer: "4", client: "incorrect", outcome: "correct", verdictSource: "deterministic" },
    { key: "4", answer: "5", client: "correct", outcome: "incorrect", verdictSource: "deterministic" },
    { key: "5", answer: "5", client: "correct", outcome: "correct", verdictSource: "self_report" },
    { key: "5", answer: "4", client: "incorrect", outcome: "incorrect", verdictSource: "self_report" },
  ])("key=$key answer=$answer client=$client -> $verdictSource/$outcome", async ({ key, answer, client, outcome, verdictSource }) => {
    const f = fixture(key, true);
    await expect(createOpeningAttemptService(f.sql).submit(scope, id(1), {
      clientKey: "real-teaching-insert-boundary", answer, outcome: client, assistance: "independent",
    })).rejects.toBe(stopBeforeWrites);
    const insert = f.tx.mock.calls.find(([parts]) => parts.join(" ").trimStart().startsWith("INSERT INTO opening_learning_observations"))!;
    expect(insert).toBeDefined();
    const values = insert.slice(1);
    expect(values[11]).toBe(outcome);
    expect(values[16]).toBe(verdictSource);
    const receipt = values.find(value => value && typeof value === "object" && "evaluatorVersion" in value);
    if (verdictSource === "deterministic") expect(receipt).toMatchObject({ evaluatorVersion: "teaching-key-exact-v1", decision: outcome, outcome });
    else expect(receipt).toBeUndefined();
    // The fake adapter throws before executing INSERT; no persistence claimed.
  });
});

describe("web submit reaches the real saved-key evaluator (pre-write only)", () => {
  for (const flag of [undefined, "1", "0", "garbage"]) {
    // #271 gates compilation/readiness, not evaluation of already-pinned attempts.
    it.each([
      { name: "correct answer despite client incorrect", key: "4", answer: "4", client: "incorrect", decision: "correct" },
      { name: "wrong answer despite client correct", key: "4", answer: "5", client: "correct", decision: "incorrect" },
      { name: "corrupted key must not authorize matching wrong answer", key: "5", answer: "5", client: "correct", decision: null },
      { name: "corrupted key must not punish correct answer", key: "5", answer: "4", client: "incorrect", decision: null },
      { name: "unparseable submission", key: "4", answer: "x", client: "correct", decision: null },
    ])(`compiler=${String(flag)}: $name`, async ({ key, answer, client, decision }) => {
      vi.stubEnv("OPENING_TEACHING_COMPILER_ENABLED", flag);
      vi.stubEnv("TEACHING_COMPILER_ENABLED", undefined);
      const f = fixture(key);
      const evaluator = vi.spyOn(teachingEvaluator, "evaluateOpeningTeachingKeyAttempt");
      await expect(createOpeningAttemptService(f.sql).submit(scope, id(1), {
        clientKey: "real-teaching-web-submit", answer, outcome: client, assistance: "independent",
      })).rejects.toBe(stopBeforeWrites);
      expect(evaluator).toHaveBeenCalledExactlyOnceWith(f.tx, scope, expect.objectContaining({ course_id: id(3), item_version_id: id(5) }), answer, []);
      const result = await evaluator.mock.results[0]!.value;
      if (decision === null) expect(result).toBeNull();
      else expect(result).toMatchObject({ evaluatorVersion: "teaching-key-exact-v1", decision, outcome: decision });
      for (const [parts] of f.tx.mock.calls) expect(parts.join(" ")).not.toMatch(/^\s*(?:INSERT|UPDATE|DELETE)\b/i);
    });
  }
});
