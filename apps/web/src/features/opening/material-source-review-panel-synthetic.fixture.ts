import type { MaterialSourceReviewInput } from "./material-source-review-panel-model";

/** Entirely authored test metadata: no private input, PDF bytes or real150/77/385 claim. */
export function syntheticReviewInput(): MaterialSourceReviewInput {
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported",
    sourceManifestSha256: "c".repeat(64), questionIndexSha256: "d".repeat(64), mappingFiles: [],
    sources: [
      { file: "synthetic-alpha.pdf", physicalPages: 4, sha256: "a".repeat(64) },
      { file: "synthetic-beta.pdf", physicalPages: 7, sha256: "b".repeat(64) },
    ],
    skills: [
      { id: "synthetic-s1", title: "Synthetic first skill", topic: 1, prerequisiteIds: [],
        learningObjectives: ["PRIVATE_OBJECTIVE_ALPHA"], commonErrors: ["PRIVATE_ERROR_ALPHA"],
        sourceRefs: [{ file: "synthetic-alpha.pdf", physicalPages: [1, 4], verification: "text-reviewed" }] },
      { id: "synthetic-s2", title: "Synthetic second skill", topic: 1, prerequisiteIds: ["synthetic-s1"],
        learningObjectives: ["PRIVATE_OBJECTIVE_BETA"], commonErrors: ["PRIVATE_ERROR_BETA"],
        sourceRefs: [{ file: "synthetic-beta.pdf", physicalPages: [7], verification: "needs-visual-check" }] },
    ],
    prerequisiteOrder: ["synthetic-s1", "synthetic-s2"],
    questions: [
      { id: "synthetic-q1", topic: 1, kind: "Test", number: 1, evidenceType: "objective-choice", sourceFile: "synthetic-alpha.pdf", physicalPage: 2,
        primarySkillId: "synthetic-s1", secondarySkillIds: ["synthetic-s2"], mappingStatus: "text-reviewed",
        assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification", postAttemptNotes: "PRIVATE_POST_ATTEMPT_ALPHA" },
      { id: "synthetic-q2", topic: 1, kind: "Problems", number: 2, evidenceType: "constructed-response", sourceFile: "synthetic-beta.pdf", physicalPage: 7,
        primarySkillId: "synthetic-s2", secondarySkillIds: [], mappingStatus: "needs-visual-check",
        assessmentReadiness: "blocked-visual-check", bktAdmission: false, postAttemptNotes: "PRIVATE_POST_ATTEMPT_BETA" },
      { id: "synthetic-q3", topic: 1, kind: "Test", number: 3, evidenceType: "objective-choice", sourceFile: "synthetic-alpha.pdf", physicalPage: 4,
        primarySkillId: "synthetic-s1", secondarySkillIds: [], mappingStatus: "text-reviewed",
        assessmentReadiness: "blocked-author-exclusion", bktAdmission: false, postAttemptNotes: "PRIVATE_POST_ATTEMPT_GAMMA" },
    ],
    diagnostic: { status: "candidate-not-administered", source: "Synthetic metadata only", questionIds: ["synthetic-q1"],
      constructedResponseCandidates: ["synthetic-q2"], conditions: ["No runtime qualification"] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false,
      policy: "No measurement", requiredRuntimeChecks: ["No evidence supplied"], constructedResponsePolicy: "Not qualified",
      familyPolicy: "Unknown family", feedbackPolicy: "Private feedback only" },
    schedule: { productTarget: "Synthetic review only", latestProductUseDate: "Not scheduled", actualExamDate: null,
      dailyStudyMinutes: null, policy: "No schedule", unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit",
      unmeasuredSkillIds: ["synthetic-s1", "synthetic-s2"] },
    coverageGaps: [], coverageGapNotes: ["Synthetic small fixture, not a full adapter delivery"],
    validation: { sourcePdfs: 2, questionCount: 3, skillCount: 2, textMappedCount: 2,
      visualCheckRequired: ["synthetic-q2"], disputedDiagnosticExclusions: ["synthetic-q3"],
      semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
}

export function syntheticReviewBindings(input: MaterialSourceReviewInput) {
  return input.sources.map((source, i) => ({ file: source.file, pdfSha256: source.sha256,
    sourceId: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`, sourceVersion: i,
    pdfUrl: `https://synthetic.invalid/host-only-${i}.pdf?signature=A%2Bb&keep=%2F` }));
}
