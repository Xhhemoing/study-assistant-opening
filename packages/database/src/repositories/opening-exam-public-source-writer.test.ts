import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { TransactionSql } from "postgres";
import type { ExamBindInput, ExamPack, KnowledgeSnapshot } from "@aistudy/contracts";
import { ensureExamCourseBinding, type ExamPublicSourceWriter } from "./opening-exam-integration-binding";

const courseId = "00000000-0000-4000-8000-000000000001";
const scope = { workspaceId: "00000000-0000-4000-8000-000000000002", ownerUserId: "00000000-0000-4000-8000-000000000003" };
const now = "2026-10-17T12:00:00.000Z";
const input: ExamBindInput = { clientKey: "bind-source", courseId, expectedPackVersion: "1", milestoneId: null,
  skills: [], materials: [], createKnowledgeNodes: true };
const pack: ExamPack = {
  id: "public-source", version: "1", title: "数学复习", description: "公开概述", limitations: ["复习用途"],
  topics: [{ id: "topic", title: "Topic" }],
  lessons: [{ id: "lesson", topicId: "topic", title: "极限", summary: "先看条件", steps: ["检查定义域"],
    workedExample: "公开例题", pitfalls: ["遗漏条件"] }],
  questions: [{ id: "question", topicId: "topic", skillId: "skill", familyId: "family", lessonId: "lesson", pool: "training",
    difficulty: "foundation", prompt: "SEALED-PROMPT", options: [{ id: "a", label: "SEALED-OPTION" }, { id: "b", label: "Other" }],
    answer: "a", explanation: "SEALED-ANSWER", hint: "SEALED-HINT", estimatedMinutes: 2 }], sourceItems: [], weekPlan: [],
};
function transaction(usage = { bytes: "0", objects: "0" }) {
  const queries: Array<{ query: string; values: unknown[] }> = [];
  let graph: KnowledgeSnapshot | undefined;
  const query = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join("?").replace(/\s+/g, " ").trim();
    // Nested postgres tags compose a fragment instead of executing a query.
    if (text === "g.course_id=?") return { query: text, values };
    queries.push({ query: text, values });
    if (text.startsWith("SELECT c.id FROM courses")) return [{ id: courseId }];
    if (text.startsWith("SELECT id FROM workspaces")) return [{ id: scope.workspaceId }];
    if (text.startsWith("WITH quota_objects AS")) return [usage];
    if (text.startsWith("SELECT owner_user_id")) return [];
    if (text.startsWith("SELECT snapshot FROM opening_course_knowledge")) return graph ? [{ snapshot: graph }] : [];
    if (text.startsWith("SELECT g.course_id,(node->>'id')::uuid AS node_id")) {
      // Materials in this writer fixture are ready; SQL availability and owner
      // authorization have their own repository integration coverage.
      return (graph?.nodes ?? []).filter(node => node.courseId === courseId && node.status === "supported" && node.evidenceChunkIds.length > 0)
        .map(node => ({ course_id: courseId, node_id: node.id }));
    }
    if (text.startsWith("INSERT INTO opening_course_knowledge")) graph = values[4] as KnowledgeSnapshot;
    if (text.startsWith("INSERT INTO")) return [];
    throw new Error(`Unexpected query: ${text}`);
  };
  return { tx: Object.assign(query, { json: (value: unknown) => value }) as unknown as TransactionSql, queries };
}

