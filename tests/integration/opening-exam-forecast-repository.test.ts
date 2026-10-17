import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamCourseBinding, ExamPack, ExamPaperInput, Scope } from "@aistudy/contracts";
import { createExamSprintState } from "@aistudy/domain";
import { createOpeningExamForecastRepository } from "../../packages/database/src/repositories/opening-exam-forecast";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

const pack: ExamPack = {
  id: "forecast-fixture", version: "1", title: "Forecast", description: "Source annotations",
  topics: [{ id: "topic", title: "Topic" }],
  lessons: [{ id: "lesson", topicId: "topic", title: "Lesson", summary: "Summary", steps: [], workedExample: "Example", pitfalls: [] }],
  questions: ["first", "second"].map(skillId => ({ id: skillId, topicId: "topic", skillId, familyId: skillId, lessonId: "lesson",
    pool: "training", difficulty: "foundation", prompt: "Question", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    answer: "a", explanation: "Explanation", hint: "Hint", estimatedMinutes: 2 })),
  sourceItems: [], weekPlan: [], limitations: [],
};
let f: OpeningFixture, sprintId: string, courseId: string;
let repository: ReturnType<typeof createOpeningExamForecastRepository>;
beforeAll(async () => { f = await createOpeningFixture(); repository = createOpeningExamForecastRepository(f.sql, pack); });
beforeEach(async () => {
  await f.sql`DELETE FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`;
  sprintId = randomUUID(); courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Exam course',${courseId})`;
  await f.sql`INSERT INTO opening_exam_sprints(id,workspace_id,owner_user_id,pack_snapshot,state)
    VALUES(${sprintId},${f.scope.workspaceId},${f.scope.ownerUserId},${f.sql.json(pack as never)},
      ${f.sql.json(createExamSprintState(new Date().toISOString()) as never)})`;
  const binding: ExamCourseBinding = { courseId, milestoneId: null, packSourceId: randomUUID(), boundAt: new Date().toISOString(),
    skills: ["first", "second"].map(skillId => ({ skillId, nodeId: randomUUID(), requirementKey: `exam:${skillId}` })), materials: [] };
  await f.sql`INSERT INTO opening_exam_bindings(sprint_id,course_id,binding) VALUES(${sprintId},${courseId},${f.sql.json(binding as never)})`;
});
afterAll(async () => {
  if (!f) return;
  await f.sql`DELETE FROM opening_exam_sprints WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`DELETE FROM opening_source_versions WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.close();
});

