import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { courseRouteRequirementInputSchema } from "@aistudy/contracts";
import {
  adaptMaterialCoursePackage, materialCoursePackageSchema, adaptMaterialCourseMappingPackage,
  MIDTERM_PENDING_PREREQUISITE_IDS, adaptMaterialCourseFullPackage, type MaterialCourseFullPackage, type MaterialCourseMappingPackage,
  type MaterialCoursePackage, type MaterialCoursePackageOptions,
} from "./material-course-package-adapter";

/** Synthetic adapter-unit-fixture only. NOT a transcription of user course/PDF content. */
function syntheticFixture(): MaterialCoursePackage {
  return {
    schemaVersion: 1, packageId: "synthetic-adapter-unit-fixture", packageVersion: "test-1",
    title: "Synthetic adapter format test — not user material", provenance: "synthetic_adapter_unit_fixture",
    sources: [{ sourceKey: "fixture-pdf", title: "Synthetic PDF metadata (no actual PDF)", pdfSha256: "a".repeat(64), pageCount: 4, sourceId: null, sourceVersion: null }],
    topics: [{ topicId: "fixture-topic", title: "Synthetic topic" }],
    skills: [
      { skillId: "fixture-basic", topicId: "fixture-topic", title: "Synthetic basic skill", mandatory: true, prerequisiteSkillIds: [],
        sourceRefs: [{ sourceKey: "fixture-pdf", page: 1 }], diagnosticQuestionIds: ["fixture-question"] },
      { skillId: "fixture-advanced", topicId: "fixture-topic", title: "Synthetic advanced skill", mandatory: true, prerequisiteSkillIds: ["fixture-basic"],
        sourceRefs: [{ sourceKey: "fixture-pdf", page: 2 }], diagnosticQuestionIds: [] },
    ],
    questions: [
      { questionId: "fixture-question", topicId: "fixture-topic", skillIds: ["fixture-basic"], contentKind: "question",
        prompt: { role: "prompt", text: "Synthetic question text", sourceRefs: [{ sourceKey: "fixture-pdf", page: 1 }], unverifiedFormula: true },
        answer: { role: "answer_key", text: "PRIVATE SYNTHETIC REFERENCE", sourceRefs: [{ sourceKey: "fixture-pdf", page: 3 }], unverifiedFormula: true } },
      { questionId: "fixture-description", topicId: "fixture-topic", skillIds: ["fixture-advanced"], contentKind: "description",
        prompt: { role: "prompt", text: "Synthetic description, not an executable exercise", sourceRefs: [{ sourceKey: "fixture-pdf", page: 2 }], unverifiedFormula: false }, answer: null },
    ],
  };
}
const unknownDeadline = { deadlineAt: null };

/** Synthetic mapping-shape fixture, not user course content. */
function syntheticMappingFixture(): MaterialCourseMappingPackage {
  return {
    schemaVersion: 1, topics: [4],
    skills: [{ id: "fixture-basic", title: "Synthetic skill", topic: 4, prerequisiteIds: ["t3-derivatives"], learningObjectives: ["Synthetic objective"], commonErrors: [],
      sourceRefs: [{ file: "synthetic.pdf", physicalPages: [1], verification: "text-reviewed" }] }],
    questions: [{ id: "fixture-q", topic: 4, kind: "Test", number: 1, sourceFile: "synthetic.pdf", physicalPage: 1,
      primarySkillId: "fixture-basic", secondarySkillIds: [], evidenceType: "objective-choice", mappingStatus: "text-reviewed", diagnosticEligible: true, notes: "Synthetic mapping note, not prompt text" }],
    verificationScope: "Synthetic unit mapping, no math certification", sourceResolution: "Synthetic basename", coverageGaps: [],
  };
}
const partialMappingOptions = { deadlineAt: null, validationScope: "partial" as const };

