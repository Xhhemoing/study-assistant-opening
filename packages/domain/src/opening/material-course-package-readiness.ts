import { z } from "zod";
import {
  acceptPlanInputSchema, courseRouteConfirmSchema, courseRouteRequirementInputSchema,
  courseRouteStartSchema, planDraftSchema, privateTrustedQuestionKeySchema, problemRefSchema, suggestedTaskSchema,
} from "@aistudy/contracts";
import {
  adaptMaterialCourseFullPackage, materialCourseFullPackageSchema, materialCourseMappingPackageSchema,
} from "./material-course-package-adapter";

type Candidate = ReturnType<typeof adaptMaterialCourseFullPackage>;
const key = z.string().min(1).max(200);
const version = z.number().int().nonnegative();
const full = materialCourseFullPackageSchema.shape;
const mapping = materialCourseMappingPackageSchema.shape;
const citation = z.object({ file: key, page: z.number().int().positive(),
  pdfSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).nullable(),
  sourceId: z.string().uuid().nullable(), sourceVersion: version.nullable() }).strict();
const pending = z.object({ skillId: key, status: z.literal("pending") }).strict();
const untested = { measurementStatus: z.literal("untested"), independentEligibility: z.literal("unknown") };
const conceptBridge = z.object({ targetSkillId: key, prerequisiteSkillId: key, action: z.literal("concept_bridge"),
  reason: z.enum(["declared_measurement_gap", "no_learner_measurement"]), measurementStatus: z.literal("untested"),
  skippable: z.literal(true), requiredPass: z.literal(false), masteryCredit: z.literal(false) }).strict();
