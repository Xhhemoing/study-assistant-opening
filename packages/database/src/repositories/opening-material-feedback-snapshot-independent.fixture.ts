import { isDeepStrictEqual } from "node:util";
import type { JSONValue, Sql } from "postgres";
import { vi } from "vitest";
import type { MaterialFeedbackAccessRequest, MaterialFeedbackSnapshot } from "../../../domain/src/opening/material-attempt-presentation";
import { projectMaterialFeedback } from "../../../domain/src/opening/material-attempt-presentation";
import type { OpeningMaterialFeedbackBinding, OpeningMaterialFeedbackHost } from "./opening-material-feedback-snapshot";
import type { openingLearningAttempts, openingLearningItemVersions } from "../schema/opening-learning-attempts";

export const uuid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const SAVED_ANSWER = "Independent stored answer, not client text";
export function binding(): OpeningMaterialFeedbackBinding {
  return {
    workspaceId: uuid(1), ownerUserId: uuid(2), courseId: uuid(3), attemptId: uuid(4), itemVersionId: uuid(5),
    problemId: uuid(6), activityId: uuid(7), teachingUnitId: uuid(8), documentId: uuid(9), revisionId: uuid(10),
    revisionNumber: 3, contentVersion: 7, blockId: uuid(11), answerBlockId: uuid(12), sourceId: uuid(13),
    sourceVersion: 5, sourceSha256: "b".repeat(64), sourceFile: "independent-fixture.pdf", physicalPage: 9,
    revisionBlocks: [
      { id: uuid(11), type: "question", content: { text: "Independent saved prompt" } },
      { id: uuid(12), type: "solution", content: { text: SAVED_ANSWER, rubric: "PRIVATE RUBRIC" } },
    ],
    blockOrder: [{ blockId: uuid(11), role: "prompt", position: 0 }, { blockId: uuid(12), role: "answer_key", position: 1 }],
    sourceRefs: [{ sourceId: uuid(13), version: 5, page: 9 }],
  };
}
export function request(b = binding()): MaterialFeedbackAccessRequest {
  return { questionId: b.blockId, attemptId: b.attemptId, mode: "post_attempt", source: { file: b.sourceFile, page: b.physicalPage } };
}
export function present(snapshot: MaterialFeedbackSnapshot | null, r = request()) {
  return projectMaterialFeedback({ id: r.questionId, sourceFile: r.source.file, physicalPage: r.source.page,
    answer: { role: "answer_key", text: "CLIENT ANSWER" }, postAttemptNotes: "CLIENT NOTES", mastery: true }, r,
  { resolveFeedback: () => snapshot });
}

type Attempt = Pick<typeof openingLearningAttempts.$inferSelect,
  "id" | "workspaceId" | "ownerUserId" | "courseId" | "itemVersionId" | "problemId" | "activityId" | "submittedAt">;
type Item = Pick<typeof openingLearningItemVersions.$inferSelect, "id" | "ownerUserId" | "courseId" | "problemId">;
export type StoredFacts = {
  current: OpeningMaterialFeedbackBinding; attempt: Attempt; item: Item;
  document: { deletedAt: Date | null; currentRevisionNumber: number };
  activity: { status: string; contentVersion: number; generateStatus: string };
  source: { uploadState: string; parseState: string }; excluded: boolean; membershipRole: "primary" | "archive" | null;
};
export function facts(b = binding()): StoredFacts {
  return { current: structuredClone(b),
    attempt: { id: b.attemptId, workspaceId: b.workspaceId, ownerUserId: b.ownerUserId, courseId: b.courseId,
      itemVersionId: b.itemVersionId, problemId: b.problemId, activityId: b.activityId, submittedAt: new Date("2026-01-01T00:00:00Z") },
    item: { id: b.itemVersionId, ownerUserId: b.ownerUserId, courseId: b.courseId, problemId: b.problemId },
    document: { deletedAt: null, currentRevisionNumber: b.revisionNumber },
    activity: { status: "active", contentVersion: b.contentVersion, generateStatus: "ready" },
    source: { uploadState: "uploaded", parseState: "ready" }, excluded: false, membershipRole: "primary" };
}
type Row = { answer: unknown; privateExtra?: string };

/** Bounded typed SQL fake, NOT PostgreSQL or authentication. Only the listed
 * parameter equalities and relational predicates are interpreted. Missing a
 * guard removes its filtering effect (rather than making the fake assert it),
 * so real-module guard-removal mutants can reach/leak the stored row. Other SQL
 * semantics, joins and JSON error behavior need actual PG integration review.
 * Returned rows cannot establish current publication/submission/source facts.
 */
