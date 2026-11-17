import { z } from "zod";
import type { adaptMaterialCourseFullPackage } from "../../../../../packages/domain/src/opening/material-course-package-adapter";

/** Offline adapter result, NOT the runtime import schema. Never pass answer-bearing packages. */
export type MaterialPackagePreviewCandidate = ReturnType<typeof adaptMaterialCourseFullPackage>;

const label = z.string().trim().min(1);
const ids = z.array(label);
const sourceRef = z.object({ file: label, page: z.number().int().positive() });
const requirement = z.object({
  externalSkillId: label, title: label, prerequisiteSkillIds: ids,
  diagnosticQuestionIds: ids, measurementStatus: z.literal("untested"), sourceRefs: z.array(sourceRef).min(1),
});
const question = z.object({
  id: label, topic: z.number().int().positive(), kind: z.enum(["Test", "Problems"]), number: z.number().int().positive(),
  primarySkillId: label, secondarySkillIds: ids, sourceFile: label, physicalPage: z.number().int().positive(),
  mappingStatus: z.enum(["text-reviewed", "needs-visual-check"]),
  assessmentReadiness: z.union([z.enum(["requires-answer-key-and-exposure-check", "blocked-visual-check", "blocked-author-exclusion"]), z.literal(false)]),
  bktAdmission: z.union([z.literal("requires-runtime-evidence-qualification"), z.literal(false)]),
  diagnosticEligible: z.boolean(), diagnosticEntryCandidate: z.boolean(), supplementalDiagnosticCandidate: z.boolean(),
  scoringEligible: z.literal(false), bktEligible: z.literal(false), prompt: z.null(), answer: z.null(),
  notes: z.never().optional(), postAttemptNotes: z.never().optional(),
});