const requirement = z.object({ id: z.null(), stableSkillId: z.null(), knowledgeNodeId: z.null(),
  externalSkillId: key, requirementKey: key, title: key, position: version, mandatory: z.null(), goalIds: z.array(z.never()),
  prerequisiteIds: z.null(), prerequisiteSkillIds: z.array(key), externalPrerequisites: z.array(pending),
  sourceRefs: z.array(citation.extend({ mappingStatus: z.enum(["text-reviewed", "needs-visual-check"]) }).strict()),
  prerequisitePolicy: z.literal("concept_bridge_without_mastery_gate"), conceptBridges: z.array(conceptBridge),
  verification: courseRouteRequirementInputSchema.shape.verification.extend({ kind: z.literal("unavailable"),
    status: z.literal("needs_check"), rubric: z.null() }).strict(), diagnosticQuestionIds: z.array(key), ...untested,
}).strict();
// Full-package output has no legacy notes; feedback is kept in a separate private projection.
const question = mapping.questions.element.omit({ notes: true }).extend({ sourceRef: citation, externalSkillRefs: z.array(pending),
  authorDiagnosticEligible: z.boolean(), diagnosticExclusionReasons: z.array(key), unverifiedFormula: z.boolean(),
  prompt: z.null(), answer: z.null(), bodyStatus: z.literal("mapping_only"), mathematicalVerification: z.literal("unverified"),
  scoringEligible: z.literal(false), independentEligibility: z.literal("unknown"),
  assessmentReadiness: full.questions.element.shape.assessmentReadiness, bktAdmission: full.questions.element.shape.bktAdmission,
  diagnosticEntryCandidate: z.boolean(), supplementalDiagnosticCandidate: z.boolean(), canonicalFamilyId: z.null(), bktEligible: z.literal(false), reliablePartScoring: z.literal("unverified"),
}).strict();
const proposed = <T extends z.ZodType>(item: T) => z.object({ status: z.literal("proposed"), items: z.array(item) }).strict();
/** Untrusted persisted offline output: reject unknown fields at every depth, not strip them. */
const candidateSchema = z.object({
  kind: z.literal("material_course_full_package_candidate"), status: z.literal("proposed"), published: z.literal(false),
  ownerUserId: z.string().uuid().nullable(), courseId: z.string().uuid().nullable(), routeVersion: version.nullable(), teachingVersion: version.nullable(),
  deadlineAt: z.string().datetime({ offset: true }).nullable(), validationScope: z.literal("complete"), coverageStatus: z.enum(["partial", "mapped"]),
  topics: mapping.topics, verificationScope: key, sourceResolution: z.string().min(1), pendingExternalPrerequisites: z.array(pending), missingPdfHashes: z.array(key),
  completeness: z.object({ localSkills: version, mappedQuestions: version, expectedQuestionCount: version.nullable(), pendingExternalSkills: version,
    missingPdfHashes: version, declaredCoverageGaps: version, bodyStatus: z.literal("mapping_only") }).strict(),
  coverageGaps: mapping.coverageGaps, questionMappings: z.array(question),
  routeInput: z.object({ status: z.literal("proposed"), requirements: z.array(requirement) }).strict(),
  teachingInput: proposed(z.object({ itemId: key, title: key, goalIds: z.array(z.never()), prereqItemIds: z.array(key),
    sourceIds: z.array(z.string().uuid()), sourceRefs: requirement.shape.sourceRefs,
    intendedBlockTypes: z.array(z.literal("text")) }).strict()),
  planInput: proposed(z.object({ id: z.null(), title: key, skillLabel: key, requirementKey: key, minutes: z.null(),
    deadlineAt: z.string().datetime({ offset: true }).nullable(), diagnosticQuestionIds: z.array(key) }).strict()),
  coverage: z.array(z.object({ skillId: key, questionIds: z.array(key), diagnosticQuestionIds: z.array(key), gaps: mapping.coverageGaps, ...untested }).strict()),
  learnerPrompts: z.array(z.never()), privateAnswerKeys: z.array(z.never()), factualSupport: z.literal("unverified"),
  prerequisiteOrder: full.prerequisiteOrder, sourceManifestSha256: full.sourceManifestSha256, questionIndexSha256: full.questionIndexSha256,
  mappingFiles: full.mappingFiles, sources: full.sources, coverageGapNotes: full.coverageGapNotes, coverageExhaustive: z.literal(false),
  diagnostic: full.diagnostic.extend({ eligibleEntryQuestionIds: z.array(key), blockedEntryQuestionIds: z.array(key),
    declaredConstructedResponseCandidates: z.array(key), blockedConstructedResponseCandidates: z.array(key), administered: z.literal(false) }).strict(),
  bktBoundary: full.bktBoundary, schedule: full.schedule, validation: full.validation,
  postAttemptMetadata: z.object({ role: z.literal("feedback_only"), independentIfExposedBeforeAnswer: z.literal(false), scoringEvidence: z.literal(false),
    questions: z.array(z.object({ questionId: key, postAttemptNotes: full.questions.element.shape.postAttemptNotes }).strict()),
    skills: z.array(z.object({ skillId: key, title: key, learningObjectives: z.array(z.string().min(1).max(20000)),
      commonErrors: z.array(z.string().min(1).max(20000)) }).strict()) }).strict(),
  safeFirstAnswerInput: z.object({ status: z.literal("proposed"), bodyStatus: z.literal("missing"),
    questions: z.array(z.object({ questionId: key, sourceRef: citation }).strict()) }).strict(),
  prerequisiteGuidance: z.object({ status: z.literal("proposed"), policy: z.literal("teach-bridge-without-mastery-credit"),
    learnerMeasurement: z.literal("not_supplied"), conceptBridges: z.array(conceptBridge), masteryCredit: z.literal(false), permanentPassGate: z.literal(false) }).strict(),
}).strict();

