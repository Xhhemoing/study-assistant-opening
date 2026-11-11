import { isDeepStrictEqual } from "node:util";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { projectMaterialFeedback, type MaterialFeedbackSnapshot } from "../../../domain/src/opening/material-attempt-presentation";
import type { Sql } from "postgres";
import { describe, expect, it, vi } from "vitest";
import { getTableColumns } from "drizzle-orm";
import { openingLearningAttempts, openingLearningItemVersions } from "../schema/opening-learning-attempts";
import { openingLearningSessions } from "../schema/opening-learning";
import { openingTeachingActivities } from "../schema/opening-teaching-activities";
import { openingTeachingActivitySpecs, openingTeachingUnits } from "../schema/opening-teaching-content";
import { libraryDocuments, libraryRevisions } from "../schema/library";
import { courses, courseAssetMemberships } from "../schema/courses";
import { openingSources } from "../schema/opening-sources";
import { openingSourceChunks } from "../schema/opening-source-chunks";
import { createOpeningMaterialFeedbackSnapshotRepository, type OpeningMaterialFeedbackBinding } from "./opening-material-feedback-snapshot";
import type { MaterialFeedbackAccessRequest } from "../../../domain/src/opening/material-attempt-presentation";

function project(snapshot: MaterialFeedbackSnapshot | null, b = binding(), input: object = {}) {
  return projectMaterialFeedback({ id: b.blockId, sourceFile: b.sourceFile, physicalPage: b.physicalPage,
    postAttemptNotes: "CLIENT PRIVATE NOTES", answer: { role: "answer_key", text: "CLIENT PRIVATE KEY" }, ...input },
  request(b), { resolveFeedback: () => snapshot });
}
const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function binding(): OpeningMaterialFeedbackBinding {
  return {
    workspaceId: id(1), ownerUserId: id(2), courseId: id(3), attemptId: id(4), itemVersionId: id(5), problemId: id(6),
    activityId: id(7), teachingUnitId: id(8), documentId: id(9), revisionId: id(10), revisionNumber: 1,
    contentVersion: 1, blockId: id(11), answerBlockId: id(12), sourceId: id(13), sourceVersion: 2,
    sourceSha256: "a".repeat(64), sourceFile: "fixture.pdf", physicalPage: 3,
    revisionBlocks: [
      { id: id(11), type: "prompt", position: 0, content: { text: "Saved question" } },
      { id: id(12), type: "answer_key", position: 1, content: { text: "Saved answer", rubric: "PRIVATE RUBRIC" } },
    ],
    blockOrder: [{ blockId: id(11), position: 0, blockType: "prompt", role: "prompt" },
      { blockId: id(12), position: 1, blockType: "answer_key", role: "answer_key" }],
    sourceRefs: [{ sourceId: id(13), version: 2, page: 3 }],
  };
}
function request(b = binding()): MaterialFeedbackAccessRequest {
  return { questionId: b.blockId, attemptId: b.attemptId, mode: "post_attempt", source: { file: b.sourceFile, page: b.physicalPage } };
}

type Cell = string | number | null | boolean | object;
type FakeFeedbackRow = { answer: unknown; extra?: unknown };
type FakeState = {
  attempt: Pick<typeof openingLearningAttempts.$inferSelect, "submittedAt" | "workspaceId" | "ownerUserId" | "courseId" | "itemVersionId" | "problemId">;
  current: OpeningMaterialFeedbackBinding;
  withdrawn: boolean; excluded: boolean; membership: boolean; duplicate: boolean;
};
function state(b = binding()): FakeState {
  return { attempt: { submittedAt: new Date("2026-01-01T00:00:00Z"), workspaceId: b.workspaceId, ownerUserId: b.ownerUserId,
    courseId: b.courseId, itemVersionId: b.itemVersionId, problemId: b.problemId }, current: structuredClone(b),
    withdrawn: false, excluded: false, membership: true, duplicate: false };
}

