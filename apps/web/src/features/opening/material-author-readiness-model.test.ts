import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  adaptMaterialCourseFullPackage, type MaterialCourseFullPackage,
} from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import {
  assessMaterialCoursePackageReadiness, type MaterialReadinessAuthority,
} from "../../../../../packages/domain/src/opening/material-course-package-readiness";
import { createMaterialSourceLocator } from "../../../../../packages/domain/src/opening/material-source-locator";
import { readMaterialAuthorReadiness, type MaterialAuthorReadinessModel } from "./material-author-readiness-model";

// Entirely synthetic: no real author input, private JSON or independent test imports.
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const asOf = "2026-11-11T10:00:00Z";
const scope = { ownerUserId: uuid(1), courseId: uuid(2), routeVersion: 0, teachingVersion: 0 };
function fixture(): MaterialCourseFullPackage {
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64),
    questionIndexSha256: "b".repeat(64), mappingFiles: [],
    sources: [{ file: "synthetic.pdf", sha256: "c".repeat(64), physicalPages: 2 }],
    skills: ["first", "second"].map((id, i) => ({ id, title: id, topic: 1,
      prerequisiteIds: i ? ["first"] : [], learningObjectives: ["PRIVATE_OBJECTIVE"], commonErrors: ["PRIVATE_ERROR"],
      sourceRefs: [{ file: "synthetic.pdf", physicalPages: [1, 2], verification: "text-reviewed" }] })),
    prerequisiteOrder: ["first", "second"],
    questions: Array.from({ length: 150 }, (_, i) => ({ id: `q-${i}`, topic: 1, kind: "Test", number: i + 1,
      sourceFile: "synthetic.pdf", physicalPage: 1, primarySkillId: "first", secondarySkillIds: ["second"],
      evidenceType: "objective-choice", mappingStatus: "text-reviewed", postAttemptNotes: "PRIVATE_FEEDBACK",
      assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification" })),
    diagnostic: { status: "candidate-not-administered", source: "Synthetic", questionIds: Array.from({ length: 20 }, (_, i) => `q-${i}`),
      constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "No admission",
      requiredRuntimeChecks: [], constructedResponsePolicy: "No split credit", familyPolicy: "Not certified", feedbackPolicy: "Feedback only" },
    schedule: { productTarget: "Synthetic", latestProductUseDate: "Not an exam date", actualExamDate: null, dailyStudyMinutes: null,
      policy: "No guessed schedule", unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [] },
    coverageGaps: [], coverageGapNotes: [],
    validation: { sourcePdfs: 1, questionCount: 150, skillCount: 2, textMappedCount: 150, visualCheckRequired: [],
      disputedDiagnosticExclusions: [], semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
}
function bindings() {
  const identity = { protocolVersion: "question-identity-1", identityRefId: uuid(8), questionRef: {
    kind: "source_problem", problemId: uuid(9), sourceId: uuid(5), sourceVersion: 0 },
    sourceRefs: [{ sourceId: uuid(5), version: 0, page: 1 }], conditionRefs: [{ kind: "source", sourceId: uuid(5), version: 0, page: 1 }],
    figureRefs: [], answerRole: "answer_key" };
  const key = { keyRefId: uuid(11), identity, verification: { kind: "deterministic_evaluator", receiptId: uuid(12),
    evaluatorId: "PRIVATE_EVALUATOR", evaluatorVersion: "1" } };
  const diagnostic = { start: { goalId: uuid(10), expectedGoalRevision: 1, clientKey: "synthetic-start", minutes: 20,
    requirementId: uuid(3), expectedRequirementRevision: 1 },
    problem: { problemId: uuid(9), sourceId: uuid(5), sourceVersion: 0, physicalPage: 1, chunkId: null,
      stemSnapshot: "PRIVATE_PROMPT", artifactKind: "reference_item" }, key };
  const route = { expectedRevisions: [], confirmScope: true, requirements: ["first", "second"].map((skill, i) => ({
    id: uuid(3 + i), stableSkillId: uuid(13 + i), knowledgeNodeId: null, requirementKey: skill, title: skill, position: i,
    mandatory: true, goalIds: [], prerequisiteIds: i ? [uuid(3)] : [], sourceRefs: [{ sourceId: uuid(5), sourceVersion: 0, page: 1 }],
    verification: { kind: "manual", status: "needs_check", exerciseKeys: [], rubric: null, missingReasons: ["Synthetic"] }, origin: "confirmed",
  })) };
  const draft = { id: uuid(6), date: "2026-11-11", version: 0, baseVersion: 0, status: "draft", blocks: [], unscheduledTaskIds: [],
    suggestedTasks: [{ key: "synthetic-task", id: uuid(7), kind: "new_skill", title: "Synthetic", minutes: 20, courseId: scope.courseId,
      skillLabel: "Synthetic", requirementKey: "first", reasonCode: "new_skill", reason: "Synthetic" }] };
  return { scope: { ...scope }, route, plan: { draft, accept: { draftId: draft.id, expectedBaseVersion: 0, clientKey: "synthetic-accept" } },
    questions: [{ questionId: "q-0", diagnostic, scoring: structuredClone(key) }] };
}
const providedSources = () => [{ file: "synthetic.pdf", pdfSha256: "c".repeat(64), sourceId: uuid(5), sourceVersion: 0,
  pdfUrl: "https://synthetic.invalid/source.pdf?token=PRIVATE_URL" }];
// Synthetic exact-record oracle only; production authentication/host producer is NOT implemented.
function exactAuthority(): MaterialReadinessAuthority {
  const expected = bindings(), candidate = adaptMaterialCourseFullPackage(fixture(), { deadlineAt: null });
  return { asOf, verifyBinding: request => {
    const payload = request.purpose === "route_submission" ? expected.route : request.purpose === "plan_submission" ? expected.plan
      : request.purpose === "diagnostic_execution" ? expected.questions[0]!.diagnostic : expected.questions[0]!.scoring;
    return request.asOf === asOf && isDeepStrictEqual(request.candidate, candidate) && isDeepStrictEqual(request.scope, scope)
      && request.externalQuestionId === (request.purpose === "route_submission" || request.purpose === "plan_submission" ? null : "q-0")
      && isDeepStrictEqual(request.payload, payload);
  } };
}
function expectNeverAuthorized(model: MaterialAuthorReadinessModel) {
  expect(model).toMatchObject({ kind: "material_author_readiness_model", context: "private_author_review_only", moduleStatus: "MODULE_PENDING" });
  expect(model.layers.preview.runtimeReady).toBe(false);
  expect(model.layers.execution).toMatchObject({ status: "not_ready", runtimeReady: false, executedQuestions: 0 });
  expect(model.layers.execution.blockers).toEqual(expect.arrayContaining(["MODULE_PENDING", "host_producer_not_implemented", "execution_boundary_revalidation_required"]));
  expect(Object.values(model.permissions).every(value => value === false)).toBe(true);
  expect(model.layers.domain.import.status).toBe("not_ready");
  expect(model.layers.domain.questions.every(q => q.bkt.status === "not_ready")).toBe(true);
  expect(model.layers.execution.contractReadyQuestions.bkt).toBe(0);
  expect(model.sources.every(source => source.prompt === null && source.answer === null && source.canonicalFamilyId === null
    && !source.diagnosticEligible && !source.scoringEligible && !source.bktEligible)).toBe(true);
}
function expectClosed(model: MaterialAuthorReadinessModel) {
  expectNeverAuthorized(model);
  expect(model.layers.execution.contractReadyQuestions).toEqual({ diagnostic: 0, scoring: 0, bkt: 0 });
  expect(model.layers.domain.routeSubmission.status).toBe("not_ready");
  expect(model.layers.domain.planSubmission.status).toBe("not_ready");
}

describe("private author readiness host composition", () => {
  it("composes exact canonical adapter/readiness/locator from one RAW snapshot without I/O or writes", () => {
    const raw = fixture(), before = structuredClone(raw), fetch = vi.fn(() => { throw new Error("No fetch"); });
    vi.stubGlobal("fetch", fetch);
    try {
      const model = readMaterialAuthorReadiness(raw);
      const candidate = adaptMaterialCourseFullPackage(raw, { deadlineAt: null });
      expect(model.layers.domain).toEqual(assessMaterialCoursePackageReadiness(candidate));
      expect(model.layers.preview).toEqual({ status: "available", skills: 2, questions: 150, coverageExhaustive: false, runtimeReady: false });
      const locator = createMaterialSourceLocator(raw);
      expect(model.sources).toEqual([
        ...raw.questions.map(q => locator.resolve({ kind: "question", questionId: q.id })),
        ...raw.skills.map(s => locator.resolve({ kind: "skill", skillId: s.id })),
      ]);
      expect(model.layers.sources).toMatchObject({ status: "available", locations: 154, locatedLocations: 0, unboundLocations: 154 });
      expectClosed(model); expect(raw).toEqual(before); expect(fetch).not.toHaveBeenCalled();
      for (const secret of ["PRIVATE_FEEDBACK", "PRIVATE_OBJECTIVE", "PRIVATE_ERROR"]) expect(JSON.stringify(model)).not.toContain(secret);
    } finally { vi.unstubAllGlobals(); }
  });

  it("explicit PDF targets only locate sources; schema-valid bindings without a host verifier authorize nothing", () => {
    const options = { providedSources: providedSources(), bindings: bindings() }, before = structuredClone(options);
    const model = readMaterialAuthorReadiness(fixture(), options);
    expect(model.layers.sources).toMatchObject({ locations: 154, locatedLocations: 154, unboundLocations: 0 });
    expect(model.sources[0]!.locations[0]).toMatchObject({ status: "located", sourceId: uuid(5), sourceVersion: 0,
      target: { pdfUrl: options.providedSources[0]!.pdfUrl, fragment: "#page=1" } });
    expect(model.layers.sources.blockers).toEqual(["host_pdf_bytes_and_access_not_verified", "source_location_is_not_question_identity_or_family"]);
    expectClosed(model); expect(options).toEqual(before);
  });

  it("trusted DI only readies exact contract capabilities; even true is NOT authentication, first answer or execution", () => {
    const b = bindings(), before = structuredClone(b), verifyBinding = vi.fn(exactAuthority().verifyBinding);
    const model = readMaterialAuthorReadiness(fixture(), { bindings: b }, { asOf, verifyBinding });
    expect(model.layers.domain.routeSubmission.status).toBe("ready"); expect(model.layers.domain.planSubmission.status).toBe("ready");
    expect(model.layers.execution.contractReadyQuestions).toEqual({ diagnostic: 1, scoring: 1, bkt: 0 });
    expect(verifyBinding.mock.calls.map(([request]) => request.purpose)).toEqual(["route_submission", "plan_submission", "diagnostic_execution", "scoring"]);
    expectNeverAuthorized(model); expect(b).toEqual(before);
    for (const secret of ["PRIVATE_PROMPT", "PRIVATE_EVALUATOR", "PRIVATE_FEEDBACK", uuid(11), uuid(12)]) expect(JSON.stringify(model)).not.toContain(secret);
    expectClosed(readMaterialAuthorReadiness(fixture(), { bindings: b }));
  });

  it.each(["route_submission", "plan_submission", "diagnostic_execution", "scoring"])("does not reuse approval across purposes: %s", purpose => {
    const model = readMaterialAuthorReadiness(fixture(), { bindings: bindings() }, { asOf, verifyBinding: r => r.purpose === purpose });
    expect(model.layers.domain.routeSubmission.status === "ready").toBe(purpose === "route_submission");
    expect(model.layers.domain.planSubmission.status === "ready").toBe(purpose === "plan_submission");
    expect(model.layers.execution.contractReadyQuestions).toEqual({ diagnostic: Number(purpose === "diagnostic_execution"), scoring: Number(purpose === "scoring"), bkt: 0 });
    expectNeverAuthorized(model);
  });

  it.each(["input", "ownerUserId", "courseId", "routeVersion", "teachingVersion", "asOf", "questionId"])("no approval reuse across calls: %s", field => {
    const raw = fixture(), b = bindings(), authority = exactAuthority();
    expect(readMaterialAuthorReadiness(raw, { bindings: b }, authority).layers.execution.contractReadyQuestions.scoring).toBe(1);
    if (field === "input") raw.skills[0]!.commonErrors = ["Different private author input"];
    else if (field === "asOf") authority.asOf = "2026-11-11T10:00:01Z";
    else if (field === "questionId") b.questions[0]!.questionId = "q-1";
    else Object.assign(b.scope, { [field]: field.endsWith("Version") ? 1 : uuid(99) });
    const model = readMaterialAuthorReadiness(raw, { bindings: b }, authority);
    expect(model.layers.execution.contractReadyQuestions).toEqual({ diagnostic: 0, scoring: 0, bkt: 0 });
    if (field !== "questionId") expectClosed(model); else expectNeverAuthorized(model);
    expect(readMaterialAuthorReadiness(fixture(), { bindings: bindings() }, exactAuthority()).layers.execution.contractReadyQuestions.scoring).toBe(1);
  });

  it.each(["", "invalid", "2026-11-11", "2026-11-11T10:00:00", undefined])("invalid host time fails closed: %s", time => {
    const verifyBinding = vi.fn(() => true);
    expectClosed(readMaterialAuthorReadiness(fixture(), { bindings: bindings() }, { asOf: time as string, verifyBinding }));
    expect(verifyBinding).not.toHaveBeenCalled();
  });

  it.each([false, "true", 1, undefined])("non-literal callback truth cannot ready contracts: %s", value => {
    expectClosed(readMaterialAuthorReadiness(fixture(), { bindings: bindings() }, { asOf, verifyBinding: () => value as boolean }));
  });

  it("captures getters once for raw/options/authority; consumers never re-read live input", () => {
    const raw = fixture(), originalQuestions = raw.questions, b = bindings(), originalScope = b.scope;
    const questionsGetter = vi.fn(() => questionsGetter.mock.calls.length === 1 ? originalQuestions : []);
    Object.defineProperty(raw, "questions", { enumerable: true, get: questionsGetter });
    const scopeGetter = vi.fn(() => scopeGetter.mock.calls.length === 1 ? originalScope : { ...scope, routeVersion: 99 });
    Object.defineProperty(b, "scope", { enumerable: true, get: scopeGetter });
    const sourceGetter = vi.fn(providedSources), bindingsGetter = vi.fn(() => b);
    const timeGetter = vi.fn(() => timeGetter.mock.calls.length === 1 ? asOf : "invalid");
    const verifyBinding = vi.fn(exactAuthority().verifyBinding), verifierGetter = vi.fn(() => verifyBinding);
    const options = Object.defineProperties({}, { bindings: { enumerable: true, get: bindingsGetter }, providedSources: { enumerable: true, get: sourceGetter } });
    const authority = Object.defineProperties({}, { asOf: { get: timeGetter }, verifyBinding: { get: verifierGetter } }) as MaterialReadinessAuthority;
    const model = readMaterialAuthorReadiness(raw, options, authority);
    expect(model.layers.execution.contractReadyQuestions).toEqual({ diagnostic: 1, scoring: 1, bkt: 0 });
    expect(model.layers.sources.locatedLocations).toBe(154);
    for (const getter of [questionsGetter, scopeGetter, sourceGetter, bindingsGetter, timeGetter, verifierGetter]) expect(getter).toHaveBeenCalledTimes(1);
    expect(verifyBinding).toHaveBeenCalledTimes(4); expectNeverAuthorized(model);
  });

  it("callback mutation cannot change captured sources, later request scope/candidate/payload, time or verifier", () => {
    const raw = fixture(), b = bindings(), sources = providedSources(), oracle = exactAuthority(), requests: unknown[] = [];
    const authority: MaterialReadinessAuthority = { asOf, verifyBinding: request => {
      requests.push(structuredClone(request));
      const accepted = oracle.verifyBinding(request);
      request.scope.routeVersion = 99;
      request.candidate.questionMappings[0]!.physicalPage = 2;
      request.candidate.routeInput.requirements[0]!.title = "Changed private request";
      Reflect.set(request.payload, "injected", true);
      raw.questions[0]!.physicalPage = 2; raw.skills[0]!.id = "changed";
      b.scope.routeVersion = 99; b.questions[0]!.scoring.keyRefId = uuid(99);
      sources[0]!.pdfUrl = "https://synthetic.invalid/changed.pdf";
      authority.asOf = "invalid"; authority.verifyBinding = () => false;
      return accepted;
    } };
    const model = readMaterialAuthorReadiness(raw, { bindings: b, providedSources: sources }, authority);
    expect(requests).toHaveLength(4);
    expect(model.layers.domain.routeSubmission.status).toBe("ready"); expect(model.layers.domain.planSubmission.status).toBe("ready");
    expect(model.layers.execution.contractReadyQuestions).toEqual({ diagnostic: 1, scoring: 1, bkt: 0 });
    expect(model.sources[0]!.locations[0]).toMatchObject({ physicalPage: 1, target: { pdfUrl: providedSources()[0]!.pdfUrl } });
    expect(model.layers.domain.questions[0]!.mappedSkillIds).toEqual(["first", "second"]);
    expectNeverAuthorized(model);
  });

  it("return value mutation does not poison a later call; missing bindings reset all contract readiness", () => {
    const raw = fixture(), options = { bindings: bindings(), providedSources: providedSources() }, before = structuredClone({ raw, options });
    const first = readMaterialAuthorReadiness(raw, options, exactAuthority());
    first.layers.domain.questions[0]!.mappedSkillIds.push("injected");
    first.layers.execution.contractReadyQuestions.scoring = 99;
    const second = readMaterialAuthorReadiness(raw, options, exactAuthority());
    expect(second.layers.execution.contractReadyQuestions.scoring).toBe(1);
    expect(second.layers.domain.questions[0]!.mappedSkillIds).toEqual(["first", "second"]);
    expect({ raw, options }).toEqual(before); expectClosed(readMaterialAuthorReadiness(raw));
  });

  it.each([null, [], "invalid", {}, { kind: "material_course_package_readiness", preview: { status: "available" } }])("invalid/report input throws and never leaves previous state: %s", input => {
    expect(readMaterialAuthorReadiness(fixture(), { bindings: bindings() }, exactAuthority()).layers.execution.contractReadyQuestions.scoring).toBe(1);
    expect(() => readMaterialAuthorReadiness(input)).toThrow();
    expectClosed(readMaterialAuthorReadiness(fixture()));
  });

  it("rejects adapter candidates, caller reports and self-signed authority flags, even alongside complete bindings", () => {
    expect(() => readMaterialAuthorReadiness(adaptMaterialCourseFullPackage(fixture(), { deadlineAt: null }))).toThrow();
    for (const field of ["report", "candidate", "authority", "verified", "authenticated", "firstAnswerAuthorized", "MODULE_READY"]) {
      expect(() => readMaterialAuthorReadiness(fixture(), { bindings: bindings(), [field]: true }, exactAuthority())).toThrow();
      expect(() => readMaterialAuthorReadiness({ ...fixture(), [field]: true })).toThrow();
      expect(() => readMaterialAuthorReadiness(fixture(), { bindings: { ...bindings(), [field]: true } }, exactAuthority())).toThrow();
    }
  });

  it.each(["basename", "url", "hash", "page", "unknown-source", "legacy-notes"])("raw locator boundary is not repaired/trimmed before validation: %s", kind => {
    const raw = fixture(), sources = providedSources();
    if (kind === "basename") {
      raw.sources[0]!.file = " synthetic.pdf "; raw.questions.forEach(q => { q.sourceFile = " synthetic.pdf "; });
      raw.skills.forEach(s => s.sourceRefs.forEach(ref => { ref.file = " synthetic.pdf "; }));
    }
    if (kind === "url") sources[0]!.pdfUrl = " https://synthetic.invalid/source.pdf";
    if (kind === "hash") sources[0]!.pdfSha256 = "d".repeat(64);
    if (kind === "page") raw.questions[0]!.physicalPage = 3;
    if (kind === "unknown-source") sources[0]!.file = "unknown.pdf";
    if (kind === "legacy-notes") Object.assign(raw.questions[0]!, { notes: "legacy private feedback" });
    const verifyBinding = vi.fn(() => true);
    expect(() => readMaterialAuthorReadiness(raw, { providedSources: sources, bindings: bindings() }, { asOf, verifyBinding })).toThrow();
    expect(verifyBinding).not.toHaveBeenCalled(); expectClosed(readMaterialAuthorReadiness(fixture()));
  });

  it("host/getter failures propagate; no fallback authorization or retained successful model", () => {
    expect(() => readMaterialAuthorReadiness(fixture(), { bindings: bindings() }, { asOf, verifyBinding: () => { throw new Error("host unavailable"); } })).toThrow("host unavailable");
    const raw = Object.defineProperty(fixture(), "questions", { get: () => { throw new Error("getter unavailable"); } });
    expect(() => readMaterialAuthorReadiness(raw)).toThrow("getter unavailable");
    expectClosed(readMaterialAuthorReadiness(fixture()));
  });
});

// Explicit opt-in only; normal unit runs require no private file or environment.
const realInput = process.env.MATERIAL_AUTHOR_READINESS_REAL_INPUT;
it.skipIf(!realInput)("explicit pinned real 150/77 replay: preview385 locations, zero diagnostic/scoring/BKT, MODULE_PENDING", () => {
  const bytes = readFileSync(realInput!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  const raw: unknown = JSON.parse(bytes.toString()), before = structuredClone(raw);
  const model = readMaterialAuthorReadiness(raw);
  expect(model.layers.preview).toEqual({ status: "available", skills: 77, questions: 150, coverageExhaustive: false, runtimeReady: false });
  expect(model.sources).toHaveLength(227);
  expect(model.layers.sources).toMatchObject({ status: "available", locations: 385, locatedLocations: 0, unboundLocations: 385 });
  expect(model.layers.domain.requirements).toHaveLength(77);
  expect(model.layers.domain.requirements.every(r => !r.routeCheck.valid && !r.planCheck.valid)).toBe(true);
  expect(model.layers.domain.questions.filter(q => q.scoring.blockers.includes("visual_verification_required"))).toHaveLength(6);
  expect(model.layers.domain.questions.filter(q => q.scoring.blockers.includes("material_dispute_unresolved"))).toHaveLength(1);
  expectClosed(model); expect(raw).toEqual(before);
});