// Saved derived metadata is untrusted; check its relationships without inventing lost skill topics.
function parseCandidate(input: unknown): Candidate {
  const c = candidateSchema.parse(input);
  const rows = c.routeInput.requirements, qs = c.questionMappings;
  const skills = rows.map(r => r.externalSkillId), ids = qs.map(q => q.id);
  const order = new Map(c.prerequisiteOrder.map((id, i) => [id, i]));
  const sources = new Map(c.sources.map(s => [s.file, s]));
  const validCitation = (ref: z.infer<typeof citation>) => {
    const source = sources.get(ref.file);
    // This full-package adapter deliberately leaves database source bindings null.
    return source && ref.page <= source.physicalPages && ref.pdfSha256 === source.sha256
      && ref.sourceId === null && ref.sourceVersion === null;
  };
  const eligible = qs.filter(q => q.diagnosticEntryCandidate).map(q => q.id);
  const supplemental = qs.filter(q => q.supplementalDiagnosticCandidate).map(q => q.id);
  const bridges = rows.flatMap(r => r.prerequisiteSkillIds.map(prerequisiteSkillId => ({
    targetSkillId: r.externalSkillId, prerequisiteSkillId, action: "concept_bridge",
    reason: c.schedule.unmeasuredSkillIds.includes(prerequisiteSkillId) ? "declared_measurement_gap" : "no_learner_measurement",
    measurementStatus: "untested", skippable: true, requiredPass: false, masteryCredit: false,
  })));
  const same = (a: unknown, b: unknown): boolean => {
    if (a === b) return true;
    if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]));
    if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
    return Object.keys(a).length === Object.keys(b).length
      && Object.entries(a).every(([k, v]) => Object.hasOwn(b, k) && same(v, Reflect.get(b, k)));
  };
  const invalid = new Set(skills).size !== rows.length || new Set(ids).size !== ids.length
    || sources.size !== c.sources.length || new Set(c.topics).size !== c.topics.length
    || !sameIds(skills, c.prerequisiteOrder) || qs.length !== 150 || qs.length !== c.completeness.mappedQuestions
    || qs.length !== c.validation.questionCount || c.completeness.expectedQuestionCount !== qs.length
    || skills.length !== c.completeness.localSkills || skills.length !== c.validation.skillCount || sources.size !== c.validation.sourcePdfs
    || c.completeness.pendingExternalSkills !== 0 || c.pendingExternalPrerequisites.length !== 0
    || c.completeness.missingPdfHashes !== 0 || c.missingPdfHashes.length !== 0
    || c.completeness.declaredCoverageGaps !== c.coverageGaps.length
    || c.coverageStatus !== (c.coverageGaps.length ? "partial" : "mapped")
    || c.coverageGaps.some(g => !skills.includes(g.skillId))
    || c.validation.textMappedCount !== qs.filter(q => q.mappingStatus === "text-reviewed").length
    || !sameIds(c.validation.visualCheckRequired, qs.filter(q => q.mappingStatus === "needs-visual-check").map(q => q.id))
    || !sameIds(c.validation.disputedDiagnosticExclusions, qs.filter(q => q.assessmentReadiness === "blocked-author-exclusion").map(q => q.id))
    || new Set(c.schedule.unmeasuredSkillIds).size !== c.schedule.unmeasuredSkillIds.length
    || c.schedule.unmeasuredSkillIds.some(id => !skills.includes(id))
    || !same(c.prerequisiteGuidance.conceptBridges, bridges)
    || !same(c.safeFirstAnswerInput.questions, qs.map(q => ({ questionId: q.id, sourceRef: q.sourceRef })))
    || !sameIds(c.postAttemptMetadata.questions.map(q => q.questionId), ids)
    || !sameIds(c.postAttemptMetadata.skills.map(s => s.skillId), skills)
    || c.postAttemptMetadata.skills.some(s => s.title !== rows.find(r => r.externalSkillId === s.skillId)?.title)
    || c.diagnostic.questionIds.length !== 20 || new Set(c.diagnostic.questionIds).size !== 20
    || [...c.diagnostic.questionIds, ...c.diagnostic.declaredConstructedResponseCandidates].some(id => !ids.includes(id))
    || new Set(c.diagnostic.declaredConstructedResponseCandidates).size !== c.diagnostic.declaredConstructedResponseCandidates.length
    || !sameIds(c.diagnostic.constructedResponseCandidates, supplemental)
    || !sameIds(c.diagnostic.blockedConstructedResponseCandidates, c.diagnostic.declaredConstructedResponseCandidates.filter(id => !supplemental.includes(id)))
    || !sameIds(c.diagnostic.eligibleEntryQuestionIds, eligible)
    || !sameIds(c.diagnostic.blockedEntryQuestionIds, c.diagnostic.questionIds.filter(id => !eligible.includes(id)))
    || !sameIds(c.teachingInput.items.map(t => t.itemId), skills)
    || !sameIds(c.planInput.items.map(t => t.requirementKey), skills) || !sameIds(c.coverage.map(t => t.skillId), skills)
    || qs.some(q => {
      const excluded = [...(!q.authorDiagnosticEligible ? ["author_excluded"] : []),
        ...(q.mappingStatus === "needs-visual-check" ? ["unverified_formula_or_layout"] : [])];
      return !skills.includes(q.primarySkillId) || q.secondarySkillIds.some(id => !skills.includes(id))
        || new Set([q.primarySkillId, ...q.secondarySkillIds]).size !== q.secondarySkillIds.length + 1 || !c.topics.includes(q.topic)
        || q.sourceRef.file !== q.sourceFile || q.sourceRef.page !== q.physicalPage || !validCitation(q.sourceRef)
        || q.externalSkillRefs.length !== 0 || q.unverifiedFormula !== (q.mappingStatus === "needs-visual-check")
        || !same(q.diagnosticExclusionReasons, excluded) || q.diagnosticEligible !== (excluded.length === 0)
        || q.authorDiagnosticEligible !== (q.assessmentReadiness === "requires-answer-key-and-exposure-check" && q.bktAdmission !== false)
        || q.diagnosticEntryCandidate !== (c.diagnostic.questionIds.includes(q.id) && q.diagnosticEligible)
        || q.supplementalDiagnosticCandidate !== (c.diagnostic.declaredConstructedResponseCandidates.includes(q.id) && q.diagnosticEligible);
    })
    || rows.some((r, i) => {
      const teaching = c.teachingInput.items.find(t => t.itemId === r.externalSkillId)!;
      const plan = c.planInput.items.find(t => t.requirementKey === r.externalSkillId)!;
      const coverage = c.coverage.find(t => t.skillId === r.externalSkillId)!;
      if (!teaching || !plan || !coverage) return true;
      const mapped = qs.filter(q => q.primarySkillId === r.externalSkillId || q.secondarySkillIds.includes(r.externalSkillId)).map(q => q.id);
      const selected = mapped.filter(id => eligible.includes(id));
      return r.requirementKey !== r.externalSkillId || r.position !== i || r.externalPrerequisites.length !== 0
        || !same(r.conceptBridges, bridges.filter(b => b.targetSkillId === r.externalSkillId))
        || !r.sourceRefs.every(validCitation) || new Set(r.prerequisiteSkillIds).size !== r.prerequisiteSkillIds.length
        || r.prerequisiteSkillIds.some(id => !order.has(id) || order.get(id)! >= order.get(r.externalSkillId)!)
        || !same(r.verification, { kind: "unavailable", status: "needs_check", exerciseKeys: mapped, rubric: null,
          missingReasons: ["mapping_only_no_prompt_or_answer", "mathematics_unverified"] })
        || !sameIds(r.diagnosticQuestionIds, selected) || !same(teaching.sourceRefs, r.sourceRefs)
        || teaching.title !== r.title || !same(teaching.prereqItemIds, r.prerequisiteSkillIds) || teaching.sourceIds.length !== 0
        || !same(teaching.intendedBlockTypes, ["text"]) || plan.title !== r.title || plan.skillLabel !== r.title
        || plan.deadlineAt !== c.deadlineAt || !sameIds(plan.diagnosticQuestionIds, selected)
        || !sameIds(coverage.questionIds, mapped) || !sameIds(coverage.diagnosticQuestionIds, selected)
        || !same(coverage.gaps, c.coverageGaps.filter(g => g.skillId === r.externalSkillId));
    });
  if (invalid) throw new Error("Inconsistent offline candidate projections");
  return c;
}