/** Narrow relational SQL fake, not a PostgreSQL parser/executor. It inspects the
 * actual tagged template and evaluates its bound identity/payload predicates
 * against typed stored state; it never grants access from a boolean host flag.
 * PostgreSQL execution/SQL semantics still require separate integration review.
 */
function fakeSql(stored = state()) {
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: Cell[]): Promise<FakeFeedbackRow[]> => {
    const sql = parts.reduce((out, part, index) => out + (index ? `$${index}` : "") + part, "");
    expect(sql.trimStart().startsWith("SELECT ")).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE)\b/);
    const tables = { attempt: openingLearningAttempts, session: openingLearningSessions, item: openingLearningItemVersions,
      spec: openingTeachingActivitySpecs, activity: openingTeachingActivities, unit: openingTeachingUnits,
      document: libraryDocuments, revision: libraryRevisions, course: courses, source: openingSources,
      membership: courseAssetMemberships, chunk: openingSourceChunks };
    // Check every referenced ordinary SQL column against real Drizzle metadata.
    for (const [alias, table] of Object.entries(tables)) {
      const columns = new Set(Object.values(getTableColumns(table)).map(column => column.name));
      for (const match of sql.matchAll(new RegExp(`\\b${alias}\\.([a-z_][a-z_0-9]*)`, "g"))) expect(columns.has(match[1]!), `${alias}.${match[1]}`).toBe(true);
    }
    const equal = (expression: string, actual: Cell) => {
      const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const matches = [...sql.matchAll(new RegExp(`${escaped}=\\$(\\d+)(?!\\d)`, "g"))];
      expect(matches.length, `missing parameter predicate: ${expression}`).toBeGreaterThan(0);
      return matches.every(match => isDeepStrictEqual(actual, values[Number(match[1]) - 1]));
    };
    const c = stored.current;
    const checks = [
      equal("attempt.workspace_id", stored.attempt.workspaceId), equal("attempt.owner_user_id", stored.attempt.ownerUserId),
      equal("attempt.course_id", stored.attempt.courseId), equal("attempt.id", c.attemptId),
      equal("attempt.item_version_id", stored.attempt.itemVersionId), equal("attempt.problem_id", stored.attempt.problemId),
      equal("attempt.activity_id", c.activityId), equal("spec.teaching_unit_id", c.teachingUnitId), equal("spec.document_id", c.documentId),
      equal("revision.id", c.revisionId), equal("revision.revision_number", c.revisionNumber), equal("spec.version", c.contentVersion),
      equal("item.teaching_block_id", c.blockId), equal("item.evaluation_spec->>'answerBlockId'", c.answerBlockId),
      equal("revision.blocks", c.revisionBlocks), equal("spec.block_order", c.blockOrder), equal("spec.source_refs", c.sourceRefs),
      equal("source.id", c.sourceId), equal("source.name", c.sourceFile), equal("source.version", c.sourceVersion), equal("source.sha256", c.sourceSha256),
      equal("chunk.page", c.physicalPage),
    ];
    expect(sql).toContain("attempt.submitted_at IS NOT NULL");
    expect(sql).toContain("document.deleted_at IS NULL");
    expect(sql).toContain("document.current_revision_number=spec.revision_number");
    expect(sql).toContain("activity.content_version=spec.version");
    expect(sql).toContain("exclusion.source_id=source.id");
    expect(sql).toContain("membership.asset_id=source.id");
    expect(sql).toContain("item.problem_id=attempt.problem_id");
    expect(sql).toContain("item.evaluation_spec->'sourceRefs'=spec.source_refs");
    expect(sql).toContain("item.stem_snapshot=prompt.block->'content'->>'text'");
    expect(sql).toContain("k->>'role'='answer_key'");
    expect(sql).toContain("k->>'position')::int=(p->>'position')::int+1");
    expect(sql).toContain("attempt.source_versions->>source.id::text=source.version::text");
    if (!checks.every(Boolean) || !stored.attempt.submittedAt || stored.withdrawn || stored.excluded || !stored.membership) return [];
    return Array.from({ length: stored.duplicate ? 2 : 1 }, () => ({ answer: "Saved answer", extra: "PRIVATE EXTRA" }));
  });
  return { sql: Object.assign(query, { json: (value: object) => value }) as unknown as Sql, query, stored };
}
function harness(b = binding(), stored = state(b)) {
  const fake = fakeSql(stored);
  const resolvePostAttemptBinding = vi.fn(async (_request: MaterialFeedbackAccessRequest) => b as OpeningMaterialFeedbackBinding | null);
  const repo = createOpeningMaterialFeedbackSnapshotRepository(fake.sql, { resolvePostAttemptBinding });
  return { ...fake, repo, resolvePostAttemptBinding, b };
}

