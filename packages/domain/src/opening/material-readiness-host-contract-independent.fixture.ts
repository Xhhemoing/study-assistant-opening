import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { adaptMaterialCourseFullPackage, materialCourseFullPackageSchema, type MaterialCourseFullPackage } from "./material-course-package-adapter";

// Opt-in private replay only. No machine path or private JSON is shipped with tests.
export function readPrivatePackage(path: string, expectedSha256: string) {
  const bytes = readFileSync(path); // A supplied bad path is an error, never a skip.
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || createHash("sha256").update(bytes).digest("hex") !== expectedSha256) {
    throw new Error("Private package SHA256 mismatch");
  }
  return materialCourseFullPackageSchema.parse(JSON.parse(bytes.toString("utf8")));
}
import type { MaterialBindingVerificationRequest, MaterialReadinessAuthority } from "./material-course-package-readiness";

// Entirely invented records. This host DI oracle is not an authenticated producer.
export const uuid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const asOf = "2026-11-11T12:00:00.123+00:00";
export const purposes = ["route_submission", "plan_submission", "diagnostic_execution", "scoring"] as const;
export type Purpose = typeof purposes[number];
export function fixture() {
  const pack: MaterialCourseFullPackage = {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "d".repeat(64), questionIndexSha256: "e".repeat(64), mappingFiles: [],
    sources: [{ file: "invented-host-contract.pdf", sha256: "f".repeat(64), physicalPages: 3 }],
    skills: ["host-alpha", "host-beta"].map((id, i) => ({ id, title: id, topic: 1, prerequisiteIds: i ? ["host-alpha"] : [],
      learningObjectives: ["PRIVATE_OBJECTIVE"], commonErrors: ["PRIVATE_ERROR"],
      sourceRefs: [{ file: "invented-host-contract.pdf", physicalPages: [1], verification: "text-reviewed" }] })),
    prerequisiteOrder: ["host-alpha", "host-beta"],
    questions: Array.from({ length: 150 }, (_, i) => ({ id: `host-q-${i}`, topic: 1, kind: "Test", number: i + 1,
      sourceFile: "invented-host-contract.pdf", physicalPage: 1, primarySkillId: "host-alpha", secondarySkillIds: ["host-beta"],
      evidenceType: "objective-choice", mappingStatus: "text-reviewed", postAttemptNotes: "PRIVATE_FEEDBACK",
      assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification" })),
    diagnostic: { status: "candidate-not-administered", source: "Invented selection", questionIds: Array.from({ length: 20 }, (_, i) => `host-q-${i}`), constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "No credit", requiredRuntimeChecks: [], constructedResponsePolicy: "No split credit", familyPolicy: "No real family", feedbackPolicy: "Feedback only" },
    schedule: { productTarget: "Invented", latestProductUseDate: "Not an exam date", actualExamDate: null, dailyStudyMinutes: null, policy: "No guessed budget", unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [] },
    coverageGaps: [], coverageGapNotes: [],
    validation: { sourcePdfs: 1, questionCount: 150, skillCount: 2, textMappedCount: 150, visualCheckRequired: [], disputedDiagnosticExclusions: [], semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
  const candidate = adaptMaterialCourseFullPackage(pack, { deadlineAt: null });
  const scope = { ownerUserId: uuid(1), courseId: uuid(2), routeVersion: 4, teachingVersion: 7 };
  const route = { expectedRevisions: [{ id: uuid(3), revision: 2 }], confirmScope: true,
    requirements: ["host-alpha", "host-beta"].map((id, i) => ({ id: uuid(3 + i), stableSkillId: uuid(13 + i), knowledgeNodeId: uuid(23 + i), requirementKey: id, title: id,
      position: i, mandatory: true, goalIds: [uuid(10)], prerequisiteIds: i ? [uuid(3)] : [],
      sourceRefs: [{ sourceId: uuid(5), sourceVersion: 2, page: 1 }],
      verification: { kind: "manual", status: "needs_check", exerciseKeys: ["host-q-0"], rubric: null, missingReasons: ["Invented"] }, origin: "confirmed" })) };
  const draft = { id: uuid(6), date: "2026-11-11", version: 3, baseVersion: 2, status: "draft", blocks: [], unscheduledTaskIds: [uuid(7)],
    suggestedTasks: [{ key: "host-task", id: uuid(7), kind: "new_skill", title: "Invented task", minutes: 20, courseId: scope.courseId,
      skillLabel: "Invented skill", requirementKey: "host-alpha", reasonCode: "new_skill", reason: "Invented reason" }] };
  const identity = { protocolVersion: "question-identity-1", identityRefId: uuid(8), questionRef: { kind: "source_problem", problemId: uuid(9), sourceId: uuid(5), sourceVersion: 2 },
    sourceRefs: [{ sourceId: uuid(5), version: 2, page: 1 }], conditionRefs: [{ kind: "source", sourceId: uuid(5), version: 2, page: 1 }],
    figureRefs: [{ kind: "source", sourceId: uuid(5), version: 2, page: 2 }], answerRole: "answer_key" };
  const key = { keyRefId: uuid(11), identity, verification: { kind: "deterministic_evaluator", receiptId: uuid(12), evaluatorId: "PRIVATE_EVALUATOR", evaluatorVersion: "invented-v3" } };
  const diagnostic = { start: { goalId: uuid(10), expectedGoalRevision: 2, clientKey: "host-start", minutes: 20, requirementId: uuid(3), expectedRequirementRevision: 2,
    taskId: uuid(7), expectedTaskVersion: 3 }, problem: { problemId: uuid(9), sourceId: uuid(5), sourceVersion: 2, physicalPage: 1, chunkId: uuid(20), stemSnapshot: "PRIVATE_PROMPT", artifactKind: "reference_item" }, key };
  const bindings = { scope, route, plan: { draft, accept: { draftId: draft.id, expectedBaseVersion: 2, clientKey: "host-accept", acceptSuggestedKeys: ["host-task"] } },
    questions: [0, 1].map(i => ({ questionId: `host-q-${i}`, diagnostic: structuredClone(diagnostic), scoring: structuredClone(key) })) };
  return { candidate, bindings };
}
export type Fixture = ReturnType<typeof fixture>;
export function expectedRequests(f: Fixture): MaterialBindingVerificationRequest[] {
  // Deliberately independent expected records: never derive the oracle from observed callback args.
  const common = { candidate: structuredClone(f.candidate), scope: structuredClone(f.bindings.scope), asOf };
  return [
    { ...common, purpose: "route_submission", externalQuestionId: null, payload: structuredClone(f.bindings.route) } as MaterialBindingVerificationRequest,
    { ...common, purpose: "plan_submission", externalQuestionId: null, payload: structuredClone(f.bindings.plan) } as MaterialBindingVerificationRequest,
    ...f.bindings.questions.flatMap(q => [
      { ...common, purpose: "diagnostic_execution", externalQuestionId: q.questionId, payload: structuredClone(q.diagnostic) } as MaterialBindingVerificationRequest,
      { ...common, purpose: "scoring", externalQuestionId: q.questionId, payload: structuredClone(q.scoring) } as MaterialBindingVerificationRequest,
    ]),
  ].map(record => structuredClone(record));
}
export function exactHost(records: MaterialBindingVerificationRequest[]) {
  const saved = structuredClone(records), calls: MaterialBindingVerificationRequest[] = [];
  const authority: MaterialReadinessAuthority = { asOf, verifyBinding(request) {
    calls.push(structuredClone(request));
    return saved.some(record => isDeepStrictEqual(record, request));
  } };
  return { authority, calls };
}
export type Path = (string | number)[];
export function leaves(value: unknown, path: Path = []): { path: Path; value: unknown }[] {
  if (value === null || typeof value !== "object") return [{ path, value }];
  const entries = Object.entries(value);
  return entries.length ? entries.flatMap(([k, v]) => leaves(v, [...path, Array.isArray(value) ? Number(k) : k])) : [{ path, value }];
}
export function replaceAt(value: unknown, path: Path, replacement: unknown) {
  let target = value;
  for (const segment of path.slice(0, -1)) target = Reflect.get(target as object, segment);
  Reflect.set(target as object, path.at(-1)!, replacement);
}
export function different(value: unknown): unknown {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  if (typeof value === "string") return value + "-different";
  return value === null ? "different" : ["different"];
}