const scopeSchema = z.object({ ownerUserId: z.string().uuid(), courseId: z.string().uuid(), routeVersion: version, teachingVersion: version }).strict();
const planBindingSchema = z.object({ draft: planDraftSchema, accept: acceptPlanInputSchema }).strict();
const diagnosticBindingSchema = z.object({ start: courseRouteStartSchema, problem: problemRefSchema, key: privateTrustedQuestionKeySchema }).strict();
const bindingsSchema = z.object({ scope: scopeSchema.optional(), route: z.unknown().optional(), plan: z.unknown().optional(),
  questions: z.array(z.object({ questionId: key, diagnostic: z.unknown().optional(), scoring: z.unknown().optional() }).strict()).optional(),
}).strict();
type Scope = z.infer<typeof scopeSchema>;
type VerifiedPayloads = { route_submission: z.infer<typeof courseRouteConfirmSchema>; plan_submission: z.infer<typeof planBindingSchema>;
  diagnostic_execution: z.infer<typeof diagnosticBindingSchema>; scoring: z.infer<typeof privateTrustedQuestionKeySchema> };
export type MaterialBindingVerificationRequest = { [P in keyof VerifiedPayloads]: {
  purpose: P; externalQuestionId: string | null; candidate: Candidate; scope: Scope; asOf: string; payload: VerifiedPayloads[P];
} }[keyof VerifiedPayloads];
export type MaterialReadinessAuthority = {
  /** Trusted host clock snapshot for THIS assessment, not a package/client date or a validity claim.
   * Missing/invalid time fails closed. Host must check current state at this time and revalidate
   * at the actual write/execute boundary; this offline report is not a reusable authorization. */
  asOf: string;
  /** Trusted server dependency, never JSON/client flags. Must resolve owner, current course/versions,
   * PDF bytes/pages, exact immutable prompt/answer/evaluator receipts and package correspondence.
   * Diagnostic also requires goal/requirement revisions, available supply and exposure checks;
   * plan requires persisted draft, authorized task identities, budget/slots and accept selection.
   * Parsed postAttemptMetadata and author review labels are untrusted feedback, not authenticated
   * evidence of mathematical truth, answer keys, scoring receipts or learner mastery.
   * Compare EVERY supplied field (including optional task/version, revisions, conditions/figures,
   * exact key/receipt/evaluator version, plan date/selection/budget) with independently resolved
   * current host records for this purpose, external question, owner/course/versions and asOf.
   * A stale/revoked/expired/missing or mismatching binding must return false; never cache a true
   * result across purposes, questions, times or versions. Whole-item verification grants no
   * per-skill/part mastery. No host producer/authentication is implemented in this domain module.
   * No default resolver; schema-valid UUIDs, text review and source IDs do not prove any of this. */
  verifyBinding: (request: MaterialBindingVerificationRequest) => boolean;
};
export type MaterialSchemaCheck = { schema: string; valid: boolean; issues: { path: string; code: string }[] };
export type MaterialReadiness = { status: "ready" | "not_ready"; available: string[]; blockers: string[];
  manualBindings: string[]; schemaChecks: MaterialSchemaCheck[] };