describe("current material feedback snapshot repository — real schema subset", () => {
  it("reads the exact submitted teaching pair and returns only the detached answer whitelist", async () => {
    const h = harness();
    expect(await h.repo.resolveFeedback(request())).toEqual({ answer: "Saved answer", postAttemptNotes: null });
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it.each(["sourceVersion", "contentVersion", "revisionNumber"] as const)("denies a changed current %s", async key => {
    const h = harness(); h.stored.current[key]++;
    const snapshot = await h.repo.resolveFeedback(request());
    expect(snapshot).toBeNull();
    expect(project(snapshot).status).toBe("unavailable");
  });
  it("denies same-ID content replacement even when version numbers stay unchanged", async () => {
    const h = harness();
    h.stored.current.revisionBlocks = [{ id: h.b.blockId, type: "prompt", content: { text: "Foreign question" } }];
    const snapshot = await h.repo.resolveFeedback(request());
    expect(snapshot).toBeNull();
    expect(project(snapshot).status).toBe("unavailable");
  });
  it.each(["sourceSha256", "sourceId", "answerBlockId", "revisionId"] as const)("denies substituted %s", async key => {
    const h = harness(); h.stored.current[key] = key === "sourceSha256" ? "b".repeat(64) : id(99);
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it.each(["workspaceId", "ownerUserId", "courseId", "itemVersionId", "problemId"] as const)("denies stored attempt with wrong %s", async key => {
    const h = harness(); h.stored.attempt[key] = id(99);
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it("requires actual submission, not caller permission flags", async () => {
    const h = harness(); h.stored.attempt.submittedAt = null;
    const input = { ...request(), submitted: true, feedbackAllowed: true };
    expect(await h.repo.resolveFeedback(input)).toBeNull();
  });
  it.each(["withdrawn", "excluded"] as const)("denies current %s content", async key => {
    const h = harness(); h.stored[key] = true;
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it("requires current course source membership", async () => {
    const h = harness(); h.stored.membership = false;
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
  it("never turns an early-help read into a durable exposure claim", async () => {
    const h = harness();
    expect(await h.repo.resolveFeedback({ ...request(), mode: "explicit_help" })).toBeNull();
    expect(h.resolvePostAttemptBinding).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });
  it("denies when external trusted host cannot authenticate/authorize/bind the request", async () => {
    const h = harness(); h.resolvePostAttemptBinding.mockResolvedValue(null);
    expect(await h.repo.resolveFeedback(request())).toBeNull();
    expect(h.query).not.toHaveBeenCalled();
  });
  it.each(["question", "attempt", "file", "page"])("rejects a public %s mismatch before SQL", async key => {
    const h = harness(), input = request();
    if (key === "question") input.questionId = id(90);
    if (key === "attempt") input.attemptId = id(90);
    if (key === "file") input.source.file = "other.pdf";
    if (key === "page") input.source.page++;
    expect(await h.repo.resolveFeedback(input)).toBeNull();
    expect(h.query).not.toHaveBeenCalled();
  });
  it("propagates storage failures instead of inventing successful feedback", async () => {
    const h = harness(); h.query.mockRejectedValue(new Error("storage offline"));
    await expect(h.repo.resolveFeedback(request())).rejects.toThrow("storage offline");
  });
  it.each(["not_submitted", "wrong_scope", "withdrawn", "excluded", "membership_removed", "old_version", "changed_payload"])(
    "projector stays unavailable for %s even with client feedback and claimed permission", async cause => {
      const h = harness();
      if (cause === "not_submitted") h.stored.attempt.submittedAt = null;
      if (cause === "wrong_scope") h.stored.attempt.ownerUserId = id(99);
      if (cause === "withdrawn") h.stored.withdrawn = true;
      if (cause === "excluded") h.stored.excluded = true;
      if (cause === "membership_removed") h.stored.membership = false;
      if (cause === "old_version") h.stored.current.contentVersion++;
      if (cause === "changed_payload") h.stored.current.revisionBlocks = [];
      const snapshot = await h.repo.resolveFeedback(request());
      expect(project(snapshot, h.b, { authorized: true, submitted: true })).toEqual({
        kind: "material_feedback", status: "unavailable", reason: "feedback_not_authorized" });
    });
  it("projects only the host/database snapshot even with same-ID poisoned private client data", async () => {
    const h = harness();
    const dto = project(await h.repo.resolveFeedback(request()));
    expect(dto).toMatchObject({ status: "available", feedback: { answer: "Saved answer", postAttemptNotes: null },
      exposure: "post_attempt", independentEligibility: "unknown" });
    expect(JSON.stringify(dto)).not.toMatch(/PRIVATE|rubric|extra|CLIENT/);
  });
  it("does not evaluate client private accessors after a successful read", async () => {
    const h = harness(), input = { id: h.b.blockId, sourceFile: h.b.sourceFile, physicalPage: h.b.physicalPage };
    const poison = vi.fn(() => { throw new Error("private accessor executed"); });
    Object.defineProperties(input, { postAttemptNotes: { get: poison }, answer: { get: poison } });
    const snapshot = await h.repo.resolveFeedback(request());
    const dto = projectMaterialFeedback(input, request(), { resolveFeedback: () => snapshot });
    expect(dto.status).toBe("available"); expect(poison).not.toHaveBeenCalled();
  });
  it("host callback mutation cannot retarget the captured request", async () => {
    const h = harness(), original = request();
    h.resolvePostAttemptBinding.mockImplementation(async received => {
      received.questionId = id(99); received.source.file = "foreign.pdf";
      original.questionId = id(98); original.source.page = 900;
      return h.b;
    });
    const snapshot = await h.repo.resolveFeedback(original);
    expect(snapshot).toEqual({ answer: "Saved answer", postAttemptNotes: null });
    expect(h.query).toHaveBeenCalledTimes(1);
  });
  it("copies host JSON before awaiting SQL and detaches row feedback before returning", async () => {
    const h = harness();
    const row = { answer: "Saved answer", extra: { private: "PRIVATE" } };
    h.query.mockImplementationOnce(async (_parts, ...values) => {
      h.b.revisionBlocks = [];
      expect(values).toContainEqual(binding().revisionBlocks);
      expect(values).not.toContainEqual([]);
      return [row];
    });
    const snapshot = await h.repo.resolveFeedback(request());
    row.answer = "CHANGED AFTER QUERY";
    h.b.revisionBlocks = [{ answer: "CHANGED HOST SNAPSHOT" }];
    expect(project(snapshot)).toMatchObject({ status: "available", feedback: { answer: "Saved answer", postAttemptNotes: null } });
  });
  it("projector callback mutation of the raw input cannot replace the stored feedback", async () => {
    const h = harness(), snapshot = await h.repo.resolveFeedback(request());
    const raw = { id: h.b.blockId, sourceFile: h.b.sourceFile, physicalPage: h.b.physicalPage,
      postAttemptNotes: "old client note", answer: { role: "answer_key", text: "old client key" } };
    const dto = projectMaterialFeedback(raw, request(), { resolveFeedback: access => {
      raw.postAttemptNotes = "MUTATED PRIVATE NOTE"; raw.answer.text = "MUTATED PRIVATE KEY";
      access.source.file = "mutated.pdf";
      return snapshot;
    } });
    expect(dto).toMatchObject({ status: "available", source: { file: "fixture.pdf", page: 3 },
      feedback: { answer: "Saved answer", postAttemptNotes: null } });
    expect(JSON.stringify(dto)).not.toContain("MUTATED");
  });
  it.each([null, "", " ", 42, { text: "private" }, "x".repeat(20001)])("denies missing/invalid stored answer %#", async answer => {
    const h = harness(); h.query.mockResolvedValueOnce([{ answer }]);
    expect(project(await h.repo.resolveFeedback(request())).status).toBe("unavailable");
  });
  it("does not execute feedback row accessors", async () => {
    const h = harness(), row: FakeFeedbackRow = { answer: undefined };
    const getter = vi.fn(() => "PRIVATE ACCESSOR"); Object.defineProperty(row, "answer", { get: getter });
    h.query.mockResolvedValueOnce([row]);
    expect(project(await h.repo.resolveFeedback(request())).status).toBe("unavailable");
    expect(getter).not.toHaveBeenCalled();
  });
  it.runIf(Boolean(process.env.MATERIAL_COURSE_REAL_FULL_INPUT))("all 150 real generic 041fc627 questions stay unavailable without imported trusted bindings", async () => {
    const path = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
    expect(path, "real corrected whole-package input is required").toBeTruthy();
    const bytes = readFileSync(path!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
    const data = JSON.parse(bytes.toString()) as { questions: Array<{ id: string; sourceFile: string; physicalPage: number }> };
    expect(data.questions).toHaveLength(150);
    const h = harness(); h.resolvePostAttemptBinding.mockResolvedValue(null);
    for (const question of data.questions) {
      const access: MaterialFeedbackAccessRequest = { questionId: question.id, source: { file: question.sourceFile, page: question.physicalPage },
        attemptId: id(4), mode: "post_attempt" };
      const snapshot = await h.repo.resolveFeedback(access);
      expect(snapshot).toBeNull();
      expect(projectMaterialFeedback(question, access, { resolveFeedback: () => snapshot }).status).toBe("unavailable");
    }
    expect(h.resolvePostAttemptBinding).toHaveBeenCalledTimes(150);
    expect(h.query).not.toHaveBeenCalled();
  });
  it("keeps early-help projection unavailable without recording an exposure", async () => {
    const h = harness(), access = { ...request(), mode: "explicit_help" as const };
    const snapshot = await h.repo.resolveFeedback(access);
    const dto = projectMaterialFeedback({ id: h.b.blockId, sourceFile: h.b.sourceFile, physicalPage: h.b.physicalPage,
      postAttemptNotes: "PRIVATE", exposureRecorded: true }, access, { resolveFeedback: () => snapshot });
    expect(dto.status).toBe("unavailable");
    expect(h.query).not.toHaveBeenCalled();
  });
  it("binds hostile source names as parameters without interpolating SQL text", async () => {
    const b = binding(); b.sourceFile = "x.pdf'; SELECT 'PRIVATE' --";
    const h = harness(b);
    expect(await h.repo.resolveFeedback(request(b))).toEqual({ answer: "Saved answer", postAttemptNotes: null });
    const [parts, ...parameters] = h.query.mock.calls[0]!;
    expect(parts.join("")).not.toContain(b.sourceFile);
    expect(parameters).toContain(b.sourceFile);
  });
  it("cannot substitute an imported teaching binding for a generic offline ID at the same source/page", async () => {
    const h = harness();
    const access = { ...request(), questionId: "Q9" };
    expect(await h.repo.resolveFeedback(access)).toBeNull(); expect(h.query).not.toHaveBeenCalled();
  });
  it("rejects ambiguous stored block IDs", async () => {
    const h = harness(); h.stored.duplicate = true;
    expect(await h.repo.resolveFeedback(request())).toBeNull();
  });
});
