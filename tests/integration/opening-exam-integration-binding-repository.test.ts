import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamBindInput, ExamCourseBinding, ExamPack, KnowledgeSnapshot, Scope } from "@aistudy/contracts";
import { createOpeningAdaptivePrefsRepository, createOpeningKnowledgeRepository } from "@aistudy/database";
import { ensureExamCourseBinding } from "../../packages/database/src/repositories/opening-exam-integration-binding";
import { lockWorkspaceLearningHistory } from "../../packages/database/src/repositories/opening-learning-facts";
import { readOpeningSourceContent } from "../../packages/database/src/repositories/opening-source-content";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const now = "2026-10-17T12:00:00.000Z";
const pack: ExamPack = {
  id: "binding-fixture", version: "1", title: "Math review", description: "Public overview",
  topics: [{ id: "limits", title: "Limits" }],
  lessons: ["first", "second"].map(id => ({ id, topicId: "limits", title: `Lesson ${id}`, summary: "Public summary",
    steps: ["Identify the condition"], workedExample: "Public worked example", pitfalls: ["Check the domain"] })),
  questions: ["first", "second", "second"].map((skillId, index) => ({
    id: `question-${index}`, topicId: "limits", skillId, familyId: `family-${index}`, lessonId: skillId,
    pool: index === 2 ? "mock-a" : "training", difficulty: "foundation",
    prompt: `PRIVATE-PROMPT-${index}`, options: [{ id: "a", label: `PRIVATE-OPTION-${index}` }, { id: "b", label: "Another" }],
    answer: "a", explanation: `PRIVATE-ANSWER-${index}`, hint: `PRIVATE-HINT-${index}`, estimatedMinutes: 2,
  })),
  sourceItems: [{ id: "worksheet-1", topicId: "limits", label: "Exercise 1", sourceTitle: "Worksheet.pdf", sourcePage: 1,
    kind: "exercise", suggestedDay: 1, skills: ["first"] }],
  weekPlan: [], limitations: ["Practice only"],
};
let f: OpeningFixture;
let courseId: string;
beforeAll(async () => { f = await createOpeningFixture(); });
beforeEach(async () => { courseId = await seedCourse(); });
afterAll(async () => {
  if (!f) return;
  await f.sql`DELETE FROM opening_source_versions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.close();
});

async function seedCourse(scope = f.scope) {
  const id = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${id},${scope.workspaceId},'Binding course',${id})`;
  return id;
}

function input(overrides: Partial<ExamBindInput> = {}): ExamBindInput {
  return { clientKey: randomUUID(), courseId, milestoneId: null, expectedPackVersion: pack.version,
    createKnowledgeNodes: true, skills: [], materials: [], ...overrides };
}

function bind(value = input(), existing?: ExamCourseBinding, scope: Scope = f.scope) {
  return f.sql.begin(async tx => {
    await lockWorkspaceLearningHistory(tx, scope);
    await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
    await tx`SELECT id FROM courses WHERE id=${value.courseId} AND workspace_id=${scope.workspaceId} FOR UPDATE`;
    return ensureExamCourseBinding(tx, scope, pack, value, now, existing);
  });
}

async function source(scope = f.scope) {
  const id = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${scope.workspaceId},'Worksheet.pdf','application/pdf',12,${"a".repeat(64)},1,'uploaded','ready')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${id},1,${scope.workspaceId},12,${"a".repeat(64)},'available')`;
  await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${id},1,1,'Learner material body')`;
  return { sourceTitle: "Worksheet.pdf", sourceId: id, sourceVersion: 1 };
}

function snapshot(): KnowledgeSnapshot {
  const chapter = randomUUID(), first = randomUUID(), second = randomUUID();
  return { courseId, version: 0, nodes: [
    { id: chapter, courseId, label: "Unrelated chapter", kind: "chapter", evidenceChunkIds: [], status: "suggested" },
    { id: first, courseId, label: "Lesson first", kind: "concept", evidenceChunkIds: [], status: "suggested" },
    { id: second, courseId, label: "Lesson second", kind: "concept", evidenceChunkIds: [], status: "needs_check" },
  ], edges: [{ from: chapter, to: first, kind: "contains", evidenceChunkIds: [], status: "suggested" }] };
}