// This is a read-only view projection: strip unneeded fields, and close on unsafe admission flags.
// It does not parse author inputs, certify PDF contents, or replace adapter/domain validation.
const previewSchema = z.object({
  kind: z.literal("material_course_full_package_candidate"), status: z.literal("proposed"), published: z.literal(false),
  ownerUserId: label.nullable(), courseId: label.nullable(), routeVersion: z.number().int().nonnegative().nullable(),
  teachingVersion: z.number().int().nonnegative().nullable(), deadlineAt: label.nullable(),
  postAttemptMetadata: z.object({
    role: z.literal("feedback_only"), independentIfExposedBeforeAnswer: z.literal(false), scoringEvidence: z.literal(false),
    questions: z.array(z.object({ questionId: label, postAttemptNotes: label }).strict()).min(1),
    skills: z.array(z.object({ skillId: label, title: label, learningObjectives: ids, commonErrors: ids }).strict()).min(1),
  }).strict(),
  safeFirstAnswerInput: z.object({ status: z.literal("proposed"), bodyStatus: z.literal("missing"),
    questions: z.array(z.object({ questionId: label, sourceRef }).strict()).min(1),
  }).strict(),
  sources: z.array(z.object({ file: label, physicalPages: z.number().int().positive() })).min(1),
  questionMappings: z.array(question).min(1), prerequisiteOrder: ids.min(1),
  routeInput: z.object({ status: z.literal("proposed"), requirements: z.array(requirement).min(1) }),
  coverage: z.array(z.object({ skillId: label, measurementStatus: z.literal("untested"), independentEligibility: z.literal("unknown") })).min(1),
  diagnostic: z.object({
    status: z.literal("candidate-not-administered"), administered: z.literal(false), questionIds: ids.min(1),
    eligibleEntryQuestionIds: ids, blockedEntryQuestionIds: ids, constructedResponseCandidates: ids,
    declaredConstructedResponseCandidates: ids, blockedConstructedResponseCandidates: ids,
  }),
  prerequisiteGuidance: z.object({
    status: z.literal("proposed"), policy: z.literal("teach-bridge-without-mastery-credit"), learnerMeasurement: z.literal("not_supplied"),
    masteryCredit: z.literal(false), permanentPassGate: z.literal(false),
    conceptBridges: z.array(z.object({ targetSkillId: label, prerequisiteSkillId: label, action: z.literal("concept_bridge"),
      reason: z.enum(["declared_measurement_gap", "no_learner_measurement"]), measurementStatus: z.literal("untested"),
      skippable: z.literal(true), requiredPass: z.literal(false), masteryCredit: z.literal(false),
    }).strict()),
  }).strict(),
  bktBoundary: z.object({ calibrated: z.literal(false), learnerStateCreated: z.literal(false) }),
  schedule: z.object({ actualExamDate: label.nullable(), dailyStudyMinutes: z.number().int().positive().nullable() }),
  learnerPrompts: z.array(z.never()).length(0), privateAnswerKeys: z.array(z.never()).length(0),
  coverageExhaustive: z.literal(false), factualSupport: z.literal("unverified"),
  coverageGaps: z.array(z.object({ skillId: label, scope: label, candidateSource: label })), coverageGapNotes: ids,
  validation: z.object({
    sourcePdfs: z.number().int().nonnegative(), questionCount: z.number().int().nonnegative(), skillCount: z.number().int().nonnegative(),
    visualCheckRequired: ids, disputedDiagnosticExclusions: ids,
    semanticMathVerification: z.literal("not-complete"), runtimeCoursePublication: z.literal("not-verified"),
  }),
}).superRefine((v, ctx) => {
  const fail = () => ctx.addIssue({ code: "custom", message: "Inconsistent offline preview" });
  const unique = (values: string[]) => new Set(values).size === values.length;
  const same = (a: string[], b: string[]) => unique(a) && unique(b) && a.length === b.length && a.every(id => b.includes(id));
  const skills = v.routeInput.requirements;
  const skillIds = skills.map(s => s.externalSkillId);
  const questions = new Map(v.questionMappings.map(q => [q.id, q]));
  const sources = new Map(v.sources.map(s => [s.file, s.physicalPages]));
  const order = new Map(v.prerequisiteOrder.map((id, index) => [id, index]));
  const admissible = (id: string) => {
    const q = questions.get(id);
    return !!q && q.diagnosticEligible && q.mappingStatus === "text-reviewed"
      && q.assessmentReadiness === "requires-answer-key-and-exposure-check" && q.bktAdmission !== false;
  };
  // Declared entries are the boundary: do not silently accept adapter-filtered pollution.
  if (v.diagnostic.blockedEntryQuestionIds.length || v.diagnostic.blockedConstructedResponseCandidates.length
    || !same(v.diagnostic.questionIds, v.diagnostic.eligibleEntryQuestionIds)
    || !same(v.diagnostic.declaredConstructedResponseCandidates, v.diagnostic.constructedResponseCandidates)
    || v.diagnostic.questionIds.some(id => !admissible(id))
    || v.diagnostic.declaredConstructedResponseCandidates.some(id => !admissible(id) || questions.get(id)!.kind !== "Problems")) fail();
  for (const s of skills) {
    const bridges = v.prerequisiteGuidance.conceptBridges.filter(b => b.targetSkillId === s.externalSkillId);
    if (!same(bridges.map(b => b.prerequisiteSkillId), s.prerequisiteSkillIds)) fail();
  }
  if (v.prerequisiteGuidance.conceptBridges.some(b => !skillIds.includes(b.targetSkillId) || !skillIds.includes(b.prerequisiteSkillId))) fail();
  if (!unique(skillIds) || questions.size !== v.questionMappings.length || sources.size !== v.sources.length
    || !same(skillIds, v.prerequisiteOrder) || !same(skillIds, v.coverage.map(c => c.skillId))
    || v.validation.skillCount !== skills.length || v.validation.questionCount !== questions.size || v.validation.sourcePdfs !== sources.size
    || !same(v.postAttemptMetadata.questions.map(q => q.questionId), [...questions.keys()]) || !same(v.postAttemptMetadata.skills.map(s => s.skillId), skillIds)
    || !same(v.safeFirstAnswerInput.questions.map(q => q.questionId), [...questions.keys()])) fail();
  for (const s of skills) {
    if (!unique(s.prerequisiteSkillIds) || s.prerequisiteSkillIds.some(id => !order.has(id) || order.get(id)! >= order.get(s.externalSkillId)!)) fail();
    if (s.sourceRefs.some(r => !sources.has(r.file) || r.page > sources.get(r.file)!)) fail();
    if (!same(s.diagnosticQuestionIds, v.questionMappings.filter(q => q.diagnosticEntryCandidate
      && (q.primarySkillId === s.externalSkillId || q.secondarySkillIds.includes(s.externalSkillId))).map(q => q.id))) fail();
  }
  for (const first of v.safeFirstAnswerInput.questions) {
    const q = questions.get(first.questionId);
    if (!q || first.sourceRef.file !== q.sourceFile || first.sourceRef.page !== q.physicalPage) fail();
  }
  for (const q of v.questionMappings) {
    if (![q.primarySkillId, ...q.secondarySkillIds].every(id => skillIds.includes(id))
      || !sources.has(q.sourceFile) || q.physicalPage > sources.get(q.sourceFile)!) fail();
    const blocked = q.mappingStatus === "needs-visual-check" || q.assessmentReadiness !== "requires-answer-key-and-exposure-check";
    if (blocked && (q.diagnosticEligible || q.diagnosticEntryCandidate)) fail();
    if (q.diagnosticEntryCandidate && (!q.diagnosticEligible || !v.diagnostic.questionIds.includes(q.id))) fail();
  }
  if (!same(v.validation.visualCheckRequired, v.questionMappings.filter(q => q.mappingStatus === "needs-visual-check").map(q => q.id))
    || !same(v.validation.disputedDiagnosticExclusions, v.questionMappings.filter(q => q.assessmentReadiness === "blocked-author-exclusion").map(q => q.id))
    || !same(v.diagnostic.eligibleEntryQuestionIds, v.questionMappings.filter(q => q.diagnosticEntryCandidate).map(q => q.id))
    || !same(v.diagnostic.constructedResponseCandidates, v.questionMappings.filter(q => q.supplementalDiagnosticCandidate).map(q => q.id))
    || !same(v.diagnostic.questionIds, [...v.diagnostic.eligibleEntryQuestionIds, ...v.diagnostic.blockedEntryQuestionIds])
    || v.diagnostic.questionIds.some(id => !questions.has(id))
    || !unique(v.diagnostic.constructedResponseCandidates)
    || v.diagnostic.constructedResponseCandidates.some(id => {
      const q = questions.get(id);
      return !q || q.kind !== "Problems" || !admissible(id) || !q.supplementalDiagnosticCandidate;
    })
    || v.coverageGaps.some(g => !skillIds.includes(g.skillId))) fail();
}).transform(({ postAttemptMetadata: _feedback, ...view }) => view);

/** Reject missing/unsafe view data without echoing payloads or validation internals into the UI. */
export function readMaterialPackagePreview(candidate: MaterialPackagePreviewCandidate | null | undefined) {
  const parsed = previewSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}