describe("public source original writer", () => {
  it("awaits the exact UTF-8 original before publishing ready metadata and matches the frozen chunks", async () => {
    const { tx, queries } = transaction();
    const write = vi.fn<ExamPublicSourceWriter>(async source => {
      expect(queries.some(item => item.query.startsWith("INSERT INTO opening_sources"))).toBe(false);
      expect(queries.find(item => item.query.startsWith("SELECT id FROM workspaces")))
        .toMatchObject({ query: expect.stringContaining("FOR NO KEY UPDATE"), values: [scope.workspaceId, scope.ownerUserId] });
      expect(queries.some(item => item.query.startsWith("WITH quota_objects AS"))).toBe(true);
      expect(source).toMatchObject({ version: 0, mime: "text/plain" });
      expect(Buffer.from(source.body).toString("utf8")).not.toContain("SEALED");
    });
    const binding = await ensureExamCourseBinding(tx, scope, pack, input, now, undefined, write);
    expect(write).toHaveBeenCalledTimes(1);
    const original = write.mock.calls[0]![0];
    expect(original.body.byteLength).toBeGreaterThan(Buffer.from(original.body).toString("utf8").length);
    expect(original.sourceId).toBe(binding.packSourceId);
    const metadata = queries.find(item => item.query.startsWith("INSERT INTO opening_sources"))!;
    expect(metadata.values[3]).toBe(original.body.byteLength);
    expect(metadata.values[4]).toBe(createHash("sha256").update(original.body).digest("hex"));
    const chunks = queries.filter(item => item.query.startsWith("INSERT INTO opening_source_chunks")).map(item => item.values[4]);
    expect(chunks.join("\n\n")).toBe(Buffer.from(original.body).toString("utf8"));
  });
  it("does not publish metadata when object storage rejects the original", async () => {
    const { tx, queries } = transaction();
    const write = vi.fn<ExamPublicSourceWriter>().mockRejectedValue(new Error("Object write failed"));
    await expect(ensureExamCourseBinding(tx, scope, pack, input, now, undefined, write)).rejects.toThrow("Object write failed");
    expect(queries.some(item => item.query.startsWith("INSERT INTO"))).toBe(false);
  });
  it("does not rewrite the original when updating an already committed binding", async () => {
    const usage = { bytes: "0", objects: "0" };
    const { tx, queries } = transaction(usage), write = vi.fn<ExamPublicSourceWriter>().mockResolvedValue(undefined);
    const binding = await ensureExamCourseBinding(tx, scope, pack, input, now, undefined, write);
    Object.assign(usage, { bytes: "2147483648", objects: "200" });
    const afterCreate = queries.length;
    expect(await ensureExamCourseBinding(tx, scope, pack, { ...input, clientKey: "update-source" }, now, binding, write)).toEqual(binding);
    expect(write).toHaveBeenCalledTimes(1);
    const updates = queries.slice(afterCreate);
    expect(updates.find(item => item.query.startsWith("SELECT snapshot FROM opening_course_knowledge"))?.values)
      .toEqual([scope.workspaceId, scope.ownerUserId, courseId]);
    expect(updates.find(item => item.query.startsWith("SELECT g.course_id,(node->>'id')::uuid AS node_id"))?.values)
      .toEqual([scope.workspaceId, scope.ownerUserId, { query: "g.course_id=?", values: [courseId] }]);
    expect(updates.some(item => item.query.startsWith("WITH quota_objects AS"))).toBe(false);
    expect(updates.some(item => item.query.startsWith("INSERT INTO"))).toBe(false);
  });
  it("does not rewrite the original or reassign a still-current skill to another supported node", async () => {
    const { tx, queries } = transaction(), write = vi.fn<ExamPublicSourceWriter>().mockResolvedValue(undefined);
    const twoSkills = { ...pack, questions: [...pack.questions, { ...pack.questions[0]!, id: "second-question", skillId: "second-skill" }] };
    const binding = await ensureExamCourseBinding(tx, scope, twoSkills, input, now, undefined, write);
    const afterCreate = queries.length;
    await expect(ensureExamCourseBinding(tx, scope, twoSkills, { ...input, clientKey: "reassign-source",
      skills: [{ skillId: "skill", nodeId: binding.skills[1]!.nodeId }],
    }, now, binding, write)).rejects.toMatchObject({ code: "CONFLICT", message: "原技能仍有效，不能将其历史证据改贴到其他节点" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(queries.slice(afterCreate).some(item => item.query.startsWith("INSERT INTO"))).toBe(false);
  });
  it("admits the exact UTF-8 byte limit and rejects one byte less before storage writes", async () => {
    const reference = vi.fn<ExamPublicSourceWriter>().mockResolvedValue(undefined);
    await ensureExamCourseBinding(transaction().tx, scope, pack, input, now, undefined, reference);
    const bytes = reference.mock.calls[0]![0].body.byteLength;
    const usage = { bytes: "7", objects: "1" };
    const write = vi.fn<ExamPublicSourceWriter>().mockResolvedValue(undefined);
    await ensureExamCourseBinding(transaction(usage).tx, scope, pack, input, now, undefined, write,
      { maxBytes: bytes + 7, maxObjects: 2 });
    expect(write).toHaveBeenCalledTimes(1);
    const rejected = transaction(usage), blockedWrite = vi.fn<ExamPublicSourceWriter>();
    await expect(ensureExamCourseBinding(rejected.tx, scope, pack, input, now, undefined, blockedWrite,
      { maxBytes: bytes + 6, maxObjects: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(blockedWrite).not.toHaveBeenCalled();
    expect(rejected.queries.some(item => item.query.startsWith("INSERT INTO"))).toBe(false);
  });
  it("rejects a full object allowance before storage or source metadata writes", async () => {
    const { tx, queries } = transaction({ bytes: "1", objects: "2" });
    const write = vi.fn<ExamPublicSourceWriter>();
    await expect(ensureExamCourseBinding(tx, scope, pack, input, now, undefined, write,
      { maxBytes: 1_000_000, maxObjects: 2 })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(write).not.toHaveBeenCalled();
    expect(queries.some(item => item.query.startsWith("INSERT INTO"))).toBe(false);
  });
});