async function source(scope: Scope = f.scope) {
  const sourceId = randomUUID(), digest = sourceId.replaceAll("-", "").repeat(2);
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${scope.workspaceId},'Past exam.pdf','application/pdf',12,${digest},1,'uploaded','ready')`;
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${sourceId},1,${scope.workspaceId},12,${digest},'available')`;
  await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text) VALUES(${sourceId},1,1,'Exam questions')`;
  return { sourceId, sourceVersion: 1 };
}
async function input(overrides: Partial<ExamPaperInput> = {}): Promise<ExamPaperInput> {
  return { clientKey: randomUUID(), ...await source(), teacher: "Teacher A", year: 2025, label: `Final exam ${randomUUID()}`, kind: "past_exam",
    skills: [{ skillId: "first", points: 12 }, { skillId: "second", points: 0 }], ...overrides };
}

describe("exam paper forecast repository", () => {
  it("registers owned current sources under the bound course and keeps teachers and sample kinds separate", async () => {
    const first = await input();
    const registered = await repository.record(f.scope, first);
    expect(registered.papers).toHaveLength(1);
    expect(registered.papers[0]).toMatchObject({ courseId, sourceId: first.sourceId, sourceVersion: 1, teacher: "Teacher A" });
    expect(registered.topics[0]).toMatchObject({ skillId: "first", examinedPapers: 1, totalPapers: 1, probability: 2 / 3, meanPoints: 12 });
    expect(registered.topics[1]).toMatchObject({ skillId: "second", examinedPapers: 0, totalPapers: 1, meanPoints: 0 });
    const membership = await f.sql`SELECT role,visibility FROM course_asset_memberships WHERE course_id=${courseId} AND asset_id=${first.sourceId}`;
    expect(membership[0]).toMatchObject({ role: "reference", visibility: "private" });
    await repository.record(f.scope, await input({ kind: "sample" }));
    await repository.record(f.scope, await input({ kind: "exercise" }));
    await repository.record(f.scope, await input({ teacher: "Teacher B" }));
    const result = await repository.read(f.scope, "Teacher A");
    expect(result.papers).toHaveLength(3);
    expect(result.topics[0]?.totalPapers).toBe(1);
    expect((await repository.read(f.scope)).status).toBe("no_history");
    expect((await repository.read(f.otherScope, "Teacher A")).papers).toEqual([]);
  });

  it("replays the same command but rejects changed payloads and repeated source versions, including concurrent registrations", async () => {
    const value = await input();
    const first = await repository.record(f.scope, value);
    expect(await repository.record(f.scope, value)).toEqual(first);
    await expect(repository.record(f.scope, { ...value, label: "Changed" })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.record(f.scope, { ...value, clientKey: randomUUID(), teacher: "Teacher B" })).rejects.toMatchObject({ code: "CONFLICT" });
    const concurrent = await input();
    const results = await Promise.allSettled([repository.record(f.scope, concurrent),
      repository.record(f.scope, { ...concurrent, clientKey: randomUUID() })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { code: "CONFLICT" } });
    expect((await repository.read(f.scope, "Teacher A")).papers).toHaveLength(2);
  });

  it("rejects foreign ownership, foreign sources, unknown skills, archived courses and missing bindings", async () => {
    const value = await input(), forged = { ...f.scope, ownerUserId: f.otherScope.ownerUserId };
    await expect(repository.read(forged)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.record(forged, value)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repository.record(f.scope, { ...value, ...await source(f.otherScope) })).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repository.record(f.scope, { ...value, skills: [{ skillId: "unknown", points: 5 }] })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(repository.record(f.scope, { ...value, year: new Date().getUTCFullYear() + 1 })).rejects.toMatchObject({ code: "VALIDATION" });
    await f.sql`UPDATE courses SET archived_at=now() WHERE id=${courseId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await f.sql`UPDATE courses SET archived_at=NULL WHERE id=${courseId}`;
    await f.sql`DELETE FROM opening_exam_bindings WHERE sprint_id=${sprintId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM opening_exam_papers WHERE sprint_id=${sprintId}`).toHaveLength(0);
  });

  it("rejects duplicate uploads and different scans of the same named exam without increasing sample size", async () => {
    const original = await input();
    await repository.record(f.scope, original);
    const upload = await input({ teacher: "Different label", label: "Renamed upload" });
    await f.sql`UPDATE opening_source_versions SET sha256=(SELECT sha256 FROM opening_source_versions
      WHERE source_id=${original.sourceId} AND version=1) WHERE source_id=${upload.sourceId}`;
    await expect(repository.record(f.scope, upload)).rejects.toMatchObject({ code: "CONFLICT" });
    const scan = await input({ teacher: original.teacher, year: original.year, label: original.label });
    await expect(repository.record(f.scope, scan)).rejects.toMatchObject({ code: "CONFLICT" });
    expect((await repository.read(f.scope, original.teacher)).topics[0]?.totalPapers).toBe(1);
    expect(await f.sql`SELECT id FROM opening_exam_papers WHERE sprint_id=${sprintId}`).toHaveLength(1);
  });

  it("rejects unavailable, excluded, unparsed or empty sources and never enrolls them in a course", async () => {
    const value = await input();
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${value.sourceId})`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`DELETE FROM opening_privacy_exclusions WHERE source_id=${value.sourceId}`;
    await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${value.sourceId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_source_versions SET availability='available' WHERE source_id=${value.sourceId}`;
    await f.sql`UPDATE opening_sources SET parse_state='queued' WHERE id=${value.sourceId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`UPDATE opening_sources SET parse_state='ready' WHERE id=${value.sourceId}`;
    await f.sql`UPDATE opening_source_chunks SET text='  ' WHERE source_id=${value.sourceId}`;
    await expect(repository.record(f.scope, value)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE course_id=${courseId}`).toHaveLength(0);
  });

  it("removes stale, excluded, unavailable or unlinked registered sources from all reads", async () => {
    const values = await Promise.all([input(), input(), input(), input()]);
    for (const value of values) await repository.record(f.scope, value);
    const [stale, excluded, unavailable, unlinked] = values as [ExamPaperInput, ExamPaperInput, ExamPaperInput, ExamPaperInput];
    await f.sql`UPDATE opening_sources SET version=2 WHERE id=${stale.sourceId}`;
    await expect(repository.record(f.scope, { ...stale, clientKey: randomUUID() })).rejects.toMatchObject({ code: "CONFLICT" });
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id) VALUES(${f.scope.workspaceId},${excluded.sourceId})`;
    await f.sql`UPDATE opening_source_versions SET availability='unavailable' WHERE source_id=${unavailable.sourceId}`;
    await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${courseId} AND asset_id=${unlinked.sourceId}`;
    expect((await repository.read(f.scope, "Teacher A")).papers).toEqual([]);
    expect((await repository.record(f.scope, excluded)).papers).toEqual([]);
  });

  it("fails closed on corrupt persisted annotations instead of manufacturing a forecast", async () => {
    const value = await input();
    await repository.record(f.scope, value);
    await f.sql`UPDATE opening_exam_papers SET skills='[{"skillId":"first","points":-1}]'::jsonb WHERE sprint_id=${sprintId}`;
    await expect(repository.read(f.scope, "Teacher A")).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