function syntheticFullFixture(): MaterialCourseFullPackage {
  const part = syntheticMappingFixture();
  const { notes, diagnosticEligible: _legacyEligibility, ...question } = part.questions[0]!;
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64), questionIndexSha256: "b".repeat(64), mappingFiles: [],
    sources: [{ file: "synthetic.pdf", sha256: "c".repeat(64), physicalPages: 1 }],
    skills: [{ ...part.skills[0]!, prerequisiteIds: [], sourceRefs: [{ file: "synthetic.pdf", physicalPages: [1], verification: "text-reviewed" }] }],
    prerequisiteOrder: ["fixture-basic"],
    questions: Array.from({ length: 150 }, (_, i) => ({ ...question, postAttemptNotes: notes, id: `fixture-q-${i}`, kind: "Test", evidenceType: "objective-choice", mappingStatus: "text-reviewed",
      assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification" })),
    diagnostic: { status: "candidate-not-administered", source: "Synthetic 20-item entry", questionIds: Array.from({ length: 20 }, (_, i) => `fixture-q-${i}`), constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "Synthetic no admission", requiredRuntimeChecks: [], constructedResponsePolicy: "No duplicated subskill verdict", familyPolicy: "Not canonical family", feedbackPolicy: "Feedback only after answer" },
    schedule: { productTarget: "Synthetic product deadline", latestProductUseDate: "Synthetic target", actualExamDate: null, dailyStudyMinutes: null, policy: "No inferred exam date", unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [] },
    coverageGaps: [], coverageGapNotes: ["Machine gaps not exhaustive"],
    validation: { sourcePdfs: 1, questionCount: 150, skillCount: 1, textMappedCount: 150, visualCheckRequired: [], disputedDiagnosticExclusions: [], semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
}

describe("complete real-package structure", () => {
  it("retains a 20-item entry, no body/family binding, and no automatic BKT or diagnosis", () => {
    const result = adaptMaterialCourseFullPackage(syntheticFullFixture(), unknownDeadline);
    expect(result.diagnostic.questionIds).toHaveLength(20);
    expect(result.diagnostic.eligibleEntryQuestionIds).toHaveLength(20);
    expect(result.planInput.items[0]!.diagnosticQuestionIds).toHaveLength(20);
    expect(result.schedule).toMatchObject({ actualExamDate: null, dailyStudyMinutes: null });
    expect(result.deadlineAt).toBeNull();
    expect(result.questionMappings.every(q => !q.scoringEligible && !q.bktEligible && q.canonicalFamilyId === null)).toBe(true);
  });

  it("blocks author readiness exclusions without a legacy eligibility override", () => {
    const pack = syntheticFullFixture();
    pack.questions[0]!.assessmentReadiness = "blocked-author-exclusion";
    pack.validation.disputedDiagnosticExclusions = ["fixture-q-0"];
    const result = adaptMaterialCourseFullPackage(pack, unknownDeadline);
    expect(result.diagnostic.blockedEntryQuestionIds).toEqual(["fixture-q-0"]);
    expect(result.planInput.items[0]!.diagnosticQuestionIds).not.toContain("fixture-q-0");
  });

  it.each(["notes", "diagnosticEligible", "postsAttemptNotes", "unknownExtra"])("rejects legacy/unknown full-question field %s", field => {
    const pack = syntheticFullFixture();
    const question = { ...pack.questions[0]!, [field]: field === "diagnosticEligible" ? false : "not current schema" };
    expect(() => adaptMaterialCourseFullPackage({ ...pack, questions: [question, ...pack.questions.slice(1)] }, unknownDeadline)).toThrow();
  });

  it.each(["assessmentReadiness", "bktAdmission"] as const)("honors explicit false %s", field => {
    const pack = syntheticFullFixture(); pack.questions[0]![field] = false;
    const result = adaptMaterialCourseFullPackage(pack, unknownDeadline);
    expect(result.diagnostic.blockedEntryQuestionIds).toEqual(["fixture-q-0"]);
    expect(result.questionMappings[0]!.diagnosticEligible).toBe(false);
  });

  it("isolates feedback-only notes/objectives/errors from safe first-answer input and teaching candidate blocks", () => {
    const pack = syntheticFullFixture();
    pack.questions[0]!.postAttemptNotes = "PRIVATE_FEEDBACK_SENTINEL";
    pack.skills[0]!.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"];
    pack.skills[0]!.commonErrors = ["PRIVATE_ERROR_SENTINEL"];
    pack.skills[0]!.title = "PRIVATE_SKILL_TITLE_SENTINEL";
    const result = adaptMaterialCourseFullPackage(pack, unknownDeadline);
    expect(result.postAttemptMetadata).toMatchObject({ role: "feedback_only", independentIfExposedBeforeAnswer: false, scoringEvidence: false });
    expect(result.postAttemptMetadata.questions[0]).toEqual({ questionId: "fixture-q-0", postAttemptNotes: "PRIVATE_FEEDBACK_SENTINEL" });
    const firstAnswer = JSON.stringify(result.safeFirstAnswerInput);
    for (const secret of ["PRIVATE_FEEDBACK_SENTINEL", "PRIVATE_OBJECTIVE_SENTINEL", "PRIVATE_ERROR_SENTINEL", "PRIVATE_SKILL_TITLE_SENTINEL"]) expect(firstAnswer).not.toContain(secret);
    expect(JSON.stringify(result.questionMappings)).not.toContain("PRIVATE_FEEDBACK_SENTINEL");
    expect(JSON.stringify(result.teachingInput)).not.toContain("PRIVATE_OBJECTIVE_SENTINEL");
    expect(JSON.stringify(result.teachingInput)).not.toContain("PRIVATE_ERROR_SENTINEL");
    expect(result.safeFirstAnswerInput.questions[0]).not.toHaveProperty("answer");
    expect(result.safeFirstAnswerInput.questions[0]).not.toHaveProperty("skillId");
    expect(result.learnerPrompts).toEqual([]);
    expect(result.privateAnswerKeys).toEqual([]);
  });

  it.each(["assessmentReadiness", "bktAdmission"] as const)("excludes explicit false %s from BOTH main and supplemental paths", field => {
    const pack = syntheticFullFixture();
    pack.diagnostic.constructedResponseCandidates = ["fixture-q-20", "fixture-q-21", "fixture-q-22", "fixture-q-23", "fixture-q-24"];
    pack.questions[0]![field] = false; pack.questions[20]![field] = false;
    const result = adaptMaterialCourseFullPackage(pack, unknownDeadline);
    expect(result.diagnostic.blockedEntryQuestionIds).toEqual(["fixture-q-0"]);
    expect(result.diagnostic.blockedConstructedResponseCandidates).toEqual(["fixture-q-20"]);
    expect(result.diagnostic.eligibleEntryQuestionIds).not.toContain("fixture-q-0");
    expect(result.diagnostic.constructedResponseCandidates).not.toContain("fixture-q-20");
    expect(result.questionMappings[20]!.supplementalDiagnosticCandidate).toBe(false);
  });

  it.each(["visual", "author"])("blocks %s exclusions in BOTH diagnostic paths", reason => {
    const pack = syntheticFullFixture();
    pack.diagnostic.constructedResponseCandidates = ["fixture-q-20"];
    for (const i of [0, 20]) {
      if (reason === "visual") { pack.questions[i]!.mappingStatus = "needs-visual-check"; pack.questions[i]!.assessmentReadiness = "blocked-visual-check"; }
      else pack.questions[i]!.assessmentReadiness = "blocked-author-exclusion";
    }
    if (reason === "visual") { pack.validation.visualCheckRequired = ["fixture-q-0", "fixture-q-20"]; pack.validation.textMappedCount = 148; }
    else pack.validation.disputedDiagnosticExclusions = ["fixture-q-0", "fixture-q-20"];
    const result = adaptMaterialCourseFullPackage(pack, unknownDeadline);
    expect(result.diagnostic.blockedEntryQuestionIds).toEqual(["fixture-q-0"]);
    expect(result.diagnostic.blockedConstructedResponseCandidates).toEqual(["fixture-q-20"]);
    expect(result.questionMappings[20]!.bktEligible).toBe(false);
  });

  it.each(["order", "source", "diagnostic", "diagnostic-count", "counts", "page"])("rejects invalid full-package %s", mode => {
    const pack = syntheticFullFixture();
    if (mode === "order") pack.prerequisiteOrder = [];
    if (mode === "source") pack.questions[0]!.sourceFile = "not-in-manifest.pdf";
    if (mode === "diagnostic") pack.diagnostic.questionIds[0] = "unknown";
    if (mode === "diagnostic-count") pack.diagnostic.questionIds.push(...pack.questions.slice(20, 25).map(q => q.id));
    if (mode === "counts") pack.validation.questionCount = 149;
    if (mode === "page") pack.questions[0]!.physicalPage = 2;
    expect(() => adaptMaterialCourseFullPackage(pack, unknownDeadline)).toThrow();
  });

  const fullPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
  it.skipIf(!fullPath)("replays the PM-delivered real 77-skill/150-question full package", () => {
    const bytes = readFileSync(fullPath!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
    const input: unknown = JSON.parse(bytes.toString("utf8"));
    const result = adaptMaterialCourseFullPackage(input, unknownDeadline);
    expect(result.routeInput.requirements).toHaveLength(77);
    expect(result.questionMappings).toHaveLength(150);
    expect(result.sources).toHaveLength(15);
    expect(result.pendingExternalPrerequisites).toEqual([]);
    expect(result.missingPdfHashes).toEqual([]);
    expect(result.diagnostic.questionIds).toHaveLength(20);
    expect(result.diagnostic.eligibleEntryQuestionIds).toHaveLength(20);
    expect(result.diagnostic.constructedResponseCandidates).toHaveLength(5);
    expect(result.questionMappings.filter(q => q.unverifiedFormula).map(q => q.id).sort()).toEqual(["T1-P3", "T1-Q2", "T1-Q6", "T4-Q13", "T5-Q16", "T5-Q18"].sort());
    expect(result.questionMappings.find(q => q.id === "T5-Q9")).toMatchObject({ diagnosticEligible: false, bktEligible: false, assessmentReadiness: "blocked-author-exclusion" });
    expect(result.questionMappings.every(q => !q.scoringEligible && !q.bktEligible && q.canonicalFamilyId === null && q.prompt === null && q.answer === null)).toBe(true);
    expect(result.schedule).toMatchObject({ actualExamDate: null, dailyStudyMinutes: null });
    expect(result).toMatchObject({ published: false, status: "proposed", ownerUserId: null, courseId: null, routeVersion: null, teachingVersion: null, deadlineAt: null, coverageExhaustive: false });
    expect(result.coverageGaps).toHaveLength(4);
    expect(result.coverageGapNotes.length).toBeGreaterThan(0);
    expect(result.coverage.every(row => row.measurementStatus === "untested")).toBe(true);
    const taylor = result.questionMappings.find(q => q.id === "T3-Q17")!;
    expect(taylor.primarySkillId).toBe("t3-taylor");
    expect(taylor.secondarySkillIds).not.toContain("t3-taylor-error");
    expect(result.coverage.find(row => row.skillId === "t3-taylor-error")!.questionIds).not.toContain("T3-Q17");
    expect(result.questionMappings.find(q => q.id === "T5-P10")!.secondarySkillIds).toEqual(["t1-algebra-functions"]);
    expect(result.routeInput.requirements.find(row => row.externalSkillId === "t4-fundamental-theorem")!.prerequisiteSkillIds).toEqual(["t4-antiderivatives", "t2-continuity", "t3-derivatives"]);
    expect(result.routeInput.requirements.find(row => row.externalSkillId === "t4-definite-integrals")!.prerequisiteSkillIds).toContain("t4-fundamental-theorem");
    const power = result.routeInput.requirements.find(row => row.externalSkillId === "t5-power-operations")!;
    expect(power.prerequisiteSkillIds).toEqual(["t5-power-radius", "t3-taylor"]);
    expect(power.prerequisiteSkillIds).not.toContain("t5-termwise-operations");
    expect(result.prerequisiteGuidance).toMatchObject({ masteryCredit: false, permanentPassGate: false, learnerMeasurement: "not_supplied" });
    expect(result.prerequisiteGuidance.conceptBridges.some(b => b.targetSkillId === "t4-fundamental-theorem" && b.prerequisiteSkillId === "t4-antiderivatives" && b.reason === "declared_measurement_gap")).toBe(true);
    expect(result.prerequisiteGuidance.conceptBridges.every(b => b.skippable && !b.requiredPass && !b.masteryCredit && b.measurementStatus === "untested")).toBe(true);
  });

  it("turns untested prerequisites into optional bridges, never learner mastery gates", () => {
    const pack = syntheticFullFixture();
    pack.skills.push({ ...pack.skills[0]!, id: "fixture-next", prerequisiteIds: ["fixture-basic"] });
    pack.prerequisiteOrder.push("fixture-next"); pack.validation.skillCount = 2;
    pack.schedule.unmeasuredSkillIds = ["fixture-basic"];
    const result = adaptMaterialCourseFullPackage(pack, unknownDeadline);
    expect(result.prerequisiteGuidance.conceptBridges).toEqual([{ targetSkillId: "fixture-next", prerequisiteSkillId: "fixture-basic", action: "concept_bridge",
      reason: "declared_measurement_gap", measurementStatus: "untested", skippable: true, requiredPass: false, masteryCredit: false }]);
    expect(result.routeInput.requirements[1]!.prerequisitePolicy).toBe("concept_bridge_without_mastery_gate");
    expect(result.coverage.every(row => row.measurementStatus === "untested")).toBe(true);
  });

  it.each(["unknown", "duplicate"])("rejects %s unmeasured skill references rather than inferring a bridge identity", mode => {
    const pack = syntheticFullFixture(); pack.schedule.unmeasuredSkillIds = mode === "unknown" ? ["unknown"] : ["fixture-basic", "fixture-basic"];
    expect(() => adaptMaterialCourseFullPackage(pack, unknownDeadline)).toThrow();
  });
});

describe("actual author mapping structure", () => {
  it("accepts declared external prerequisites in a partial package without inventing bodies, hashes or certification", () => {
    const pack = syntheticMappingFixture(); pack.questions[0]!.secondarySkillIds.push("t3-derivatives");
    const candidate = adaptMaterialCourseMappingPackage(pack, partialMappingOptions);
    expect(candidate.questionMappings[0]!.externalSkillRefs).toEqual([{ skillId: "t3-derivatives", status: "pending" }]);
    expect(candidate).toMatchObject({ status: "proposed", published: false, coverageStatus: "partial", ownerUserId: null, courseId: null, routeVersion: null, teachingVersion: null });
    expect(candidate.pendingExternalPrerequisites).toEqual([{ skillId: "t3-derivatives", status: "pending" }]);
    expect(candidate.missingPdfHashes).toEqual(["synthetic.pdf"]);
    expect(candidate.questionMappings[0]).toMatchObject({ prompt: null, answer: null, sourceRef: { pdfSha256: null, sourceId: null }, mathematicalVerification: "unverified", scoringEligible: false, independentEligibility: "unknown" });
    expect(candidate.learnerPrompts).toEqual([]);
    expect(candidate.privateAnswerKeys).toEqual([]);
    expect(candidate.coverage[0]!.measurementStatus).toBe("untested");
  });

  it("excludes visual/formula uncertainty and author-disputed mappings from diagnostics", () => {
    const pack = syntheticMappingFixture();
    pack.questions.push({ ...pack.questions[0]!, id: "fixture-visual", mappingStatus: "needs-visual-check" });
    pack.questions.push({ ...pack.questions[0]!, id: "fixture-disputed", diagnosticEligible: false });
    const result = adaptMaterialCourseMappingPackage(pack, partialMappingOptions);
    expect(result.coverage[0]!.diagnosticQuestionIds).toEqual(["fixture-q"]);
    expect(result.questionMappings.map(q => q.diagnosticEligible)).toEqual([true, false, false]);
    expect(result.questionMappings.every(q => q.scoringEligible === false)).toBe(true);
    expect(result.questionMappings[1]!.unverifiedFormula).toBe(true);
  });

  it("rejects unknown prerequisites and enforces resolution/count in complete mode", () => {
    const pack = syntheticMappingFixture();
    expect(() => adaptMaterialCourseMappingPackage(pack, { ...partialMappingOptions, validationScope: "complete", expectedQuestionCount: 150 })).toThrow("Unresolved prerequisite");
    pack.skills[0]!.prerequisiteIds = ["not-a-declared-external-skill"];
    expect(() => adaptMaterialCourseMappingPackage(pack, partialMappingOptions)).toThrow("Unresolved prerequisite");
    pack.skills[0]!.prerequisiteIds = [];
    expect(() => adaptMaterialCourseMappingPackage(pack, { ...partialMappingOptions, validationScope: "complete", expectedQuestionCount: 150 })).toThrow("Incomplete question count");
  });

  it("uses provided PDF manifest only, validating page bounds without inventing database identities", () => {
    const options = { ...partialMappingOptions, sourceManifest: [{ file: "synthetic.pdf", pdfSha256: "c".repeat(64), pageCount: 1, sourceId: null, sourceVersion: null }] };
    expect(adaptMaterialCourseMappingPackage(syntheticMappingFixture(), options).questionMappings[0]!.sourceRef).toEqual({ file: "synthetic.pdf", page: 1, pdfSha256: "c".repeat(64), sourceId: null, sourceVersion: null });
    const pack = syntheticMappingFixture(); pack.questions[0]!.physicalPage = 2;
    expect(() => adaptMaterialCourseMappingPackage(pack, options)).toThrow("Page outside PDF");
  });

  // Compatibility-only synthetic partial test. Historical real parts are no longer current inputs.
  const realPath = "synthetic-partial-compatibility";
  it.skipIf(!realPath)("retains explicit legacy partial compatibility without reading superseded real input", () => {
    const pack = syntheticMappingFixture();
    const actual = { ...pack, skills: [...pack.skills, { ...pack.skills[0]!, id: "fixture-second", prerequisiteIds: ["fixture-basic"] }] };
    const result = adaptMaterialCourseMappingPackage(actual, partialMappingOptions);
    expect(result.routeInput.requirements).toHaveLength(2);
    expect(result.questionMappings).toHaveLength(1);
    expect(result.pendingExternalPrerequisites.map(ref => ref.skillId)).toEqual([MIDTERM_PENDING_PREREQUISITE_IDS[4]]);
    expect(result.questionMappings.every(q => q.mathematicalVerification === "unverified" && !q.scoringEligible && q.prompt === null && q.answer === null)).toBe(true);
    expect(result.coverage.every(row => row.measurementStatus === "untested" && row.independentEligibility === "unknown")).toBe(true);
    expect(result).toMatchObject({ published: false, coverageStatus: "partial", deadlineAt: null, ownerUserId: null, courseId: null, routeVersion: null, teachingVersion: null });
    expect(() => adaptMaterialCourseMappingPackage(actual, { ...partialMappingOptions, validationScope: "complete", expectedQuestionCount: 150 })).toThrow();
  });
});

describe("offline material course package adapter (synthetic unit fixtures only)", () => {
  it("produces traceable candidate route, teaching and plan inputs without fabricating DB identities", () => {
    const pack = syntheticFixture();
    const before = structuredClone(pack);
    const candidate = adaptMaterialCoursePackage(pack, unknownDeadline);
    expect(pack).toEqual(before);
    expect(candidate).toMatchObject({ kind: "material_course_package_candidate", status: "proposed", provenance: "synthetic_adapter_unit_fixture",
      ownerUserId: null, courseId: null, routeVersion: null, teachingVersion: null, deadlineAt: null, factualSupport: "unverified" });
    expect(candidate.routeInput.requirements).toHaveLength(2);
    expect(candidate.routeInput.requirements[0]).toMatchObject({ id: null, stableSkillId: null, knowledgeNodeId: null, prerequisiteIds: null,
      externalSkillId: "fixture-basic", sourceRefs: expect.arrayContaining([{ sourceKey: "fixture-pdf", pdfSha256: "a".repeat(64), page: 1, sourceId: null, sourceVersion: null }]) });
    expect(candidate.routeInput.requirements[1]!.prerequisiteSkillIds).toEqual(["fixture-basic"]);
    // A proposal must not masquerade as an executable/confirmable database route.
    expect(courseRouteRequirementInputSchema.safeParse(candidate.routeInput.requirements[0]).success).toBe(false);
    expect(candidate.teachingInput.items[1]).toMatchObject({ itemId: "fixture-advanced", prereqItemIds: ["fixture-basic"], goalIds: [], sourceIds: [] });
    expect(candidate.planInput.items.every(item => item.id === null && item.minutes === null && item.deadlineAt === null)).toBe(true);
  });

  it("keeps answer-role text out of learner prompts and outline/plan/route while retaining provenance", () => {
    const candidate = adaptMaterialCoursePackage(syntheticFixture(), unknownDeadline);
    expect(candidate.learnerPrompts[0]).toMatchObject({ questionId: "fixture-question", role: "prompt", sourceRefs: [{ page: 1 }], unverifiedFormula: true });
    expect(candidate.privateAnswerKeys[0]).toMatchObject({ questionId: "fixture-question", role: "answer_key", text: "PRIVATE SYNTHETIC REFERENCE", sourceRefs: [{ page: 3 }] });
    expect(candidate.routeInput.requirements[0]!.sourceRefs.map(ref => ref.page)).toEqual([1, 3]);
    expect(JSON.stringify([candidate.learnerPrompts, candidate.routeInput, candidate.teachingInput, candidate.planInput])).not.toContain("PRIVATE SYNTHETIC REFERENCE");
  });

  it("preserves the full skill denominator and never promotes descriptions, references or formula flags to verified evidence", () => {
    const candidate = adaptMaterialCoursePackage(syntheticFixture(), unknownDeadline);
    expect(candidate.coverage).toEqual([
      { skillId: "fixture-basic", questionIds: ["fixture-question"], diagnosticQuestionIds: ["fixture-question"], withReferenceAnswers: 1,
        unverifiedFormulaQuestionIds: ["fixture-question"], measurementStatus: "untested", independentEligibility: "unknown" },
      { skillId: "fixture-advanced", questionIds: [], diagnosticQuestionIds: [], withReferenceAnswers: 0,
        unverifiedFormulaQuestionIds: [], measurementStatus: "untested", independentEligibility: "unknown" },
    ]);
    expect(candidate.routeInput.requirements[0]!.verification).toMatchObject({ kind: "unavailable", status: "needs_check", missingReasons: expect.arrayContaining(["unverified_formula", "unbound_source"]) });
    expect(candidate.routeInput.requirements[1]!.verification).toMatchObject({ exerciseKeys: [], missingReasons: expect.arrayContaining(["no_actual_question", "no_diagnostic_question"]) });
    expect(candidate).not.toHaveProperty("attempts");
    expect(candidate).not.toHaveProperty("sourceRecords");
    expect(candidate).not.toHaveProperty("publishReceipt");
  });

  it("does not infer verification even when all formula flags are clear and source bindings are supplied", () => {
    const pack = syntheticFixture();
    pack.sources[0]!.sourceId = "10000000-0000-4000-8000-000000000001";
    pack.sources[0]!.sourceVersion = 0;
    pack.questions[0]!.prompt.unverifiedFormula = false;
    pack.questions[0]!.answer!.unverifiedFormula = false;
    const candidate = adaptMaterialCoursePackage(pack, { deadlineAt: "2030-01-02T12:00:00+08:00", ownerUserId: "10000000-0000-4000-8000-000000000002",
      courseId: "10000000-0000-4000-8000-000000000003", routeVersion: 0, teachingVersion: 2 });
    expect(candidate).toMatchObject({ routeVersion: 0, teachingVersion: 2, deadlineAt: "2030-01-02T12:00:00+08:00" });
    expect(candidate.planInput.items[0]!.deadlineAt).toBe("2030-01-02T12:00:00+08:00");
    expect(candidate.teachingInput.items[0]!.sourceIds).toEqual([pack.sources[0]!.sourceId]);
    expect(candidate.routeInput.requirements[0]!.sourceRefs[0]).toMatchObject({ sourceId: pack.sources[0]!.sourceId, sourceVersion: 0 });
    expect(candidate.routeInput.requirements.every(r => r.verification.status === "needs_check")).toBe(true);
    expect(candidate.coverage.every(row => row.measurementStatus === "untested" && row.independentEligibility === "unknown")).toBe(true);
  });

  it("retains all PDFs/pages for a multi-skill question and flags an unbound answer source", () => {
    const pack = syntheticFixture();
    pack.sources[0]!.sourceId = "10000000-0000-4000-8000-000000000001";
    pack.sources[0]!.sourceVersion = 1;
    pack.sources.push({ sourceKey: "synthetic-answer-pdf", title: "Synthetic answer PDF", pdfSha256: "b".repeat(64), pageCount: 2, sourceId: null, sourceVersion: null });
    pack.questions[0]!.answer!.sourceRefs = [{ sourceKey: "synthetic-answer-pdf", page: 2 }];
    pack.questions[0]!.skillIds.push("fixture-advanced");
    const candidate = adaptMaterialCoursePackage(pack, unknownDeadline);
    expect(candidate.coverage.map(row => row.questionIds)).toEqual([["fixture-question"], ["fixture-question"]]);
    expect(candidate.routeInput.requirements.every(row => row.verification.missingReasons.includes("unbound_source"))).toBe(true);
    expect(candidate.routeInput.requirements[0]!.sourceRefs).toEqual([
      { sourceKey: "fixture-pdf", pdfSha256: "a".repeat(64), page: 1, sourceId: pack.sources[0]!.sourceId, sourceVersion: 1 },
      { sourceKey: "synthetic-answer-pdf", pdfSha256: "b".repeat(64), page: 2, sourceId: null, sourceVersion: null },
    ]);
  });

  it("accepts absent answers without synthesizing them and reports missing references", () => {
    const pack = syntheticFixture(); pack.questions[0]!.answer = null;
    const candidate = adaptMaterialCoursePackage(pack, unknownDeadline);
    expect(candidate.privateAnswerKeys).toEqual([]);
    expect(candidate.coverage[0]!.withReferenceAnswers).toBe(0);
    expect(candidate.routeInput.requirements[0]!.verification.missingReasons).toContain("missing_reference_answer");
  });

  it.each([
    ["missing deadline", {}], ["invalid deadline", { deadlineAt: "next Friday" }],
    ["invalid owner", { deadlineAt: null, ownerUserId: "invented-user" }],
    ["invalid version", { deadlineAt: null, routeVersion: -1 }],
  ])("rejects %s instead of defaulting to a current exam schedule", (_label, options) => {
    expect(() => adaptMaterialCoursePackage(syntheticFixture(), options as MaterialCoursePackageOptions)).toThrow();
  });

  it.each([
    ["missing SHA", (p: MaterialCoursePackage) => { p.sources[0]!.pdfSha256 = ""; }],
    ["unknown source", (p: MaterialCoursePackage) => { p.questions[0]!.prompt.sourceRefs[0]!.sourceKey = "unknown"; }],
    ["invalid page", (p: MaterialCoursePackage) => { p.questions[0]!.answer!.sourceRefs[0]!.page = 5; }],
    ["page zero", (p: MaterialCoursePackage) => { p.skills[0]!.sourceRefs[0]!.page = 0; }],
    ["unknown topic", (p: MaterialCoursePackage) => { p.skills[0]!.topicId = "unknown"; }],
    ["unknown skill", (p: MaterialCoursePackage) => { p.questions[0]!.skillIds = ["unknown"]; }],
    ["unknown prerequisite", (p: MaterialCoursePackage) => { p.skills[1]!.prerequisiteSkillIds = ["unknown"]; }],
    ["cyclic prerequisite", (p: MaterialCoursePackage) => { p.skills[0]!.prerequisiteSkillIds = ["fixture-advanced"]; }],
    ["self prerequisite", (p: MaterialCoursePackage) => { p.skills[0]!.prerequisiteSkillIds = ["fixture-basic"]; }],
    ["unknown diagnostic", (p: MaterialCoursePackage) => { p.skills[0]!.diagnosticQuestionIds = ["unknown"]; }],
    ["description diagnostic", (p: MaterialCoursePackage) => { p.skills[1]!.diagnosticQuestionIds = ["fixture-description"]; }],
    ["cross-skill diagnostic", (p: MaterialCoursePackage) => { p.skills[1]!.diagnosticQuestionIds = ["fixture-question"]; }],
    ["missing formula flag", (p: MaterialCoursePackage) => { Reflect.deleteProperty(p.questions[0]!.prompt, "unverifiedFormula"); }],
    ["duplicate prerequisite", (p: MaterialCoursePackage) => { p.skills[1]!.prerequisiteSkillIds = ["fixture-basic", "fixture-basic"]; }],
    ["duplicate diagnostic", (p: MaterialCoursePackage) => { p.skills[0]!.diagnosticQuestionIds = ["fixture-question", "fixture-question"]; }],
    ["duplicate question skill", (p: MaterialCoursePackage) => { p.questions[0]!.skillIds.push("fixture-basic"); }],
    ["duplicate question", (p: MaterialCoursePackage) => { p.questions.push(structuredClone(p.questions[0]!)); }],
    ["duplicate skill", (p: MaterialCoursePackage) => { p.skills.push(structuredClone(p.skills[0]!)); }],
    ["duplicate source", (p: MaterialCoursePackage) => { p.sources.push(structuredClone(p.sources[0]!)); }],
    ["duplicate topic", (p: MaterialCoursePackage) => { p.topics.push(structuredClone(p.topics[0]!)); }],
    ["partial source binding", (p: MaterialCoursePackage) => { p.sources[0]!.sourceVersion = 1; }],
  ])("rejects broken provenance/reference: %s", (_label, change) => {
    const pack = syntheticFixture(); change(pack);
    expect(materialCoursePackageSchema.safeParse(pack).success).toBe(false);
    expect(() => adaptMaterialCoursePackage(pack, unknownDeadline)).toThrow();
  });

  it("rejects missing explicit formula flags, answer-role prompts and injected verification/tracker state", () => {
    const fixture = syntheticFixture();
    for (const prompt of [{ ...fixture.questions[0]!.prompt, role: "answer_key" }, { ...fixture.questions[0]!.prompt, answer: "leak" }]) {
      expect(() => adaptMaterialCoursePackage({ ...fixture, questions: [{ ...fixture.questions[0], prompt }] }, unknownDeadline)).toThrow();
    }
    for (const extra of [{ verified: true }, { attempts: [] }, { sourceRecords: [] }]) {
      expect(() => adaptMaterialCoursePackage({ ...fixture, ...extra }, unknownDeadline)).toThrow();
    }
  });
});
