import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JSONValue, Sql, TransactionSql } from "postgres";
import { teachingBlockRefSchema, type TeachingBlockRef } from "@aistudy/contracts";
import { readTeachingQuestionForAttempt } from "./opening-teaching-question";

const boundaries = vi.hoisted(() => ({
  getRevision: vi.fn(), update: vi.fn(), generate: vi.fn(), release: vi.fn(), route: vi.fn(),
}));
vi.mock("./library", () => ({
  LibraryError: class extends Error {},
  createLibraryRepository: () => ({ getRevision: boundaries.getRevision, updateDocumentInTx: boundaries.update }),
}));
vi.mock("./opening-study-exposure", () => ({
  generateOpeningStudyExposure: boundaries.generate, releaseOpeningStudyExposure: boundaries.release,
}));
vi.mock("./opening-course-route-origin", () => ({ assertOpeningCourseRouteCurrent: boundaries.route }));
import { createOpeningTeachingCommandsRepository } from "./opening-teaching-commands";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { workspaceId: id(1), ownerUserId: id(2) };
const activityId = id(3), unitId = id(4), documentId = id(5), exampleId = id(6), questionId = id(7), answerId = id(8);
const now = "2026-01-01T00:00:00.000Z";
type Case = {
  role: TeachingBlockRef["role"]; blockType: string;
  savedType?: string; content?: Record<string, unknown>; missingBody?: boolean;
};
// The fixture implements only the callback transaction and identity JSON helpers
// consumed below; the incomplete SQL driver adapter stays at the call boundary.
type FixtureSql = {
  (strings: TemplateStringsArray | unknown[], ...values: unknown[]): readonly unknown[] | Promise<unknown[]>;
  begin<T>(callback: (tx: TransactionSql) => T): T;
  json(value: JSONValue): JSONValue;
};
function fixture(testCase: Case) {
  const order = [
    { blockId: exampleId, position: 0, blockType: "example", role: "example" },
    { blockId: questionId, position: 1, blockType: testCase.blockType, role: testCase.role },
    { blockId: answerId, position: 2, blockType: "answer_key", role: "answer_key" },
  ];
  const blocks = [
    { id: exampleId, type: "example", content: { text: "求函数 f(x)=x^2 的导数。" } },
    ...testCase.missingBody ? [] : [{ id: questionId, type: testCase.savedType ?? testCase.blockType,
      content: testCase.content ?? { text: "计算 1/2+1/3" } }],
    { id: answerId, type: "answer_key", content: { answer: "5/6" } },
  ];
  const activity = { id: activityId, workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId,
    status: "active", generate_status: "ready", source_ids: [], course_id: null,
    content_version: 1, path_version: 1, checkpoint_json: {} };
  const spec = { id: id(9), workspace_id: scope.workspaceId, owner_user_id: scope.ownerUserId,
    activity_id: activityId, teaching_unit_id: unitId, document_id: documentId, revision_number: 1,
    block_order: order, source_refs: [], goals_json: [], verification_status: "unchecked", generation_config: {},
    version: 1, created_at: now, updated_at: now };
  boundaries.getRevision.mockResolvedValue({ blocks });
  const sql: FixtureSql = (strings, ...values) => {
    if (!Object.hasOwn(strings, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId }]);
    if (query.includes("FROM opening_workspace_history_revisions") || query.includes("INSERT INTO opening_workspace_history_revisions")) return Promise.resolve([{ revision: 0 }]);
    if (query.includes("SELECT course_id,goal_json,create_intent")) return Promise.resolve([{ course_id: null, goal_json: {}, create_intent: {} }]);
    if (query.includes("FROM opening_help_exposures")) return Promise.resolve([]);
    if (query.includes("FROM opening_teaching_activities")) return Promise.resolve([activity]);
    if (query.includes("FROM opening_teaching_activity_specs")) return Promise.resolve([spec]);
    if (query.includes("FROM opening_teaching_units")) return Promise.resolve([{ current_revision_number: 1 }]);
    if (query.includes("FROM library_revisions")) return Promise.resolve([{ blocks }]);
    if (query.includes("UPDATE opening_teaching_activity_specs")) return Promise.resolve([{ ...spec, revision_number: 2, version: 2, block_order: values[1] }]);
    if (query.includes("UPDATE opening_teaching_units")) return Promise.resolve([]);
    if (query.includes("UPDATE opening_teaching_activities")) return Promise.resolve([{ content_version: 2, path_version: 1, checkpoint_json: values[1] }]);
    throw new Error(`unexpected SQL ${query}`);
  };
  sql.begin = callback => callback(sql as unknown as TransactionSql);
  sql.json = value => value;
  const questionSql = (() => Promise.resolve([{ ...spec, content_version: 1, status: "active",
    activity_source_ids: [], revision_id: id(10), blocks }])) as unknown as TransactionSql;
  return { sql: sql as unknown as Sql, questionSql, order, blocks };
}
async function execute(sql: Sql) {
  return createOpeningTeachingCommandsRepository(sql).executeCommand(scope, activityId, {
    kind: "example", clientKey: "example-help-caller-regression", blockId: exampleId,
    expectedVersion: 1, expectedPathVersion: 1, expectedRevisionNumber: 1,
  });
}
function exposedIds() {
  return boundaries.generate.mock.calls.map(call => call[2].contextAnchor.blockId);
}