export type MaterialCoursePackageReadinessReport = {
  kind: "material_course_package_readiness";
  preview: { status: "available"; skills: number; questions: number; coverageExhaustive: false };
  routeSubmission: MaterialReadiness; planSubmission: MaterialReadiness; import: MaterialReadiness;
  requirements: { externalSkillId: string; routeCheck: MaterialSchemaCheck; planCheck: MaterialSchemaCheck }[];
  questions: { questionId: string; mappedSkillIds: string[]; diagnosticCandidate: boolean;
    diagnostic: MaterialReadiness; scoring: MaterialReadiness; bkt: MaterialReadiness }[];
  permissions: { writesPerformed: false; publicationAuthorized: false; scoringAuthorized: false; bktUpdateAuthorized: false };
};
function check(schema: z.ZodType, name: string, input: unknown): MaterialSchemaCheck {
  const r = schema.safeParse(input);
  return { schema: name, valid: r.success, issues: r.success ? [] : r.error.issues.map(i => ({ path: i.path.join("."), code: i.code })) };
}
function readiness(available: string[], blockers: string[], manualBindings: string[], schemaChecks: MaterialSchemaCheck[] = []): MaterialReadiness {
  return { status: blockers.length ? "not_ready" : "ready", available, blockers, manualBindings, schemaChecks };
}
const sameIds = (a: string[], b: string[]) => a.length === b.length && new Set(a).size === a.length && a.every(id => b.includes(id));
const familyIsNotSource = (k: z.infer<typeof privateTrustedQuestionKeySchema>) => k.verification.kind !== "independent_family"
  || !k.identity.sourceRefs.some(s => s.sourceId === (k.verification.kind === "independent_family" ? k.verification.familyId : ""));