describe("exam course binding integration", () => {
  it("preserves existing graph content, honors explicit nodes and creates readable public lessons without question data", async () => {
    const repository = createOpeningKnowledgeRepository(f.sql), graph = snapshot();
    const previousSource = await source();
    await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
      VALUES(${f.scope.workspaceId},${courseId},'source',${previousSource.sourceId},'core','private')`;
    const [previousChunk] = await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${previousSource.sourceId}`;
    graph.nodes[1]!.evidenceChunkIds = [String(previousChunk!.id)];
    graph.nodes[1]!.status = "supported";
    await repository.replace(f.scope, courseId, { expectedVersion: 0, snapshot: graph, sourceVersions: { [previousSource.sourceId]: 1 } });
    const binding = await bind(input({ skills: [{ skillId: "first", nodeId: graph.nodes[1]!.id }] }));
    const saved = await repository.get(f.scope, courseId);
    expect(saved?.version).toBe(2);
    expect(saved?.snapshot.nodes.slice(0, 3)).toEqual(graph.nodes);
    expect(saved?.snapshot.edges).toEqual(graph.edges);
    expect(saved?.snapshot.nodes).toHaveLength(4);
    expect(binding.skills).toHaveLength(2);
    expect(binding.skills[0]?.nodeId).toBe(graph.nodes[1]!.id);
    // An identical label is not an identity: the unmapped skill receives a new node.
    expect(binding.skills[1]?.nodeId).not.toBe(graph.nodes[2]!.id);
    expect(new Set(binding.skills.map(skill => skill.requirementKey)).size).toBe(2);
    expect(saved?.sourceVersions).toEqual({ [previousSource.sourceId]: 1, [binding.packSourceId]: 0 });
    const chunks = await f.sql`SELECT text FROM opening_source_chunks WHERE source_id=${binding.packSourceId} ORDER BY page`;
    expect(chunks).toHaveLength(3);
    expect(JSON.stringify(chunks)).not.toContain("PRIVATE-");
    expect(JSON.stringify(chunks)).toContain("Public worked example");
    const content = await readOpeningSourceContent(f.sql, f.scope, binding.packSourceId, { version: 0 });
    expect(content.text).toContain("Public overview");
    expect(content.pages).toEqual([1, 2, 3]);
    const metadata = await f.sql`SELECT s.mime,s.upload_state,s.parse_state,v.availability,m.course_id
      FROM opening_sources s JOIN opening_source_versions v ON v.source_id=s.id AND v.version=s.version
      JOIN course_asset_memberships m ON m.asset_id=s.id AND m.asset_type='source' WHERE s.id=${binding.packSourceId}`;
    expect(metadata[0]).toMatchObject({ mime: "text/plain", upload_state: "uploaded", parse_state: "ready", availability: "available", course_id: courseId });
  });

  it("updates materials and an existing milestone without duplicating graph nodes, lessons or altering goals", async () => {
    const existing = await bind();
    const milestoneId = randomUUID(), prefs = createOpeningAdaptivePrefsRepository(f.sql);
    await prefs.patch(f.scope, { courseGoal: { courseId, expectedRevision: 0, goal: { targetDate: "2026-11-01", weeklyMinutes: 200,
      milestones: [{ id: milestoneId, title: "Exam review", successCriteria: "Explain methods", targetDate: null, evidenceRefs: [] }] } } });
    const beforePrefs = await prefs.get(f.scope), material = await source();
    const beforeGraph = await createOpeningKnowledgeRepository(f.sql).get(f.scope, courseId);
    const updated = await bind(input({ milestoneId, materials: [material] }), existing);
    expect(updated).toEqual({ ...existing, milestoneId, materials: [material] });
    expect(await prefs.get(f.scope)).toEqual(beforePrefs);
    expect(await createOpeningKnowledgeRepository(f.sql).get(f.scope, courseId)).toEqual(beforeGraph);
    const cleared = await bind(input({ createKnowledgeNodes: false }), updated);
    expect(cleared).toEqual({ ...existing, materials: [], milestoneId: null });
    const memberships = await f.sql`SELECT asset_id FROM course_asset_memberships WHERE course_id=${courseId} ORDER BY asset_id`;
    expect(memberships.map(row => row.asset_id).sort()).toEqual([material.sourceId, existing.packSourceId].sort());
    await expect(bind(input({ courseId: await seedCourse() }), existing)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(bind(input({ skills: [{ skillId: "first", nodeId: randomUUID() }] }), existing)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(bind(input({ milestoneId: randomUUID() }), existing)).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("validates owned ready version-pinned materials and rolls back all changes for excluded or unreadable sources", async () => {
    const local = await source(), foreign = await source(f.otherScope);
    const invalid = [foreign, { ...local, sourceVersion: 0 }, { ...local, sourceVersion: 2 }];
    for (const material of invalid) await expect(bind(input({ materials: [material] }))).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${local.sourceId})`;
    await expect(bind(input({ materials: [local] }))).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`DELETE FROM opening_privacy_exclusions WHERE workspace_id=${f.scope.workspaceId} AND source_id=${local.sourceId}`;
    await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${local.sourceId}`;
    await expect(bind(input({ materials: [local] }))).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_source_versions SET availability='available' WHERE source_id=${local.sourceId}`;
    await f.sql`UPDATE opening_source_chunks SET text='  ' WHERE source_id=${local.sourceId}`;
    await expect(bind(input({ materials: [local] }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await createOpeningKnowledgeRepository(f.sql).get(f.scope, courseId)).toBeNull();
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("rejects forged ownership, foreign or archived courses and invalid mapping intents before publishing resources", async () => {
    await expect(bind(input(), undefined, { ...f.scope, ownerUserId: f.otherScope.ownerUserId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(bind(input({ courseId: await seedCourse(f.otherScope) }))).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(bind(input({ expectedPackVersion: "2" }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(bind(input({ createKnowledgeNodes: false }))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(bind(input({ milestoneId: randomUUID() }))).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    await expect(bind()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("supports fully explicit mappings without rewriting the graph and rejects duplicate, chapter or foreign node mappings", async () => {
    const repository = createOpeningKnowledgeRepository(f.sql), graph = snapshot();
    await repository.replace(f.scope, courseId, { expectedVersion: 0, snapshot: graph, sourceVersions: {} });
    const skills = [{ skillId: "first", nodeId: graph.nodes[1]!.id }, { skillId: "second", nodeId: graph.nodes[2]!.id }];
    const binding = await bind(input({ createKnowledgeNodes: false, skills }));
    expect(binding.skills.map(({ skillId, nodeId }) => ({ skillId, nodeId }))).toEqual(skills);
    expect((await repository.get(f.scope, courseId))?.version).toBe(1);
    for (const invalid of [
      [skills[0]!, skills[0]!], [{ skillId: "first", nodeId: graph.nodes[0]!.id }],
      [{ skillId: "first", nodeId: randomUUID() }], [{ skillId: "unknown", nodeId: graph.nodes[1]!.id }],
    ]) await expect(bind(input({ skills: invalid }))).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.get(f.scope, courseId))?.snapshot.nodes).toEqual(graph.nodes);
  });
});