// Real contract, question reader, example caller and generator/helper. SQL and
// external persistence/exposure boundaries are fakes: NOT PG transaction acceptance.
describe("example caller help receipts cover actual answerable saved blocks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    boundaries.generate.mockImplementation(async (_tx, _scope, input) => ({ id: input.releaseKey }));
  });

  it.each([
    { role: "prompt", blockType: "question" },
    { role: "prompt", blockType: "prompt" },
    { role: "teach", blockType: "question" },
    { role: "teach", blockType: "prompt" },
    { role: "meta", blockType: "question" },
    { role: "example", blockType: "prompt" },
    { role: "prompt", blockType: "text", savedType: "question" },
    { role: "teach", blockType: "question", content: { markdown: "计算 1/2+1/3" } },
  ] satisfies Case[])("exposes and releases a receipt for reader-admitted %j", async testCase => {
    const f = fixture(testCase);
    expect(teachingBlockRefSchema.parse(f.order[1])).toMatchObject({ role: testCase.role, blockType: testCase.blockType });
    const issued = await readTeachingQuestionForAttempt(f.questionSql, scope, activityId, { blockId: questionId, contentVersion: 1 }, {});
    expect(issued.stem).toBe("计算 1/2+1/3");
    const result = await execute(f.sql);
    expect(result.ok).toBe(true);
    expect(boundaries.update).toHaveBeenCalledOnce();
    const written = boundaries.update.mock.calls[0]![1].blocks;
    expect(written.slice(0, f.blocks.length)).toEqual(f.blocks);
    expect(written.at(-1).content.text).toContain("答案：f'(x)=x + 1");
    expect(exposedIds()).toEqual([written.at(-1).id, questionId]);
    expect(exposedIds()).not.toContain(answerId);
    expect(boundaries.release).toHaveBeenCalledTimes(2);
    for (const call of boundaries.generate.mock.calls) {
      expect(call[2]).toMatchObject({ kind: "solution", level: "revealed", origin: "assistant",
        contextAnchor: { activityId, contentVersion: 2, purpose: "learning_help" } });
      expect(boundaries.release).toHaveBeenCalledWith(f.sql, scope, call[2].releaseKey);
    }
  });

  it.each([
    { role: "answer_key", blockType: "question" },
    { role: "answer_key", blockType: "prompt" },
    { role: "answer_key", blockType: "answer_key" },
    { role: "prompt", blockType: "question", savedType: "answer_key" },
    { role: "prompt", blockType: "prompt", savedType: "solution" },
    { role: "teach", blockType: "text", savedType: "question" },
    { role: "teach", blockType: "question", content: { text: "   " } },
    { role: "teach", blockType: "question", content: { text: "计算 1/2+1/3", interaction: { kind: "invalid" } } },
    { role: "teach", blockType: "question", missingBody: true },
  ] satisfies Case[])("does not treat rejected/answer-key content as an answerable question %j", async testCase => {
    const f = fixture(testCase);
    expect(teachingBlockRefSchema.safeParse(f.order[1]).success).toBe(true);
    await expect(readTeachingQuestionForAttempt(f.questionSql, scope, activityId, { blockId: questionId, contentVersion: 1 }, {})).rejects.toThrow();
    expect((await execute(f.sql)).ok).toBe(true);
    const written = boundaries.update.mock.calls[0]![1].blocks;
    expect(exposedIds()).toEqual([written.at(-1).id]);
    expect(exposedIds()).not.toContain(answerId);
    expect(boundaries.release).toHaveBeenCalledTimes(1);
  });
});
