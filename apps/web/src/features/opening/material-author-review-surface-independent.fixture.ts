import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { MaterialCourseFullPackage } from "../../../../../packages/domain/src/opening/material-course-package-adapter";

export const PRIVATE_REVIEW_CANARIES = [
  'PRIVATE_POST_NOTE_<script>not-an-answer</script>&"',
  'PRIVATE_OBJECTIVE_<b>not-a-prompt</b>&"',
  'PRIVATE_COMMON_ERROR_<img src=x>&"',
] as const;

/** Entirely synthetic metadata. 150 items satisfy the frozen adapter's denominator;
 * no private JSON, question bodies, answer keys, real PDF identities or access claims. */
export function syntheticReviewInput(label = "A"): MaterialCourseFullPackage {
  const sources = [0, 1].map(i => ({ file: `synthetic-${label}-${i}.pdf`, physicalPages: 200, sha256: String(i + 1).repeat(64) }));
  const skills = ["alpha", "beta", "gamma", "orphan"].map((name, i) => ({
    id: `synthetic-${name}`, title: `${label} ${name}`, topic: i < 2 ? 1 : 2,
    prerequisiteIds: i === 1 ? ["synthetic-alpha"] : [],
    learningObjectives: [PRIVATE_REVIEW_CANARIES[1]], commonErrors: [PRIVATE_REVIEW_CANARIES[2]],
    sourceRefs: [{ file: sources[i % 2]!.file, physicalPages: [i + 2, i + 7], verification: "text-reviewed" as const }],
  }));
  const questions: MaterialCourseFullPackage["questions"] = Array.from({ length: 150 }, (_, i) => ({
    id: `SYN-Q${i + 1}`, topic: skills[i % 3]!.topic, kind: i < 125 ? "Test" : "Problems", number: i + 1,
    sourceFile: sources[i % 2]!.file, physicalPage: i + 1, primarySkillId: skills[i % 3]!.id, secondarySkillIds: [],
    evidenceType: i < 125 ? "objective-choice" : "constructed-response",
    mappingStatus: i === 148 ? "needs-visual-check" : "text-reviewed", postAttemptNotes: PRIVATE_REVIEW_CANARIES[0],
    assessmentReadiness: i === 149 ? "blocked-author-exclusion" : i === 148 ? "blocked-visual-check" : "requires-answer-key-and-exposure-check",
    bktAdmission: i >= 148 ? false : "requires-runtime-evidence-qualification",
  }));
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64), questionIndexSha256: "b".repeat(64),
    mappingFiles: [{ file: `synthetic-${label}-mapping.json`, sha256: "c".repeat(64) }], sources, skills,
    prerequisiteOrder: skills.map(s => s.id), questions,
    diagnostic: { status: "candidate-not-administered", source: "synthetic metadata only", questionIds: questions.slice(0, 20).map(q => q.id),
      constructedResponseCandidates: questions.slice(125, 130).map(q => q.id), conditions: ["not administered"] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false,
      policy: "synthetic metadata is not evidence", requiredRuntimeChecks: ["exposure not verified"], constructedResponsePolicy: "not scored",
      familyPolicy: "no canonical family", feedbackPolicy: "private review only" },
    schedule: { productTarget: "synthetic fixture", latestProductUseDate: "unknown", actualExamDate: null, dailyStudyMinutes: null,
      policy: "no schedule inferred", unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [skills[0]!.id] },
    coverageGaps: [], coverageGapNotes: [],
    validation: { sourcePdfs: sources.length, questionCount: questions.length, skillCount: skills.length, textMappedCount: 149,
      visualCheckRequired: [questions[148]!.id], disputedDiagnosticExclusions: [questions[149]!.id],
      semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
}

export function syntheticReviewBindings(input: MaterialCourseFullPackage, label = "a") {
  return input.sources.map((source, i) => ({ file: source.file, pdfSha256: source.sha256,
    sourceId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, sourceVersion: 0,
    pdfUrl: `https://review.example.invalid/${label}-${i}.pdf` }));
}

export const REAL_REVIEW_SHA256 = "041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b";
/** Explicit opt-in only. A supplied unreadable path or wrong SHA is an error, never a skip. */
export function loadExplicitRealReviewInput(path: string): MaterialCourseFullPackage {
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== REAL_REVIEW_SHA256) throw new Error("Real review input SHA256 mismatch");
  return JSON.parse(bytes.toString()) as MaterialCourseFullPackage;
}