/** Pure offline readiness gate, not an importer or authorization endpoint. Independent, complete
 * bindings can ready only their capability. No runtime BKT evidence is manufactured here.
 * The private input may contain stems/keys; the report never projects those contents. */
export function assessMaterialCoursePackageReadiness(input: unknown, bindingInput: unknown = {}, authority?: MaterialReadinessAuthority): MaterialCoursePackageReadinessReport {
  const candidate = parseCandidate(input);
  const bindings = bindingsSchema.parse(bindingInput);
  const skills = candidate.routeInput.requirements.map(r => r.externalSkillId);
  const ids = candidate.questionMappings.map(q => q.id);
  if (bindings.questions && (new Set(bindings.questions.map(q => q.questionId)).size !== bindings.questions.length
    || bindings.questions.some(q => !ids.includes(q.questionId)))) throw new Error("Unknown or duplicate question binding");
  const scope = bindings.scope;
  type Request = { [P in keyof VerifiedPayloads]: Omit<Extract<MaterialBindingVerificationRequest, { purpose: P }>, "candidate" | "scope" | "asOf"> }[keyof VerifiedPayloads];
  const authorityTime = z.string().datetime({ offset: true }).safeParse(authority?.asOf);
  const scopeConflict = scope && (["ownerUserId", "courseId", "routeVersion", "teachingVersion"] as const)
    .some(field => candidate[field] !== null && candidate[field] !== scope[field]);
  const authorityGaps = [
    ...(!authority ? ["trusted_host_verifier_unavailable"] : []),
    ...(!scope ? ["runtime_owner_course_version_scope_missing"] : []),
    ...(authority && !authorityTime.success ? ["trusted_host_assessment_time_missing_or_invalid"] : []),
    ...(scopeConflict ? ["candidate_runtime_scope_conflict"] : []),
  ];
  const trusted = (request: Request) => {
    if (!scope || !authority || !authorityTime.success || scopeConflict) return false;
    return authority.verifyBinding({ ...request, candidate, scope, asOf: authorityTime.data }) === true;
  };
  const requirements = candidate.routeInput.requirements.map((row, i) => ({ externalSkillId: row.externalSkillId,
    routeCheck: check(courseRouteRequirementInputSchema, "courseRouteRequirementInputSchema", row),
    planCheck: check(suggestedTaskSchema, "suggestedTaskSchema", candidate.planInput.items[i]),
  }));
  const routeCheck = check(courseRouteConfirmSchema, "courseRouteConfirmSchema", bindings.route);
  const route = courseRouteConfirmSchema.safeParse(bindings.route);
  const routeMatches = route.success && sameIds(route.data.requirements.map(r => r.requirementKey), skills)
    && route.data.requirements.every(r => {
      const original = candidate.routeInput.requirements.find(o => o.requirementKey === r.requirementKey)!;
      const byId = new Map(route.data.requirements.map(item => [item.id, item.requirementKey]));
      return r.title === original.title && r.position === original.position
        && sameIds(r.prerequisiteIds.map(id => byId.get(id) ?? ""), original.prerequisiteSkillIds);
    });
  const routeSubmission = readiness(["offline_requirement_preview", "domain_contract_only_not_host_authentication"], [
    ...authorityGaps,
    ...(!routeCheck.valid ? ["missing_or_invalid_route_confirmation"] : []),
    ...(route.success && !routeMatches ? ["route_package_binding_mismatch"] : []),
    ...(!(routeMatches && trusted({ purpose: "route_submission", payload: route.data, externalQuestionId: null })) ? ["independent_scope_source_version_binding_required"] : []),
  ], ["ownerUserId/courseId/routeVersion/teachingVersion", "requirements.id/stableSkillId/mandatory/origin/goals/prerequisiteIds/sourceRefs",
    "expectedRevisions/confirmScope"], [routeCheck]);
  const planCheck = check(planBindingSchema, "planDraftSchema+acceptPlanInputSchema", bindings.plan);
  const plan = planBindingSchema.safeParse(bindings.plan);
  const planMatches = plan.success && plan.data.draft.status === "draft" && plan.data.accept.draftId === plan.data.draft.id
    && plan.data.accept.expectedBaseVersion === plan.data.draft.baseVersion && !!plan.data.draft.suggestedTasks?.length
    && new Set(plan.data.draft.suggestedTasks.map(t => t.key)).size === plan.data.draft.suggestedTasks.length
    && new Set(plan.data.draft.suggestedTasks.map(t => t.id)).size === plan.data.draft.suggestedTasks.length
    && plan.data.draft.suggestedTasks.every(t => t.courseId === scope?.courseId && !!t.requirementKey && skills.includes(t.requirementKey))
    && (plan.data.accept.acceptSuggestedKeys === undefined || (plan.data.accept.acceptSuggestedKeys.length > 0
      && new Set(plan.data.accept.acceptSuggestedKeys).size === plan.data.accept.acceptSuggestedKeys.length
      && plan.data.accept.acceptSuggestedKeys.every(k => plan.data.draft.suggestedTasks!.some(t => t.key === k))));
  const planSubmission = readiness(["offline_unscheduled_plan_preview", "domain_contract_only_not_host_authentication"], [
    ...authorityGaps,
    ...(!planCheck.valid ? ["missing_or_invalid_draft_and_accept_contract"] : []),
    ...(plan.success && !planMatches ? ["plan_package_binding_mismatch"] : []),
    ...(!(planMatches && trusted({ purpose: "plan_submission", payload: plan.data, externalQuestionId: null })) ? ["independent_persisted_draft_scope_budget_binding_required"] : []),
  ], ["owner/course/versions", "draft.id/date/version/baseVersion/blocks/taskIds", "suggestedTasks.key/id/kind/minutes/reasonCode/reason",
    "confirmed_budget_and_slots", "accept.draftId/expectedBaseVersion/clientKey/acceptSuggestedKeys"], [planCheck]);
  const questions = candidate.questionMappings.map(q => {
    const binding = bindings.questions?.find(b => b.questionId === q.id);
    const diagnosticCheck = check(diagnosticBindingSchema, "courseRouteStartSchema+problemRefSchema+privateTrustedQuestionKeySchema", binding?.diagnostic);
    const diagnostic = diagnosticBindingSchema.safeParse(binding?.diagnostic);
    const scoringCheck = check(privateTrustedQuestionKeySchema, "privateTrustedQuestionKeySchema", binding?.scoring);
    const scoring = privateTrustedQuestionKeySchema.safeParse(binding?.scoring);
    const common = [...(q.unverifiedFormula || q.assessmentReadiness === "blocked-visual-check" ? ["visual_verification_required"] : []),
      ...(q.assessmentReadiness === "blocked-author-exclusion" || q.assessmentReadiness === false ? ["material_dispute_unresolved"] : [])];
    const ref = diagnostic.success ? diagnostic.data.key.identity.questionRef : null;
    const diagnosticMatches = diagnostic.success && diagnostic.data.problem.artifactKind === "reference_item"
      && diagnostic.data.problem.physicalPage === q.physicalPage && ref?.kind === "source_problem"
      && ref.problemId === diagnostic.data.problem.problemId && ref.sourceId === diagnostic.data.problem.sourceId
      && ref.sourceVersion === diagnostic.data.problem.sourceVersion && familyIsNotSource(diagnostic.data.key);
    return { questionId: q.id, mappedSkillIds: [q.primarySkillId, ...q.secondarySkillIds], diagnosticCandidate: q.diagnosticEntryCandidate,
      diagnostic: readiness(["question_mapping_preview", "domain_contract_only_not_host_authentication"], [...common, ...authorityGaps,
        ...(!q.diagnosticEligible ? ["mapping_excluded_from_diagnostic"] : []),
        ...(!diagnosticCheck.valid ? ["missing_or_invalid_diagnostic_contract_and_key"] : []),
        ...(diagnostic.success && !diagnosticMatches ? ["diagnostic_identity_or_family_mismatch"] : []),
        ...(!(common.length === 0 && q.diagnosticEligible && diagnosticMatches && trusted({ purpose: "diagnostic_execution", payload: diagnostic.data, externalQuestionId: q.id }))
          ? ["independent_prompt_answer_route_revision_and_exposure_binding_required"] : []),
      ], ["immutable_prompt_and_trusted_answer_key", "owner/course/versions", "goal/requirement/revisions", "PDF/problem/identity", "exposure_and_available_supply"], [diagnosticCheck]),
      scoring: readiness(["mapping_is_not_scoring_truth", "exact_question_only_no_multi_skill_credit", "domain_contract_only_not_host_authentication"], [...common, ...authorityGaps,
        ...(!scoringCheck.valid ? ["missing_or_invalid_trusted_key"] : []),
        ...(scoring.success && !familyIsNotSource(scoring.data) ? ["source_id_is_not_family_identity"] : []),
        ...(!(common.length === 0 && scoring.success && familyIsNotSource(scoring.data) && trusted({ purpose: "scoring", payload: scoring.data, externalQuestionId: q.id }))
          ? ["independent_exact_key_evaluator_or_family_binding_required"] : []),
      ], ["immutable_question_identity", "verified_answer_key", "deterministic_evaluator_or_independent_family_receipt"], [scoringCheck]),
      bkt: readiness(["mapped_skill_labels_only"], ["runtime_qualified_attempt_required", "canonical_family_and_exposure_required",
        ...(q.secondarySkillIds.length ? ["part_level_evidence_missing_no_multi_skill_credit"] : [])],
      ["saved_attempt/outcome/assistance", "course_requirement_versions", "canonical_family/exposure", "pre_answer_prediction",
        "retraction_dependencies", "reliable_part_bindings_if_composite"]),
    };
  });
  return { kind: "material_course_package_readiness", preview: { status: "available", skills: skills.length, questions: questions.length, coverageExhaustive: false },
    routeSubmission, planSubmission, import: readiness(["offline_preview_only"], ["no_material_package_import_contract", "route_confirmation_is_not_package_import"],
      ["existing_authorized_publication_workflow"]), requirements, questions,
    permissions: { writesPerformed: false, publicationAuthorized: false, scoringAuthorized: false, bktUpdateAuthorized: false } };
}