export function sqlFake(stored = facts()) {
  const controls = {
    rows: null as Row[] | null,
    beforeRead: null as (() => void | Promise<void>) | null,
    error: null as Error | null,
  };
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]): Promise<Row[]> => {
    if (controls.beforeRead) await controls.beforeRead();
    if (controls.error) throw controls.error;
    const text = parts.reduce((out, part, index) => out + (index ? `$${index}` : "") + part, "");
    if (!text.trimStart().startsWith("SELECT ") || /\b(INSERT|UPDATE|DELETE)\b/.test(text)) throw new Error("read-only SELECT required");
    const c = stored.current;
    const cells: Record<string, unknown> = {
      "attempt.workspace_id": stored.attempt.workspaceId, "attempt.owner_user_id": stored.attempt.ownerUserId,
      "attempt.course_id": stored.attempt.courseId, "attempt.id": stored.attempt.id,
      "attempt.item_version_id": stored.attempt.itemVersionId, "attempt.problem_id": stored.attempt.problemId,
      "attempt.activity_id": stored.attempt.activityId, "spec.teaching_unit_id": c.teachingUnitId,
      "spec.document_id": c.documentId, "revision.id": c.revisionId, "revision.revision_number": c.revisionNumber,
      "spec.version": c.contentVersion, "item.teaching_block_id": c.blockId,
      "item.evaluation_spec->>'answerBlockId'": c.answerBlockId, "revision.blocks": c.revisionBlocks,
      "spec.block_order": c.blockOrder, "spec.source_refs": c.sourceRefs,
      "source.id": c.sourceId, "source.name": c.sourceFile, "source.version": c.sourceVersion,
      "source.sha256": c.sourceSha256, "chunk.page": c.physicalPage,
      "prompt.block->>'id'": c.blockId, "key.block->>'id'": c.answerBlockId,
      "(spec.source_refs->0->>'page')::int": c.physicalPage,
      "p->>'blockId'": c.blockId, "k->>'blockId'": c.answerBlockId,
    };
    for (const [expression, actual] of Object.entries(cells)) {
      const escaped = expression.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      for (const match of text.matchAll(new RegExp(`${escaped}=\\$(\\d+)(?!\\d)`, "g"))) {
        if (!isDeepStrictEqual(actual, values[Number(match[1]) - 1])) return [];
      }
    }
    const rules: [string, boolean][] = [
      ["attempt.submitted_at IS NOT NULL", stored.attempt.submittedAt !== null],
      ["item.id=attempt.item_version_id", stored.item.id === stored.attempt.itemVersionId],
      ["item.owner_user_id=attempt.owner_user_id", stored.item.ownerUserId === stored.attempt.ownerUserId],
      ["item.course_id=attempt.course_id", stored.item.courseId === stored.attempt.courseId],
      ["item.problem_id=attempt.problem_id", stored.item.problemId === stored.attempt.problemId],
      ["document.deleted_at IS NULL", stored.document.deletedAt === null],
      ["document.current_revision_number=spec.revision_number", stored.document.currentRevisionNumber === c.revisionNumber],
      ["activity.content_version=spec.version", stored.activity.contentVersion === c.contentVersion],
      ["activity.generate_status='ready'", stored.activity.generateStatus === "ready"],
      ["activity.status IN ('active','paused','completed')", ["active", "paused", "completed"].includes(stored.activity.status)],
      ["membership.role<>'archive'", stored.membershipRole !== null && stored.membershipRole !== "archive"],
      ["source.upload_state='uploaded'", stored.source.uploadState === "uploaded"],
      ["source.parse_state='ready'", stored.source.parseState === "ready"],
      ["exclusion.source_id=source.id", !stored.excluded],
    ];
    if (rules.some(([predicate, accepted]) => text.includes(predicate) && !accepted)) return [];
    if (controls.rows) return controls.rows;
    const blocks = c.revisionBlocks as { id: string; content: { text: string } }[];
    return [{ answer: blocks.find(block => block.id === c.answerBlockId)?.content.text, privateExtra: "PRIVATE ROW" }];
  });
  const sql = Object.assign(query, { json: (value: JSONValue) => value }) as unknown as Sql;
  return { sql, query, stored, controls };
}
export function hostFor(b: OpeningMaterialFeedbackBinding | null = binding()): OpeningMaterialFeedbackHost {
  return { resolvePostAttemptBinding: vi.fn(async () => b) };
}
export type RepositoryFactory = typeof import("./opening-material-feedback-snapshot").createOpeningMaterialFeedbackSnapshotRepository;
export function harness(factory: RepositoryFactory, b = binding(), stored = facts(b)) {
  const db = sqlFake(stored);
  const host = hostFor(b);
  return { b, host, db, repo: factory(db.sql, host) };
}
