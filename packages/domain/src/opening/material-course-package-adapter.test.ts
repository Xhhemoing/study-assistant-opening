import { readFileSync } from "node:fs";
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
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64), questionIndexSha256: "b".repeat(64), mappingFiles: [],
    sources: [{ file: "synthetic.pdf", sha256: "c".repeat(64), physicalPages: 1 }],
    skills: [{ ...part.skills[0]!, prerequisiteIds: [], sourceRefs: [{ file: "synthetic.pdf", physicalPages: [1], verification: "text-reviewed" }] }],
    prerequisiteOrder: ["fixture-basic"],
    questions: Array.from({ length: 150 }, (_, i) => ({ ...part.questions[0]!, id: `fixture-q-${i}`, kind: "Test", evidenceType: "objective-choice", mappingStatus: "text-reviewed",
      assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification" })),
    diagnostic: { status: "candidate-not-administered", source: "Synthetic 20-item entry", questionIds: Array.from({ length: 20 }, (_, i) => `fixture-q-${i}`), constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "Synthetic no admission", requiredRuntimeChecks: [], constructedResponsePolicy: "No duplicated subskill verdict", familyPolicy: "Not canonical family" },
    schedule: { productTarget: "Synthetic product deadline", latestProductUseDate: "Synthetic target", actualExamDate: null, dailyStudyMinutes: null, policy: "No inferred exam date" },
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

  it("blocks readiness exclusions even if diagnosticEligible says true", () => {
    const pack = syntheticFullFixture();
    pack.questions[0]!.assessmentReadiness = "blocked-material-dispute";
    pack.validation.disputedDiagnosticExclusions = ["fixture-q-0"];
    const result = adaptMaterialCourseFullPackage(pack, unknownDeadline);
    expect(result.diagnostic.blockedEntryQuestionIds).toEqual(["fixture-q-0"]);
    expect(result.planInput.items[0]!.diagnosticQuestionIds).not.toContain("fixture-q-0");
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
    const input: unknown = JSON.parse(readFileSync(fullPath!, "utf8"));
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
    expect(result.questionMappings.find(q => q.id === "T5-Q9")).toMatchObject({ diagnosticEligible: false, bktEligible: false, assessmentReadiness: "blocked-material-dispute" });
    expect(result.questionMappings.every(q => !q.scoringEligible && !q.bktEligible && q.canonicalFamilyId === null && q.prompt === null && q.answer === null)).toBe(true);
    expect(result.schedule).toMatchObject({ actualExamDate: null, dailyStudyMinutes: null });
    expect(result).toMatchObject({ published: false, status: "proposed", ownerUserId: null, courseId: null, routeVersion: null, teachingVersion: null, deadlineAt: null, coverageExhaustive: false });
    expect(result.coverageGaps).toHaveLength(4);
    expect(result.coverageGapNotes.length).toBeGreaterThan(0);
    expect(result.coverage.every(row => row.measurementStatus === "untested")).toBe(true);
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

  // Opt-in local real-file replay. Never substitutes a fixture when the private file is absent.
  const realPath = process.env.MATERIAL_COURSE_REAL_INPUT;
  it.skipIf(!realPath)("replays the PM-delivered real Topic 4–5 package", () => {
    const actual: unknown = JSON.parse(readFileSync(realPath!, "utf8"));
    const result = adaptMaterialCourseMappingPackage(actual, partialMappingOptions);
    expect(result.routeInput.requirements).toHaveLength(35);
    expect(result.questionMappings).toHaveLength(60);
    expect(result.coverageGaps).toHaveLength(4);
    expect(result.pendingExternalPrerequisites.map(ref => ref.skillId).sort()).toEqual([...MIDTERM_PENDING_PREREQUISITE_IDS].sort());
    expect(result.questionMappings.filter(q => q.mappingStatus === "text-reviewed")).toHaveLength(57);
    expect(result.questionMappings.filter(q => q.unverifiedFormula).map(q => q.id)).toEqual(["T4-Q13", "T5-Q16", "T5-Q18"]);
    expect(result.questionMappings.filter(q => !q.diagnosticEligible).map(q => q.id)).toEqual(["T4-Q13", "T5-Q9", "T5-Q16", "T5-Q18"]);
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
