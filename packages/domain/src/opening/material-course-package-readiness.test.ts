import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  acceptPlanInputSchema, courseRouteConfirmSchema, courseRouteRequirementInputSchema, courseRouteStartSchema,
  planDraftSchema, privateTrustedQuestionKeySchema, problemRefSchema, suggestedTaskSchema,
} from "@aistudy/contracts";
import { adaptMaterialCourseFullPackage, type MaterialCourseFullPackage } from "./material-course-package-adapter";
import { assessMaterialCoursePackageReadiness, type MaterialReadinessAuthority } from "./material-course-package-readiness";

// These identities and bodies exist ONLY in synthetic unit fixtures, never real-material bindings.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const scope = { ownerUserId: uuid(1), courseId: uuid(2), routeVersion: 0, teachingVersion: 0 };
function fixture() {
  const pack: MaterialCourseFullPackage = {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64), questionIndexSha256: "b".repeat(64), mappingFiles: [],
    sources: [{ file: "synthetic.pdf", sha256: "c".repeat(64), physicalPages: 2 }],
    skills: ["synthetic-first", "synthetic-second"].map((id, i) => ({ id, title: id, topic: 1,
      prerequisiteIds: i ? ["synthetic-first"] : [], learningObjectives: [], commonErrors: [],
      sourceRefs: [{ file: "synthetic.pdf", physicalPages: [1], verification: "text-reviewed" }] })),
    prerequisiteOrder: ["synthetic-first", "synthetic-second"],
    questions: Array.from({ length: 150 }, (_, i) => ({ id: `synthetic-q-${i}`, topic: 1, kind: "Test", number: i + 1,
      sourceFile: "synthetic.pdf", physicalPage: 1, primarySkillId: "synthetic-first", secondarySkillIds: ["synthetic-second"],
      evidenceType: "objective-choice", mappingStatus: "text-reviewed", postAttemptNotes: "Synthetic mapping only",
      assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification" })),
    diagnostic: { status: "candidate-not-administered", source: "Synthetic selection", questionIds: Array.from({ length: 20 }, (_, i) => `synthetic-q-${i}`), constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "No admission", requiredRuntimeChecks: [], constructedResponsePolicy: "No split credit", familyPolicy: "Not certified", feedbackPolicy: "Feedback only" },
    schedule: { productTarget: "Synthetic target", latestProductUseDate: "Not an exam date", actualExamDate: null, dailyStudyMinutes: null, policy: "No guessed schedule", unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [] },
    coverageGaps: [], coverageGapNotes: [],
    validation: { sourcePdfs: 1, questionCount: 150, skillCount: 2, textMappedCount: 150, visualCheckRequired: [], disputedDiagnosticExclusions: [], semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
  return adaptMaterialCourseFullPackage(pack, { deadlineAt: null });
}
function bindings() {
  const route = { expectedRevisions: [], confirmScope: true, requirements: ["synthetic-first", "synthetic-second"].map((skill, i) => ({
    id: uuid(3 + i), stableSkillId: uuid(13 + i), knowledgeNodeId: null, requirementKey: skill, title: skill, position: i,
    mandatory: true, goalIds: [], prerequisiteIds: i ? [uuid(3)] : [], sourceRefs: [{ sourceId: uuid(5), sourceVersion: 0, page: 1 }],
    verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: null, missingReasons: ["Synthetic fixture"] }, origin: "confirmed",
  })) };
  const draft = { id: uuid(6), date: "2026-11-11", version: 0, baseVersion: 0, status: "draft", blocks: [], unscheduledTaskIds: [],
    suggestedTasks: [{ key: "synthetic-task", id: uuid(7), kind: "new_skill", title: "Synthetic task", minutes: 20,
      courseId: scope.courseId, skillLabel: "Synthetic skill", requirementKey: "synthetic-first", reasonCode: "new_skill", reason: "Synthetic unit fixture" }] };
  const identity = { protocolVersion: "question-identity-1", identityRefId: uuid(8), questionRef: {
    kind: "source_problem", problemId: uuid(9), sourceId: uuid(5), sourceVersion: 0 },
    sourceRefs: [{ sourceId: uuid(5), version: 0, page: 1 }], conditionRefs: [{ kind: "source", sourceId: uuid(5), version: 0, page: 1 }],
    figureRefs: [], answerRole: "answer_key" };
  const key = { keyRefId: uuid(11), identity, verification: { kind: "deterministic_evaluator", receiptId: uuid(12), evaluatorId: "synthetic-unit", evaluatorVersion: "1" } };
  const diagnostic = { start: { goalId: uuid(10), expectedGoalRevision: 1, clientKey: "synthetic-start", minutes: 20,
    requirementId: uuid(3), expectedRequirementRevision: 1 },
    problem: { problemId: uuid(9), sourceId: uuid(5), sourceVersion: 0, physicalPage: 1, chunkId: null,
      stemSnapshot: "Synthetic prompt unit fixture ONLY", artifactKind: "reference_item" }, key };
  return { scope: { ...scope }, route, plan: { draft, accept: { draftId: draft.id, expectedBaseVersion: 0, clientKey: "synthetic-accept" } },
    questions: [{ questionId: "synthetic-q-0", diagnostic, scoring: structuredClone(key) }] };
}
const asOf = "2026-11-11T10:00:00Z"; // Synthetic host clock only, never a real input date.
const allow: MaterialReadinessAuthority = { asOf, verifyBinding: () => true };

function expectNotExecutable(report: ReturnType<typeof assessMaterialCoursePackageReadiness>) {
  expect(report.routeSubmission.status).toBe("not_ready"); expect(report.planSubmission.status).toBe("not_ready");
  expect(report.import.status).toBe("not_ready");
  expect(report.questions.every(q => q.diagnostic.status === "not_ready" && q.scoring.status === "not_ready" && q.bkt.status === "not_ready")).toBe(true);
  expect(Object.values(report.permissions)).toEqual([false, false, false, false]);
}

describe("offline full package explicit readiness boundary", () => {
  it("actually calls existing schemas: every proposed route/plan row fails; preserves preview and input", () => {
    const c = fixture(), before = structuredClone(c);
    const report = assessMaterialCoursePackageReadiness(c);
    expect(report.preview).toEqual({ status: "available", skills: 2, questions: 150, coverageExhaustive: false });
    for (const [i, row] of report.requirements.entries()) {
      expect(row.routeCheck.valid).toBe(courseRouteRequirementInputSchema.safeParse(c.routeInput.requirements[i]).success);
      expect(row.planCheck.valid).toBe(suggestedTaskSchema.safeParse(c.planInput.items[i]).success);
      expect(row.routeCheck.valid).toBe(false); expect(row.planCheck.valid).toBe(false);
      expect(row.routeCheck.issues.map(i => i.path)).toEqual(expect.arrayContaining(["id", "stableSkillId", "mandatory", "prerequisiteIds"]));
      expect(row.planCheck.issues.map(i => i.path)).toEqual(expect.arrayContaining(["key", "id", "kind", "minutes", "courseId"]));
    }
    expectNotExecutable(report); expect(c).toEqual(before);
    expect(report.questions[0]!.bkt.blockers).toContain("part_level_evidence_missing_no_multi_skill_credit");
  });

  it("only complete independently verified synthetic contracts ready corresponding capabilities", () => {
    const b = bindings(), before = structuredClone(b);
    expect(courseRouteConfirmSchema.safeParse(b.route).success).toBe(true);
    expect(planDraftSchema.safeParse(b.plan.draft).success).toBe(true);
    expect(acceptPlanInputSchema.safeParse(b.plan.accept).success).toBe(true);
    expect(courseRouteStartSchema.safeParse(b.questions[0]!.diagnostic.start).success).toBe(true);
    expect(problemRefSchema.safeParse(b.questions[0]!.diagnostic.problem).success).toBe(true);
    expect(privateTrustedQuestionKeySchema.safeParse(b.questions[0]!.diagnostic.key).success).toBe(true);
    expect(privateTrustedQuestionKeySchema.safeParse(b.questions[0]!.scoring).success).toBe(true);
    const verifyBinding = vi.fn(allow.verifyBinding);
    const r = assessMaterialCoursePackageReadiness(fixture(), b, { asOf, verifyBinding });
    expect(r.routeSubmission.status).toBe("ready"); expect(r.planSubmission.status).toBe("ready");
    expect(r.questions[0]!.diagnostic.status).toBe("ready"); expect(r.questions[0]!.scoring.status).toBe("ready");
    expect(r.questions[1]!.diagnostic.status).toBe("not_ready"); expect(r.questions[1]!.scoring.status).toBe("not_ready");
    expect(r.questions.every(q => q.bkt.status === "not_ready")).toBe(true); expect(r.import.status).toBe("not_ready");
    expect(verifyBinding.mock.calls.map(([r]) => r.purpose)).toEqual(["route_submission", "plan_submission", "diagnostic_execution", "scoring"]);
    expect(b).toEqual(before); expect(Object.values(r.permissions)).toEqual([false, false, false, false]);
    expect(JSON.stringify(r)).not.toContain("Synthetic prompt"); expect(JSON.stringify(r)).not.toContain(uuid(11));
  });

  it.each([undefined, { asOf, verifyBinding: () => false }, { asOf, verifyBinding: () => "yes" as unknown as boolean }])("UUID/receipt parsing is not trust (%s)", authority => {
    expectNotExecutable(assessMaterialCoursePackageReadiness(fixture(), bindings(), authority));
  });

  it.each(["route_submission", "plan_submission", "diagnostic_execution", "scoring"])("trust is purpose scoped: %s", purpose => {
    const r = assessMaterialCoursePackageReadiness(fixture(), bindings(), { asOf, verifyBinding: r => r.purpose === purpose });
    expect(r.routeSubmission.status === "ready").toBe(purpose === "route_submission");
    expect(r.planSubmission.status === "ready").toBe(purpose === "plan_submission");
    expect(r.questions[0]!.diagnostic.status === "ready").toBe(purpose === "diagnostic_execution");
    expect(r.questions[0]!.scoring.status === "ready").toBe(purpose === "scoring");
  });

  it("never invokes resolver for absent scope, incomplete schemas or conflicting captured versions", () => {
    const verifyBinding = vi.fn(() => true), b = bindings();
    assessMaterialCoursePackageReadiness(fixture(), { scope, route: {} }, { asOf, verifyBinding });
    assessMaterialCoursePackageReadiness(fixture(), { ...b, scope: undefined }, { asOf, verifyBinding });
    for (const field of ["ownerUserId", "courseId", "routeVersion", "teachingVersion"] as const) {
      const c = fixture(); Object.assign(c, { [field]: field.endsWith("Version") ? 99 : uuid(99) });
      expectNotExecutable(assessMaterialCoursePackageReadiness(c, b, { asOf, verifyBinding }));
    }
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it("resolver failures propagate, not converted to fake success", () => {
    expect(() => assessMaterialCoursePackageReadiness(fixture(), bindings(), { asOf, verifyBinding: () => { throw new Error("unavailable"); } })).toThrow("unavailable");
  });

  it.each(["missing-key", "identity", "source-version", "page", "student-work", "source-family"])("diagnostic rejects %s despite permissive resolver", kind => {
    const b = bindings(), d = b.questions[0]!.diagnostic;
    if (kind === "missing-key") Reflect.deleteProperty(d, "key");
    if (kind === "identity") d.problem.problemId = uuid(99);
    if (kind === "source-version") d.problem.sourceVersion = 99;
    if (kind === "page") d.problem.physicalPage = 2;
    if (kind === "student-work") d.problem.artifactKind = "student_work";
    if (kind === "source-family") Object.assign(d.key, { verification: { kind: "independent_family", receiptId: uuid(12), familyId: uuid(5), verifierId: "synthetic", verifierVersion: "1" } });
    expect(assessMaterialCoursePackageReadiness(fixture(), b, allow).questions[0]!.diagnostic.status).toBe("not_ready");
  });

  it.each(["route-key", "prerequisite", "plan-course", "accept-id", "accept-version", "accept-key", "duplicate-task"])("schema success cannot override package mismatch %s", kind => {
    const b = bindings();
    if (kind === "route-key") b.route.requirements[0]!.requirementKey = "other";
    if (kind === "prerequisite") b.route.requirements[1]!.prerequisiteIds = [];
    if (kind === "plan-course") b.plan.draft.suggestedTasks[0]!.courseId = uuid(99);
    if (kind === "accept-id") b.plan.accept.draftId = uuid(99);
    if (kind === "accept-version") b.plan.accept.expectedBaseVersion = 99;
    if (kind === "accept-key") Object.assign(b.plan.accept, { acceptSuggestedKeys: ["unknown-key"] });
    if (kind === "duplicate-task") b.plan.draft.suggestedTasks.push(b.plan.draft.suggestedTasks[0]!);
    const r = assessMaterialCoursePackageReadiness(fixture(), b, allow);
    expect(kind.startsWith("route") || kind === "prerequisite" ? r.routeSubmission.status : r.planSubmission.status).toBe("not_ready");
  });

  it("independently resolved family receipts ready the exact question only, never skill credit", () => {
    const b = bindings(); Object.assign(b.questions[0]!.scoring, { verification: {
      kind: "independent_family", receiptId: uuid(12), familyId: "synthetic-family-not-source", verifierId: "synthetic", verifierVersion: "1" } });
    expect(privateTrustedQuestionKeySchema.safeParse(b.questions[0]!.scoring).success).toBe(true);
    expect(assessMaterialCoursePackageReadiness(fixture(), b).questions[0]!.scoring.status).toBe("not_ready");
    const r = assessMaterialCoursePackageReadiness(fixture(), b, allow);
    expect(r.questions[0]!.scoring.status).toBe("ready");
    expect(r.questions[1]!.scoring.status).toBe("not_ready");
    expect(r.questions.every(q => q.bkt.status === "not_ready")).toBe(true);
  });

  it.each(["route", "plan", "accept", "start", "identity", "receipt", "question-binding", "scope"])("never promotes nested binding pollution: %s", kind => {
    const b = bindings();
    const targets: Record<string, object> = { route: b.route, plan: b.plan.draft, accept: b.plan.accept,
      start: b.questions[0]!.diagnostic.start, identity: b.questions[0]!.scoring.identity,
      receipt: b.questions[0]!.scoring.verification, "question-binding": b.questions[0]!, scope: b.scope };
    Object.assign(targets[kind]!, { trusted: true });
    if (kind === "scope" || kind === "question-binding") expect(() => assessMaterialCoursePackageReadiness(fixture(), b, allow)).toThrow();
    else {
      const r = assessMaterialCoursePackageReadiness(fixture(), b, allow);
      const status = kind === "route" ? r.routeSubmission.status : kind === "plan" || kind === "accept" ? r.planSubmission.status
        : kind === "start" ? r.questions[0]!.diagnostic.status : r.questions[0]!.scoring.status;
      expect(status).toBe("not_ready");
    }
  });

  it("source IDs are not scoring family IDs, and no whole-item score grants multi-skill BKT", () => {
    const b = bindings(); Object.assign(b.questions[0]!.scoring, { verification: {
      kind: "independent_family", receiptId: uuid(12), familyId: uuid(5), verifierId: "synthetic", verifierVersion: "1" } });
    const r = assessMaterialCoursePackageReadiness(fixture(), b, allow);
    expect(r.questions[0]!.scoring.blockers).toContain("source_id_is_not_family_identity");
    expect(r.questions[0]!.bkt.status).toBe("not_ready");
    expect(r.questions[0]!.bkt.blockers).toContain("part_level_evidence_missing_no_multi_skill_credit");
  });

  it.each(["top", "question", "source-ref", "route", "verification", "source", "teaching", "plan", "coverage", "schedule", "validation", "diagnostic", "bkt", "gap"])("rejects nested unknown pollution: %s", kind => {
    const c = fixture(); c.coverageGaps.push({ skillId: "synthetic-first", scope: "Synthetic", candidateSource: "Synthetic" });
    const targets: Record<string, object> = { top: c, question: c.questionMappings[0]!, "source-ref": c.questionMappings[0]!.sourceRef,
      route: c.routeInput.requirements[0]!, verification: c.routeInput.requirements[0]!.verification, source: c.sources[0]!,
      teaching: c.teachingInput.items[0]!, plan: c.planInput.items[0]!, coverage: c.coverage[0]!, schedule: c.schedule,
      validation: c.validation, diagnostic: c.diagnostic, bkt: c.bktBoundary, gap: c.coverageGaps[0]! };
    Object.assign(targets[kind]!, { injectedAuthority: true }); expect(() => assessMaterialCoursePackageReadiness(c)).toThrow();
  });

  it.each(["eligible", "visual", "diagnostic-entry", "count", "citation", "bound-source", "coverage", "teaching", "order", "plan", "trusted-verification"])("rejects inconsistent persisted derived state: %s", kind => {
    const c = fixture();
    if (kind === "eligible") c.questionMappings[0]!.diagnosticEligible = false;
    if (kind === "visual") c.questionMappings[0]!.unverifiedFormula = true;
    if (kind === "diagnostic-entry") c.diagnostic.eligibleEntryQuestionIds = [];
    if (kind === "count") c.completeness.mappedQuestions = 149;
    if (kind === "citation") c.questionMappings[0]!.sourceRef.page = 99;
    if (kind === "bound-source") Object.assign(c.questionMappings[0]!.sourceRef, { sourceId: uuid(5), sourceVersion: 0 });
    if (kind === "coverage") c.coverage[0]!.questionIds = [];
    if (kind === "teaching") c.teachingInput.items[0]!.sourceRefs = [];
    if (kind === "order") c.prerequisiteOrder.reverse();
    if (kind === "plan") c.planInput.items[0]!.diagnosticQuestionIds = [];
    if (kind === "trusted-verification") Object.assign(c.routeInput.requirements[0]!.verification, { kind: "exact" });
    expect(() => assessMaterialCoursePackageReadiness(c, bindings(), allow)).toThrow();
  });

  it.each([null, [], "candidate", { status: "proposed" }])("rejects malformed unknown %s", c => {
    expect(() => assessMaterialCoursePackageReadiness(c)).toThrow();
  });

  it("rejects unknown/duplicate question bindings and client authority flags", () => {
    const b = bindings();
    expect(() => assessMaterialCoursePackageReadiness(fixture(), { ...b, verified: true })).toThrow();
    b.questions.push(b.questions[0]!); expect(() => assessMaterialCoursePackageReadiness(fixture(), b)).toThrow();
    b.questions = [{ ...b.questions[0]!, questionId: "unknown" }]; expect(() => assessMaterialCoursePackageReadiness(fixture(), b)).toThrow();
    const polluted = bindings(); Object.assign(polluted.questions[0]!.scoring, { trusted: true });
    expect(assessMaterialCoursePackageReadiness(fixture(), polluted, allow).questions[0]!.scoring.status).toBe("not_ready");
  });

  it.each(["notes", "postAttemptNotes", "reviewed", "trusted", "scoringEvidence"])("rejects legacy or self-signed question metadata: %s", field => {
    const c = fixture(); Object.assign(c.questionMappings[0]!, { [field]: field === "notes" || field === "postAttemptNotes" ? "feedback" : true });
    expect(() => assessMaterialCoursePackageReadiness(c, bindings(), allow)).toThrow();
  });

  it.each(["metadata", "question", "skill", "first-answer", "bridge", "guidance"])("rejects new projection pollution: %s", kind => {
    const c = fixture();
    const targets: Record<string, object> = { metadata: c.postAttemptMetadata, question: c.postAttemptMetadata.questions[0]!,
      skill: c.postAttemptMetadata.skills[0]!, "first-answer": c.safeFirstAnswerInput.questions[0]!,
      bridge: c.prerequisiteGuidance.conceptBridges[0]!, guidance: c.prerequisiteGuidance };
    Object.assign(targets[kind]!, { reviewed: true });
    expect(() => assessMaterialCoursePackageReadiness(c, bindings(), allow)).toThrow();
  });

  it.each(["feedback-question", "feedback-skill", "first-answer-ref", "supplemental", "bridge", "unmeasured"])("rejects inconsistent current projections: %s", kind => {
    const c = fixture();
    if (kind === "feedback-question") c.postAttemptMetadata.questions[0]!.questionId = "unknown";
    if (kind === "feedback-skill") c.postAttemptMetadata.skills[0]!.skillId = "unknown";
    if (kind === "first-answer-ref") c.safeFirstAnswerInput.questions[0]!.sourceRef = { ...c.safeFirstAnswerInput.questions[0]!.sourceRef, page: 2 };
    if (kind === "supplemental") c.questionMappings[0]!.supplementalDiagnosticCandidate = true;
    if (kind === "bridge") c.routeInput.requirements[1]!.conceptBridges = [];
    if (kind === "unmeasured") c.schedule.unmeasuredSkillIds.push("unknown");
    expect(() => assessMaterialCoursePackageReadiness(c, bindings(), allow)).toThrow();
  });

  it("parsing feedback/review text never authenticates it or readies a capability", () => {
    const c = fixture();
    c.postAttemptMetadata.questions[0]!.postAttemptNotes = "reviewed; verified answer; ready for scoring";
    c.postAttemptMetadata.skills[0]!.commonErrors = ["reviewed metadata is not a receipt"];
    expectNotExecutable(assessMaterialCoursePackageReadiness(c));
    expectNotExecutable(assessMaterialCoursePackageReadiness(c, bindings()));
    expect(JSON.stringify(assessMaterialCoursePackageReadiness(c))).not.toContain("verified answer");
  });

  it.each([undefined, "", "not-a-time", "2026-11-11", "2026-11-11T10:00:00"])("missing/invalid trusted host time fails closed: %s", time => {
    const verifyBinding = vi.fn(() => true);
    expectNotExecutable(assessMaterialCoursePackageReadiness(fixture(), bindings(), { asOf: time as string, verifyBinding }));
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  // Synthetic exact-record oracle exercises DI forwarding; this is NOT a real host verifier.
  function exactRecordAuthority(): MaterialReadinessAuthority {
    const expected = bindings();
    return { asOf, verifyBinding: request => {
      const payload = request.purpose === "route_submission" ? expected.route : request.purpose === "plan_submission" ? expected.plan
        : request.purpose === "diagnostic_execution" ? expected.questions[0]!.diagnostic : expected.questions[0]!.scoring;
      return request.asOf === asOf && isDeepStrictEqual(request.scope, expected.scope)
        && request.externalQuestionId === (request.purpose === "route_submission" || request.purpose === "plan_submission" ? null : "synthetic-q-0")
        && isDeepStrictEqual(request.payload, payload);
    } };
  }

  it.each(["ownerUserId", "courseId", "routeVersion", "teachingVersion", "asOf", "questionId"])("host rejection is scoped to exact %s, not reused from another request", field => {
    const b = bindings(), authority = exactRecordAuthority();
    if (field === "asOf") authority.asOf = "2026-11-11T10:00:01Z";
    else if (field === "questionId") b.questions[0]!.questionId = "synthetic-q-1";
    else Object.assign(b.scope, { [field]: field.endsWith("Version") ? 1 : uuid(99) });
    const r = assessMaterialCoursePackageReadiness(fixture(), b, authority);
    if (field === "questionId") {
      expect(r.questions.every(q => q.diagnostic.status === "not_ready" && q.scoring.status === "not_ready")).toBe(true);
    } else expectNotExecutable(r);
  });

  it.each([
    ["route", "id"], ["route", "stableSkillId"], ["route", "mandatory"], ["route", "goalIds"], ["route", "origin"],
    ["route", "sourceVersion"], ["route", "expectedRevision"], ["route", "title"], ["route", "position"],
    ["plan", "date"], ["plan", "version"], ["plan", "minutes"], ["plan", "reason"], ["plan", "clientKey"],
    ["diagnostic", "goalId"], ["diagnostic", "requirementId"], ["diagnostic", "expectedGoalRevision"],
    ["diagnostic", "expectedRequirementRevision"], ["diagnostic", "minutes"], ["diagnostic", "task"], ["diagnostic", "stemSnapshot"],
    ["scoring", "keyRefId"], ["scoring", "identityRefId"], ["scoring", "conditions"], ["scoring", "figures"],
    ["scoring", "receiptId"], ["scoring", "evaluatorId"], ["scoring", "evaluatorVersion"],
  ])("no dropped parameter or schema-only authentication: %s/%s", (purpose, field) => {
    const b = bindings(), row = b.route.requirements[0]!, d = b.questions[0]!.diagnostic, k = b.questions[0]!.scoring;
    if (purpose === "route") {
      if (field === "sourceVersion") row.sourceRefs[0]!.sourceVersion = 1;
      else if (field === "expectedRevision") Object.assign(b.route, { expectedRevisions: [{ id: row.id, revision: 2 }] });
      else Object.assign(row, { [field]: field === "mandatory" ? false : field === "goalIds" ? [uuid(99)] : field === "origin" ? "extracted" : field === "position" ? 9 : field === "title" ? "altered" : uuid(99) });
    }
    if (purpose === "plan") {
      if (field === "date" || field === "version") Object.assign(b.plan.draft, { [field]: field === "date" ? "2026-11-12" : 1 });
      else if (field === "clientKey") b.plan.accept.clientKey = "changed-client-key";
      else Object.assign(b.plan.draft.suggestedTasks[0]!, { [field]: field === "minutes" ? 25 : "changed reason" });
    }
    if (purpose === "diagnostic") {
      if (field === "stemSnapshot") d.problem.stemSnapshot = "Different synthetic prompt";
      else if (field === "task") Object.assign(d.start, { taskId: uuid(98), expectedTaskVersion: 2 });
      else Object.assign(d.start, { [field]: field.endsWith("Revision") ? 2 : field === "minutes" ? 25 : uuid(99) });
    }
    if (purpose === "scoring") {
      if (field === "keyRefId") k.keyRefId = uuid(99);
      else if (field === "identityRefId") k.identity.identityRefId = uuid(99);
      else if (field === "conditions") k.identity.conditionRefs[0]!.page = 2;
      else if (field === "figures") Object.assign(k.identity, { figureRefs: [{ kind: "source", sourceId: uuid(5), version: 0, page: 2 }] });
      else Object.assign(k.verification, { [field]: field === "receiptId" ? uuid(99) : "changed-version-or-id" });
    }
    const r = assessMaterialCoursePackageReadiness(fixture(), b, exactRecordAuthority());
    expect(purpose === "route" ? r.routeSubmission.status : purpose === "plan" ? r.planSubmission.status
      : purpose === "diagnostic" ? r.questions[0]!.diagnostic.status : r.questions[0]!.scoring.status).toBe("not_ready");
    expect(r.questions.every(q => q.bkt.status === "not_ready")).toBe(true);
  });

  it("passes exact purpose/scope/time/version/payload; repeated assessments never memoize host approval", () => {
    const b = bindings(), c = fixture(), requests: unknown[] = [];
    const authority = exactRecordAuthority();
    const verifyBinding = vi.fn<MaterialReadinessAuthority["verifyBinding"]>(r => { requests.push(structuredClone(r)); return authority.verifyBinding(r); });
    const first = assessMaterialCoursePackageReadiness(c, b, { asOf, verifyBinding });
    expect(first.routeSubmission.status).toBe("ready"); expect(first.planSubmission.status).toBe("ready");
    expect(first.questions[0]!.diagnostic.status).toBe("ready"); expect(first.questions[0]!.scoring.status).toBe("ready");
    expect(requests).toEqual([
      { purpose: "route_submission", externalQuestionId: null, candidate: c, scope: b.scope, asOf, payload: b.route },
      { purpose: "plan_submission", externalQuestionId: null, candidate: c, scope: b.scope, asOf, payload: b.plan },
      { purpose: "diagnostic_execution", externalQuestionId: "synthetic-q-0", candidate: c, scope: b.scope, asOf, payload: b.questions[0]!.diagnostic },
      { purpose: "scoring", externalQuestionId: "synthetic-q-0", candidate: c, scope: b.scope, asOf, payload: b.questions[0]!.scoring },
    ]);
    expectNotExecutable(assessMaterialCoursePackageReadiness(c, b, { asOf, verifyBinding: () => false }));
    expectNotExecutable(assessMaterialCoursePackageReadiness(c, b));
    expect(first.questions.every(q => q.bkt.status === "not_ready")).toBe(true);
    expect(first.questions[0]!.scoring.available).toContain("exact_question_only_no_multi_skill_credit");
    expect(first.questions[0]!.bkt.blockers).toContain("part_level_evidence_missing_no_multi_skill_credit");
  });

  it("explicitly identifies missing host/scope/time without treating a schema as authentication", () => {
    const c = fixture(), b = bindings();
    const absent = assessMaterialCoursePackageReadiness(c, b);
    for (const cap of [absent.routeSubmission, absent.planSubmission, absent.questions[0]!.diagnostic, absent.questions[0]!.scoring]) {
      expect(cap.blockers).toContain("trusted_host_verifier_unavailable");
      expect(cap.available).toContain("domain_contract_only_not_host_authentication");
    }
    const noScope = assessMaterialCoursePackageReadiness(c, {}, allow);
    expect(noScope.routeSubmission.blockers).toContain("runtime_owner_course_version_scope_missing");
    const noTime = assessMaterialCoursePackageReadiness(c, b, { ...allow, asOf: "invalid" });
    expect(noTime.planSubmission.blockers).toContain("trusted_host_assessment_time_missing_or_invalid");
    c.routeVersion = 1;
    const conflict = assessMaterialCoursePackageReadiness(c, b, allow);
    expect(conflict.questions[0]!.scoring.blockers).toContain("candidate_runtime_scope_conflict");
    expectNotExecutable(conflict);
    expect(absent.import.blockers).toEqual(["no_material_package_import_contract", "route_confirmation_is_not_package_import"]);
  });

  it.each(["asOf", "authority", "verifyBinding", "verifiedAt", "expiresAt", "authenticated", "MODULE_READY"])("client binding cannot supply host credential: %s", field => {
    const b = bindings(); Object.assign(b, { [field]: field === "asOf" ? asOf : true });
    expect(() => assessMaterialCoursePackageReadiness(fixture(), b, allow)).toThrow();
  });

  it.each(["feedback-role", "feedback-exposure", "feedback-scoring", "first-answer-body", "bridge-credit", "bridge-pass", "bridge-skip", "permanent-gate"])("closed privacy/mastery literals cannot be promoted: %s", kind => {
    const c = fixture();
    if (kind === "feedback-role") Object.assign(c.postAttemptMetadata, { role: "answer_key" });
    if (kind === "feedback-exposure") Object.assign(c.postAttemptMetadata, { independentIfExposedBeforeAnswer: true });
    if (kind === "feedback-scoring") Object.assign(c.postAttemptMetadata, { scoringEvidence: true });
    if (kind === "first-answer-body") Object.assign(c.safeFirstAnswerInput, { bodyStatus: "ready" });
    if (kind === "bridge-credit") Object.assign(c.prerequisiteGuidance.conceptBridges[0]!, { masteryCredit: true });
    if (kind === "bridge-pass") Object.assign(c.prerequisiteGuidance.conceptBridges[0]!, { requiredPass: true });
    if (kind === "bridge-skip") Object.assign(c.prerequisiteGuidance.conceptBridges[0]!, { skippable: false });
    if (kind === "permanent-gate") Object.assign(c.prerequisiteGuidance, { permanentPassGate: true });
    const verifyBinding = vi.fn(allow.verifyBinding);
    expect(() => assessMaterialCoursePackageReadiness(c, bindings(), { asOf, verifyBinding })).toThrow();
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it.each(["first-answer-notes", "first-answer-answer", "teaching-errors", "teaching-objectives", "scoring-parts", "diagnostic-outcome"])("no first-answer leak or manufactured per-skill evidence: %s", kind => {
    const c = fixture(), b = bindings();
    if (kind === "first-answer-notes") Object.assign(c.safeFirstAnswerInput.questions[0]!, { postAttemptNotes: "PRIVATE_SENTINEL" });
    if (kind === "first-answer-answer") Object.assign(c.safeFirstAnswerInput.questions[0]!, { answer: "PRIVATE_SENTINEL" });
    if (kind === "teaching-errors") Object.assign(c.teachingInput.items[0]!, { commonErrors: ["PRIVATE_SENTINEL"] });
    if (kind === "teaching-objectives") Object.assign(c.teachingInput.items[0]!, { learningObjectives: ["PRIVATE_SENTINEL"] });
    if (kind === "scoring-parts") Object.assign(b.questions[0]!.scoring, { partScores: [{ skillId: "synthetic-first", correct: true }] });
    if (kind === "diagnostic-outcome") Object.assign(b.questions[0]!.diagnostic, { outcome: "correct", independent: true });
    if (kind.startsWith("scoring") || kind.startsWith("diagnostic")) {
      const r = assessMaterialCoursePackageReadiness(c, b, allow);
      expect(kind.startsWith("scoring") ? r.questions[0]!.scoring.status : r.questions[0]!.diagnostic.status).toBe("not_ready");
      expect(r.questions.every(q => q.bkt.status === "not_ready")).toBe(true);
    } else expect(() => assessMaterialCoursePackageReadiness(c, b, allow)).toThrow();
  });

  it("report is metadata-only even with private feedback, prompts and valid synthetic receipts", () => {
    const c = fixture(), b = bindings();
    c.postAttemptMetadata.questions[0]!.postAttemptNotes = "PRIVATE_FEEDBACK_SENTINEL";
    c.postAttemptMetadata.skills[0]!.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"];
    c.postAttemptMetadata.skills[0]!.commonErrors = ["PRIVATE_ERROR_SENTINEL"];
    b.questions[0]!.diagnostic.problem.stemSnapshot = "PRIVATE_PROMPT_SENTINEL";
    b.questions[0]!.scoring.verification.evaluatorId = "PRIVATE_EVALUATOR_SENTINEL";
    const before = structuredClone({ c, b });
    const r = assessMaterialCoursePackageReadiness(c, b, allow), text = JSON.stringify(r);
    for (const secret of ["PRIVATE_FEEDBACK_SENTINEL", "PRIVATE_OBJECTIVE_SENTINEL", "PRIVATE_ERROR_SENTINEL", "PRIVATE_PROMPT_SENTINEL", "PRIVATE_EVALUATOR_SENTINEL", uuid(11), uuid(12)]) expect(text).not.toContain(secret);
    expect(r.questions[0]!.scoring.status).toBe("ready");
    expect(Object.values(r.permissions)).toEqual([false, false, false, false]);
    expect(r.questions.every(q => q.bkt.status === "not_ready")).toBe(true);
    expect({ c, b }).toEqual(before);
    expect(c.safeFirstAnswerInput).toEqual({ status: "proposed", bodyStatus: "missing",
      questions: c.questionMappings.map(q => ({ questionId: q.id, sourceRef: q.sourceRef })) });
  });

  it("rejected host verification stays closed, and host failures never become fallback success", () => {
    const verifyBinding = vi.fn<MaterialReadinessAuthority["verifyBinding"]>(() => false);
    expectNotExecutable(assessMaterialCoursePackageReadiness(fixture(), bindings(), { asOf, verifyBinding }));
    expect(verifyBinding).toHaveBeenCalledTimes(4);
    expect(() => assessMaterialCoursePackageReadiness(fixture(), bindings(), { asOf,
      verifyBinding: () => { throw new Error("host record unavailable"); } })).toThrow("host record unavailable");
    expectNotExecutable(assessMaterialCoursePackageReadiness(fixture(), bindings()));
  });

  const realInput = process.env.MATERIAL_COURSE_READINESS_REAL_INPUT;
  const frozenOutput = process.env.MATERIAL_COURSE_READINESS_FULL150_CANDIDATE;
  it.skipIf(!realInput || !frozenOutput)("real pinned 150: fresh adapter equals frozen output, all executable capabilities not ready", () => {
    const bytes = readFileSync(realInput!), frozen = readFileSync(frozenOutput!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
    expect(createHash("sha256").update(frozen).digest("hex")).toBe("20246b8f06e82b09cb2b4ece89e8a739a9b7780b2afc2843c8c4565a5669e056");
    for (const field of ["notes", "diagnosticEligible"]) {
      const polluted = JSON.parse(bytes.toString());
      Object.assign(polluted.questions[0], { [field]: field === "notes" ? "legacy feedback" : true });
      expect(() => adaptMaterialCourseFullPackage(polluted, { deadlineAt: null })).toThrow();
    }
    const c = adaptMaterialCourseFullPackage(JSON.parse(bytes.toString()), { deadlineAt: null });
    expect(c).toEqual(JSON.parse(frozen.toString())); const before = structuredClone(c);
    const r = assessMaterialCoursePackageReadiness(c); expectNotExecutable(r);
    expect(r.preview).toEqual({ status: "available", skills: 77, questions: 150, coverageExhaustive: false });
    expect(r.requirements.every(row => !row.routeCheck.valid && !row.planCheck.valid)).toBe(true);
    expect(r.questions.filter(q => q.diagnosticCandidate)).toHaveLength(c.diagnostic.eligibleEntryQuestionIds.length);
    expect(r.questions.filter(q => q.scoring.blockers.includes("visual_verification_required"))).toHaveLength(6);
    expect(r.questions.filter(q => q.scoring.blockers.includes("material_dispute_unresolved"))).toHaveLength(1);
    expect(r.questions.find(q => q.questionId === "T5-Q9")!.scoring.status).toBe("not_ready");
    const composites = r.questions.filter(q => q.mappedSkillIds.length > 1); expect(composites.length).toBeGreaterThan(0);
    expect(composites.every(q => q.bkt.blockers.includes("part_level_evidence_missing_no_multi_skill_credit"))).toBe(true);
    expect(c.schedule).toMatchObject({ actualExamDate: null, dailyStudyMinutes: null });
    expect(c.questionMappings.every(q => q.prompt === null && q.answer === null && q.canonicalFamilyId === null && !q.scoringEligible && !q.bktEligible)).toBe(true);
    expect(c).toEqual(before);
    // Real visual/dispute blockers remain even with complete synthetic schemas and a permissive resolver.
    for (const q of c.questionMappings.filter(q => q.unverifiedFormula || q.assessmentReadiness === "blocked-author-exclusion")) {
      const b = bindings(); b.questions[0]!.questionId = q.id; b.questions[0]!.diagnostic.problem.physicalPage = q.physicalPage;
      const blocked = assessMaterialCoursePackageReadiness(c, { scope, questions: b.questions }, allow).questions.find(row => row.questionId === q.id)!;
      expect(blocked.diagnostic.status).toBe("not_ready"); expect(blocked.scoring.status).toBe("not_ready");
    }
  });
});
