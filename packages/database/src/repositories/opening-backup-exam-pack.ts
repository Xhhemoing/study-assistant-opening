import { isDeepStrictEqual } from "node:util";
import { courseExamSnapshotSchema, type ExamSprintState } from "@aistudy/contracts";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";

type Row = Record<string, unknown>;
const catalogReference = { id: EXAM_SPRINT_PACK.id, version: EXAM_SPRINT_PACK.version };

/** Preserve the pinned identity. Correct answers and unreleased mocks come only from the server catalog. */
export function exportSprintPack(row: Row): Row {
  if (row.course_id != null) {
    const pack = courseExamSnapshotSchema.parse(row.pack_snapshot);
    // Keep the learner's request, source and identity. A ready request requires its
    // private answer-bearing proposal; importing it cannot certify a ready publication.
    return { ...row, pack_snapshot: { ...pack, requests: pack.requests.map(request =>
      request.status === "pending" || request.status === "ready"
        ? { ...request, status: "unknown", proposal: null, activityId: null } : request) } };
  }
  const { pack, state } = parseExamSprintSnapshot(row.pack_snapshot, row.state);
  if (!isDeepStrictEqual(pack, EXAM_SPRINT_PACK)) throw new Error("Frozen sprint pack does not match the trusted restore catalog");
  const sealed = new Set(state.runs.filter(run => (run.mode === "mock-a" || run.mode === "mock-b") && run.completedAt === null).map(run => run.id));
  for (const attempt of state.attempts) {
    delete attempt.resultMetadata;
    if (sealed.has(attempt.runId)) {
      attempt.correct = null;
      delete attempt.prediction;
    }
  }
  return { ...row, pack_snapshot: catalogReference, state };
}

export function restoreSprintPack(row: Row): Row {
  if (row.course_id != null) {
    const pack = courseExamSnapshotSchema.parse(row.pack_snapshot);
    if (pack.requests.some(request => request.proposal !== null || request.status === "pending")) {
      throw new Error("Private or pending exam request in learner backup");
    }
    return row;
  }
  if (!isDeepStrictEqual(row.pack_snapshot, catalogReference)) throw new Error("Unrecognized sprint catalog reference");
  // Recompute sealed correctness from the trusted revision before validating the persisted shape.
  const incoming = structuredClone(row.state) as Partial<ExamSprintState> | null;
  if (!incoming || !Array.isArray(incoming.runs) || !Array.isArray(incoming.attempts)) throw new Error("Invalid sprint history");
  const sealed = new Set(incoming.runs.filter(run => (run.mode === "mock-a" || run.mode === "mock-b") && run.completedAt === null).map(run => run.id));
  for (const attempt of incoming.attempts) {
    if (sealed.has(attempt.runId) && attempt.answer !== null) {
      if (attempt.correct !== null) throw new Error("Sealed mock result in learner archive");
      attempt.correct = EXAM_SPRINT_PACK.questions.find(question => question.id === attempt.questionId)?.answer === attempt.answer;
    }
    attempt.firstFamilyExposure = false;
  }
  const { pack, state } = parseExamSprintSnapshot(EXAM_SPRINT_PACK, incoming);
  if (state.attempts.some(attempt => attempt.resultMetadata !== undefined)) throw new Error("Private exam result in learner backup");
  return { ...row, pack_snapshot: pack, state };
}
