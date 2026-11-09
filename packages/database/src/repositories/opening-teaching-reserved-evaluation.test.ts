import { describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import { evaluateOpeningTeachingReservedAttempt } from "./opening-teaching-reserved-evaluation";
import type { TeachingQuestionSpec } from "./opening-teaching-question";

const ports = vi.hoisted(() => ({ key: vi.fn(), replay: vi.fn() }));
vi.mock("./opening-course-reserved-selection", () => ({ readOpeningReservedKey: ports.key }));
vi.mock("./opening-course-route-reserved-start", () => ({ assertCourseReservedReplay: ports.replay }));
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const sources = [{ sourceId: id(3), version: 1 }];
const spec: TeachingQuestionSpec = { kind: "teaching_question", specVersion: "teaching-question-v1", activityId: id(4),
  teachingUnitId: id(5), documentId: id(6), revisionId: id(7), revisionNumber: 1, contentVersion: 1,
  blockId: id(8), answerBlockId: null, sourceRefs: sources,
  courseRequirement: { id: id(9), revision: 1, stableSkillId: id(10), requirementKey: "arithmetic" } };
const attempt = { id: id(11), item_version_id: id(12), problem_id: id(13), course_id: id(14) };
function setup(overrides: Record<string, unknown> = {}, missing = false) {
  const row = { id: spec.activityId, course_id: attempt.course_id, evaluation_spec: spec, stem_snapshot: "137*19",
    blocks: [{ id: spec.blockId, type: "prompt", content: { text: "137*19", interaction: { kind: "numeric" } } }],
    block_order: [{ blockId: spec.blockId, blockType: "prompt", role: "prompt", position: 0 }], source_refs: sources,
    reserved_requirement_id: id(9), reserved_requirement_revision: 1, create_intent: { taskId: id(15) },
    goal_json: { courseRoute: { goalId: id(16), goalRevision: 1, requirementId: id(9), requirementRevision: 1,
      stableSkillId: id(10), requirementKey: "arithmetic", action: "transfer_check", retestId: id(17) },
      reservedStart: { taskId: id(15), taskVersion: 1 }, learningBudget: { minutes: 20 } }, ...overrides };
  ports.key.mockReset().mockResolvedValue({ text: "137*19", answer: "2603", interaction: { kind: "numeric" }, sourceRefs: sources });
  ports.replay.mockReset().mockResolvedValue(undefined);
  const query = vi.fn(async (parts: TemplateStringsArray) => parts.join("").includes("SELECT requirement.id") ? [{ id: id(9) }] : missing ? [] : [row]);
  return { query, run: (answer = "2603", saved = spec) => evaluateOpeningTeachingReservedAttempt(query as unknown as TransactionSql, scope, attempt, saved, answer) };
}
describe("private issued arithmetic authority", () => {
  it.each([["2603", "correct"], ["2604", "incorrect"]])("grades %s as %s without releasing key or granting independence", async (answer, decision) => {
    const f = setup(), result = await f.run(answer);
    expect(result).toEqual({ evaluatorVersion: "teaching-key-exact-v1", specVersion: "teaching-key-v1", decision, outcome: decision,
      reasonCodes: [decision === "correct" ? "teaching_key_match" : "teaching_key_mismatch"], priorFeedback: true });
    expect(ports.key).toHaveBeenCalledWith(expect.anything(), scope, attempt.item_version_id);
    expect(ports.replay).toHaveBeenCalledWith(expect.anything(), expect.anything(), scope, attempt.course_id, expect.anything(),
      expect.objectContaining({ taskId: id(15), expectedTaskVersion: 1 }));
    expect(JSON.stringify(result)).not.toMatch(/2603|answer|keyRef/);
  });
  it.each(["", "2603+0", "2603 m", "not a number"])("withholds authority for nonnumeric answer %j", async answer => {
    expect(await setup().run(answer)).toBeNull();
  });
  it.each([
    { blocks: [] }, { block_order: [] }, { stem_snapshot: "other stem" }, { reserved_requirement_revision: 2 },
    { blocks: [{ id: spec.blockId, type: "prompt", content: { text: "137^19", interaction: { kind: "numeric" } } }], stem_snapshot: "137^19" },
    { blocks: [{ id: spec.blockId, type: "prompt", content: { text: "137*19", interaction: { kind: "numeric", unit: "m" } } }] },
    { blocks: [{ id: spec.blockId, type: "prompt", content: { text: "137*19", interaction: { kind: "numeric" }, figure: "hidden" } }] },
    { blocks: [{ id: spec.blockId, type: "prompt", content: { text: "137*19", interaction: { kind: "choice", options: [{ id: "A", label: "2603" }, { id: "B", label: "2604" }] } } }] },
    { goal_json: null }, { goal_json: {} }, { source_refs: [] },
  ])("rejects malformed or mismatched issued public content %j", async overrides => {
    expect(await setup(overrides).run()).toBeNull();
  });
  it.each([
    null, { text: "137+19", answer: "156", interaction: { kind: "numeric" }, sourceRefs: sources },
    { text: "137*19", answer: "2604", interaction: { kind: "numeric" }, sourceRefs: sources },
    { text: "137*19", answer: "unknown", interaction: { kind: "numeric" }, sourceRefs: sources },
    { text: "137*19", answer: "2603", interaction: { kind: "numeric", unit: "m" }, sourceRefs: sources },
    { text: "137*19", answer: "2603", interaction: { kind: "numeric" }, sourceRefs: [] },
  ])("requires an exact validated private key for this stem %j", async key => {
    const f = setup(); ports.key.mockResolvedValue(key);
    expect(await f.run()).toBeNull();
  });
  it("cannot choose another key via caller-looking spec IDs or a public answer block", async () => {
    const f = setup();
    expect(await f.run("2603", { ...spec, id: id(20) } as TeachingQuestionSpec)).toBeNull();
    expect(await f.run("2603", { ...spec, answerBlockId: id(20) })).toBeNull();
    expect(ports.key).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
    expect(await setup({}, true).run()).toBeNull();
  });
  it("propagates stale original purpose/task/protocol rejection without capturing a new pin", async () => {
    const f = setup(); ports.replay.mockRejectedValue(Object.assign(new Error("stale original pin"), { code: "CONFLICT" }));
    await expect(f.run()).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
