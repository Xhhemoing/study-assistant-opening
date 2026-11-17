import { z } from "zod";
import type { CourseRouteRequirementInput, SuggestedTask } from "@aistudy/contracts";
import type { TeachingOutlineItem } from "./teaching-plan";

/** Known cross-chapter references in the real Topic 4–5 partial delivery. */
export const MIDTERM_PENDING_PREREQUISITE_IDS = [
  "t1-algebra-functions", "t2-sequence-limits", "t2-function-limits", "t2-continuity", "t3-derivatives", "t3-taylor",
] as const;

const key = z.string().trim().min(1).max(200);
const text = z.string().trim().min(1).max(20000);
const version = z.number().int().nonnegative();
const sourceRefSchema = z.object({ sourceKey: key, page: z.number().int().positive() }).strict();
const sourceSchema = z.object({
  sourceKey: key, title: key, pdfSha256: z.string().regex(/^[a-fA-F0-9]{64}$/),
  pageCount: z.number().int().positive(), sourceId: z.string().uuid().nullable(), sourceVersion: version.nullable(),
}).strict().refine(s => (s.sourceId === null) === (s.sourceVersion === null), "Source identity and version must be bound together");
const promptSchema = z.object({ role: z.literal("prompt"), text, sourceRefs: z.array(sourceRefSchema).min(1), unverifiedFormula: z.boolean() }).strict();
const answerSchema = z.object({ role: z.literal("answer_key"), text, sourceRefs: z.array(sourceRefSchema).min(1), unverifiedFormula: z.boolean() }).strict();

/** External JSON boundary; these are external keys, never database identities. */
export const materialCoursePackageSchema = z.object({
  schemaVersion: z.literal(1), packageId: key, packageVersion: key, title: key,
  provenance: z.enum(["source_material", "synthetic_adapter_unit_fixture"]),
  sources: z.array(sourceSchema).min(1),
  topics: z.array(z.object({ topicId: key, title: key }).strict()).min(1),
  skills: z.array(z.object({
    skillId: key, topicId: key, title: key, mandatory: z.boolean(),
    prerequisiteSkillIds: z.array(key), sourceRefs: z.array(sourceRefSchema).min(1),
    diagnosticQuestionIds: z.array(key),
  }).strict()).min(1),
  questions: z.array(z.object({
    questionId: key, topicId: key, skillIds: z.array(key).min(1),
    contentKind: z.enum(["question", "description"]), prompt: promptSchema, answer: answerSchema.nullable(),
  }).strict()),
}).strict().superRefine((value, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  for (const [name, ids] of [
    ["sources", value.sources.map(s => s.sourceKey)], ["topics", value.topics.map(t => t.topicId)],
    ["skills", value.skills.map(s => s.skillId)], ["questions", value.questions.map(q => q.questionId)],
  ] as const) if (new Set(ids).size !== ids.length) issue([name], "Duplicate external identity");
  const sources = new Map(value.sources.map(s => [s.sourceKey, s]));
  const topics = new Set(value.topics.map(t => t.topicId));
  const skills = new Map(value.skills.map(s => [s.skillId, s]));
  const questions = new Map(value.questions.map(q => [q.questionId, q]));
  const refs = (items: z.infer<typeof sourceRefSchema>[], path: (string | number)[]) => {
    items.forEach((ref, i) => {
      const source = sources.get(ref.sourceKey);
      if (!source || ref.page > source.pageCount) issue([...path, i], "Unknown PDF or page outside PDF");
    });
  };
  value.skills.forEach((skill, i) => {
    if (!topics.has(skill.topicId)) issue(["skills", i, "topicId"], "Unknown topic");
    refs(skill.sourceRefs, ["skills", i, "sourceRefs"]);
    if (new Set(skill.prerequisiteSkillIds).size !== skill.prerequisiteSkillIds.length) issue(["skills", i, "prerequisiteSkillIds"], "Duplicate prerequisite");
    for (const id of skill.prerequisiteSkillIds) if (id === skill.skillId || !skills.has(id)) issue(["skills", i, "prerequisiteSkillIds"], "Unknown or self prerequisite");
    if (new Set(skill.diagnosticQuestionIds).size !== skill.diagnosticQuestionIds.length) issue(["skills", i, "diagnosticQuestionIds"], "Duplicate diagnostic");
    for (const id of skill.diagnosticQuestionIds) {
      const q = questions.get(id);
      if (!q || !q.skillIds.includes(skill.skillId) || q.contentKind !== "question") issue(["skills", i, "diagnosticQuestionIds"], "Diagnostic must reference an actual question for this skill");
    }
  });
  value.questions.forEach((q, i) => {
    if (!topics.has(q.topicId)) issue(["questions", i, "topicId"], "Unknown topic");
    if (new Set(q.skillIds).size !== q.skillIds.length) issue(["questions", i, "skillIds"], "Duplicate skill");
    for (const id of q.skillIds) if (!skills.has(id)) issue(["questions", i, "skillIds"], "Unknown skill");
    refs(q.prompt.sourceRefs, ["questions", i, "prompt", "sourceRefs"]);
    if (q.answer) refs(q.answer.sourceRefs, ["questions", i, "answer", "sourceRefs"]);
  });
  // Reject cyclic prerequisite graphs instead of silently inventing an ordering.
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    for (const parent of skills.get(id)?.prerequisiteSkillIds ?? []) if (!visit(parent)) return false;
    visiting.delete(id); visited.add(id); return true;
  };
  for (const id of skills.keys()) if (!visit(id)) { issue(["skills"], "Cyclic prerequisites"); break; }
});

export type MaterialCoursePackage = z.infer<typeof materialCoursePackageSchema>;
const optionsSchema = z.object({
  // Required even when unknown. No implicit exam date or seven-day schedule.
  deadlineAt: z.string().datetime({ offset: true }).nullable(),
  ownerUserId: z.string().uuid().nullable().optional(), courseId: z.string().uuid().nullable().optional(),
  routeVersion: version.nullable().optional(), teachingVersion: version.nullable().optional(),
}).strict();
export type MaterialCoursePackageOptions = z.infer<typeof optionsSchema>;

type SourceCitation = {
  sourceKey: string; pdfSha256: string; page: number; sourceId: string | null; sourceVersion: number | null;
};
type ProposedRequirement = Pick<CourseRouteRequirementInput, "requirementKey" | "title" | "position" | "mandatory" | "verification" | "origin"> & {
  id: null; stableSkillId: null; knowledgeNodeId: null; goalIds: []; prerequisiteIds: null;
  externalSkillId: string; prerequisiteSkillIds: string[]; sourceRefs: SourceCitation[];
};
type ProposedTeachingItem = Omit<TeachingOutlineItem, "sourceIds" | "goalIds"> & {
  sourceIds: string[]; goalIds: []; sourceRefs: SourceCitation[];
};
type ProposedPlanItem = Pick<SuggestedTask, "title" | "skillLabel" | "requirementKey" | "reasonCode" | "reason"> & {
  id: null; minutes: null; deadlineAt: string | null; diagnosticQuestionIds: string[];
};

/**
 * Pure offline conversion, not an import, confirmation, grader or learner observation.
 * Format/provenance validation cannot verify PDF bytes, mathematical truth or ownership.
 * Private answer keys are separate from learner prompts; do not send the whole result to a client.
 */
export function adaptMaterialCoursePackage(input: unknown, options: MaterialCoursePackageOptions) {
  const pack = materialCoursePackageSchema.parse(input);
  const context = optionsSchema.parse(options);
  const sources = new Map(pack.sources.map(source => [source.sourceKey, source]));
  const citations = (refs: z.infer<typeof sourceRefSchema>[]): SourceCitation[] => refs.map(ref => {
    const source = sources.get(ref.sourceKey)!;
    return { ...ref, pdfSha256: source.pdfSha256, sourceId: source.sourceId, sourceVersion: source.sourceVersion };
  });
  const requirements: ProposedRequirement[] = pack.skills.map((skill, position) => {
    const questions = pack.questions.filter(q => q.skillIds.includes(skill.skillId));
    const actual = questions.filter(q => q.contentKind === "question");
    const allRefs = [...skill.sourceRefs, ...questions.flatMap(q => [...q.prompt.sourceRefs, ...(q.answer?.sourceRefs ?? [])])];
    const sourceRefs = allRefs.filter((ref, index) => allRefs.findIndex(other => other.sourceKey === ref.sourceKey && other.page === ref.page) === index);
    const missingReasons = ["offline_candidate_not_math_or_learner_verification"];
    if (!actual.length) missingReasons.push("no_actual_question");
    if (!skill.diagnosticQuestionIds.length) missingReasons.push("no_diagnostic_question");
    if (actual.some(q => !q.answer)) missingReasons.push("missing_reference_answer");
    if (questions.some(q => q.prompt.unverifiedFormula || q.answer?.unverifiedFormula)) missingReasons.push("unverified_formula");
    if (sourceRefs.some(ref => sources.get(ref.sourceKey)!.sourceId === null)) missingReasons.push("unbound_source");
    return {
      id: null, stableSkillId: null, knowledgeNodeId: null, goalIds: [], prerequisiteIds: null,
      externalSkillId: skill.skillId, prerequisiteSkillIds: skill.prerequisiteSkillIds,
      requirementKey: skill.skillId, title: skill.title, position, mandatory: skill.mandatory, origin: "extracted",
      sourceRefs: citations(sourceRefs),
      verification: { kind: "unavailable", status: "needs_check", exerciseKeys: actual.map(q => q.questionId), rubric: null, missingReasons },
    };
  });
  const teachingItems: ProposedTeachingItem[] = pack.skills.map(skill => ({
    itemId: skill.skillId, title: skill.title, goalIds: [], prereqItemIds: skill.prerequisiteSkillIds,
    intendedBlockTypes: ["text", "prompt"], sourceIds: [...new Set(skill.sourceRefs.flatMap(ref => sources.get(ref.sourceKey)!.sourceId ?? []))],
    sourceRefs: citations(skill.sourceRefs), notes: "Proposed outline only; content and formula verification pending.",
  }));
  const planItems: ProposedPlanItem[] = pack.skills.map(skill => ({
    id: null, title: skill.title, skillLabel: skill.title, requirementKey: skill.skillId, minutes: null,
    deadlineAt: context.deadlineAt, diagnosticQuestionIds: skill.diagnosticQuestionIds,
    reasonCode: "new_skill", reason: "Proposed diagnostic; no learner measurement supplied.",
  }));
  return {
    kind: "material_course_package_candidate" as const, status: "proposed" as const,
    packageId: pack.packageId, packageVersion: pack.packageVersion, title: pack.title, provenance: pack.provenance,
    ownerUserId: context.ownerUserId ?? null, courseId: context.courseId ?? null,
    routeVersion: context.routeVersion ?? null, teachingVersion: context.teachingVersion ?? null,
    deadlineAt: context.deadlineAt, sources: pack.sources, topics: pack.topics,
    routeInput: { status: "proposed" as const, requirements }, teachingInput: { status: "proposed" as const, items: teachingItems },
    planInput: { status: "proposed" as const, items: planItems },
    learnerPrompts: pack.questions.map(q => ({ questionId: q.questionId, topicId: q.topicId, skillIds: q.skillIds, contentKind: q.contentKind,
      role: q.prompt.role, text: q.prompt.text, sourceRefs: citations(q.prompt.sourceRefs), unverifiedFormula: q.prompt.unverifiedFormula })),
    privateAnswerKeys: pack.questions.flatMap(q => q.answer ? [{ questionId: q.questionId, role: q.answer.role, text: q.answer.text,
      sourceRefs: citations(q.answer.sourceRefs), unverifiedFormula: q.answer.unverifiedFormula }] : []),
    coverage: pack.skills.map(skill => {
      const questions = pack.questions.filter(q => q.skillIds.includes(skill.skillId) && q.contentKind === "question");
      return { skillId: skill.skillId, questionIds: questions.map(q => q.questionId), diagnosticQuestionIds: skill.diagnosticQuestionIds,
        withReferenceAnswers: questions.filter(q => q.answer).length,
        unverifiedFormulaQuestionIds: questions.filter(q => q.prompt.unverifiedFormula || q.answer?.unverifiedFormula).map(q => q.questionId),
        measurementStatus: "untested" as const, independentEligibility: "unknown" as const };
    }),
    factualSupport: "unverified" as const,
  };
}

const mappingStatus = z.enum(["text-reviewed", "needs-visual-check"]);
const topicNumber = z.number().int().positive();
/** Actual author delivery: question metadata only, not question/answer body text. */
export const materialCourseMappingPackageSchema = z.object({
  schemaVersion: z.literal(1), topics: z.array(topicNumber).min(1),
  skills: z.array(z.object({
    id: key, title: key, topic: topicNumber, prerequisiteIds: z.array(key), learningObjectives: z.array(text), commonErrors: z.array(text),
    sourceRefs: z.array(z.object({ file: key, physicalPages: z.array(z.number().int().positive()).min(1), verification: mappingStatus }).strict()).min(1),
  }).strict()).min(1),
  questions: z.array(z.object({
    id: key, topic: topicNumber, kind: z.enum(["Test", "Problems"]), number: z.number().int().positive(), sourceFile: key,
    physicalPage: z.number().int().positive(), primarySkillId: key, secondarySkillIds: z.array(key),
    evidenceType: z.enum(["objective-choice", "constructed-response"]), mappingStatus, diagnosticEligible: z.boolean(), notes: text,
  }).strict()),
  verificationScope: text, sourceResolution: text,
  coverageGaps: z.array(z.object({ skillId: key, scope: text, candidateSource: text }).strict()),
}).strict();

export type MaterialCourseMappingPackage = z.infer<typeof materialCourseMappingPackageSchema>;

const mappingOptionsSchema = optionsSchema.extend({
  validationScope: z.enum(["partial", "complete"]),
  expectedQuestionCount: z.number().int().positive().optional(),
  sourceManifest: z.array(z.object({
    file: key, pdfSha256: z.string().regex(/^[a-fA-F0-9]{64}$/), pageCount: z.number().int().positive(),
    sourceId: z.string().uuid().nullable(), sourceVersion: version.nullable(),
  }).strict().refine(s => (s.sourceId === null) === (s.sourceVersion === null), "Source identity and version must be bound together")).optional(),
}).strict().refine(o => o.validationScope !== "complete" || o.expectedQuestionCount !== undefined, "Complete validation requires expectedQuestionCount");
export type MaterialCourseMappingOptions = z.infer<typeof mappingOptionsSchema>;

const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/);
// Current full package intentionally does NOT accept legacy notes/diagnosticEligible.
const fullQuestionSchema = materialCourseMappingPackageSchema.shape.questions.element.omit({ notes: true, diagnosticEligible: true }).extend({
  postAttemptNotes: text,
  assessmentReadiness: z.union([z.enum(["requires-answer-key-and-exposure-check", "blocked-visual-check", "blocked-author-exclusion"]), z.literal(false)]),
  bktAdmission: z.union([z.literal("requires-runtime-evidence-qualification"), z.literal(false)]),
}).strict();
export const materialCourseFullPackageSchema = z.object({
  schemaVersion: z.literal(1), status: z.literal("offline-candidate-not-imported"), sourceManifestSha256: sha256, questionIndexSha256: sha256,
  mappingFiles: z.array(z.object({ file: key, sha256 }).strict()),
  sources: z.array(z.object({ file: key, physicalPages: z.number().int().positive(), sha256 }).strict()).min(1),
  skills: materialCourseMappingPackageSchema.shape.skills, prerequisiteOrder: z.array(key), questions: z.array(fullQuestionSchema),
  diagnostic: z.object({ status: z.literal("candidate-not-administered"), source: text, questionIds: z.array(key),
    constructedResponseCandidates: z.array(key), conditions: z.array(text) }).strict(),
  bktBoundary: z.object({ model: z.literal("existing-classical-bkt"), calibrated: z.literal(false), learnerStateCreated: z.literal(false),
    policy: text, requiredRuntimeChecks: z.array(text), constructedResponsePolicy: text, familyPolicy: text, feedbackPolicy: text }).strict(),
  schedule: z.object({ productTarget: text, latestProductUseDate: text, actualExamDate: z.string().nullable(),
    dailyStudyMinutes: z.number().int().positive().nullable(), policy: text,
    unmeasuredPrerequisitePolicy: z.literal("teach-bridge-without-mastery-credit"), unmeasuredSkillIds: z.array(key) }).strict(),
  coverageGaps: materialCourseMappingPackageSchema.shape.coverageGaps, coverageGapNotes: z.array(text),
  validation: z.object({ sourcePdfs: z.number().int().nonnegative(), questionCount: z.number().int().nonnegative(), skillCount: z.number().int().nonnegative(),
    textMappedCount: z.number().int().nonnegative(), visualCheckRequired: z.array(key), disputedDiagnosticExclusions: z.array(key),
    semanticMathVerification: z.literal("not-complete"), runtimeCoursePublication: z.literal("not-verified") }).strict(),
}).strict();
export type MaterialCourseFullPackage = z.infer<typeof materialCourseFullPackageSchema>;

/**
 * Adapt real author mappings without synthesizing missing PDF hashes, prompt text or answers.
 * diagnosticEligible means only a mapping candidate; no scoring/independence authorization.
 * A partial mapping is usable offline while declared cross-chapter prerequisites remain pending.
 */
export function adaptMaterialCourseMappingPackage(input: unknown, options: MaterialCourseMappingOptions) {
  const pack = materialCourseMappingPackageSchema.parse(input);
  const context = mappingOptionsSchema.parse(options);
  const skills = new Map(pack.skills.map(s => [s.id, s]));
  const topics = new Set(pack.topics);
  const manifest = new Map((context.sourceManifest ?? []).map(s => [s.file, s]));
  const errors: string[] = [];
  for (const [label, ids] of [["topics", pack.topics], ["skills", pack.skills.map(s => s.id)], ["questions", pack.questions.map(q => q.id)],
    ["manifest", (context.sourceManifest ?? []).map(s => s.file)]] as const) {
    if (new Set<string | number>(ids).size !== ids.length) errors.push(`Duplicate ${label}`);
  }
  const pending = new Set<string>();
  for (const skill of pack.skills) {
    if (!topics.has(skill.topic)) errors.push(`Unknown topic for ${skill.id}`);
    if (new Set(skill.prerequisiteIds).size !== skill.prerequisiteIds.length) errors.push(`Duplicate prerequisites for ${skill.id}`);
    for (const id of skill.prerequisiteIds) {
      if (id === skill.id) errors.push(`Self prerequisite ${id}`);
      if (!skills.has(id)) {
        if (context.validationScope === "partial" && MIDTERM_PENDING_PREREQUISITE_IDS.some(known => known === id)) pending.add(id);
        else errors.push(`Unresolved prerequisite ${id}`);
      }
    }
  }
  const visited = new Set<string>(), active = new Set<string>();
  const visit = (id: string): boolean => {
    if (active.has(id)) return false;
    if (visited.has(id)) return true;
    active.add(id);
    for (const parent of skills.get(id)?.prerequisiteIds ?? []) if (skills.has(parent) && !visit(parent)) return false;
    active.delete(id); visited.add(id); return true;
  };
  for (const id of skills.keys()) if (!visit(id)) { errors.push("Cyclic prerequisites"); break; }
  for (const q of pack.questions) {
    if (!topics.has(q.topic)) errors.push(`Unknown question topic ${q.id}`);
    const ids = [q.primarySkillId, ...q.secondarySkillIds];
    if (new Set(ids).size !== ids.length) errors.push(`Duplicate question skill ${q.id}`);
    for (const id of ids) if (!skills.has(id)) {
      if (context.validationScope === "partial" && MIDTERM_PENDING_PREREQUISITE_IDS.some(known => known === id)) pending.add(id);
      else errors.push(`Unknown question skill ${id}`);
    }
  }
  for (const gap of pack.coverageGaps) if (!skills.has(gap.skillId)) errors.push(`Unknown coverage gap skill ${gap.skillId}`);
  if (context.validationScope === "complete" && pack.questions.length !== context.expectedQuestionCount) errors.push("Incomplete question count");
  const refs = [
    ...pack.skills.flatMap(s => s.sourceRefs.flatMap(ref => ref.physicalPages.map(page => ({ file: ref.file, page })))),
    ...pack.questions.map(q => ({ file: q.sourceFile, page: q.physicalPage })),
  ];
  for (const ref of refs) if (manifest.has(ref.file) && ref.page > manifest.get(ref.file)!.pageCount) errors.push(`Page outside PDF ${ref.file}:${ref.page}`);
  if (errors.length) throw new Error(errors.join("; "));
  const citation = (file: string, page: number) => ({
    file, page, pdfSha256: manifest.get(file)?.pdfSha256 ?? null,
    sourceId: manifest.get(file)?.sourceId ?? null, sourceVersion: manifest.get(file)?.sourceVersion ?? null,
  });
  const questionMappings = pack.questions.map(q => {
    const exclusionReasons = [
      ...(!q.diagnosticEligible ? ["author_excluded"] : []),
      ...(q.mappingStatus === "needs-visual-check" ? ["unverified_formula_or_layout"] : []),
    ];
    return { ...q, sourceRef: citation(q.sourceFile, q.physicalPage),
      externalSkillRefs: [q.primarySkillId, ...q.secondarySkillIds].filter(id => pending.has(id)).map(skillId => ({ skillId, status: "pending" as const })),
      authorDiagnosticEligible: q.diagnosticEligible, diagnosticEligible: exclusionReasons.length === 0,
      diagnosticExclusionReasons: exclusionReasons, unverifiedFormula: q.mappingStatus === "needs-visual-check",
      prompt: null, answer: null, bodyStatus: "mapping_only" as const, mathematicalVerification: "unverified" as const,
      scoringEligible: false as const, independentEligibility: "unknown" as const };
  });
  const requirements = pack.skills.map((skill, position) => {
    const questions = questionMappings.filter(q => q.primarySkillId === skill.id || q.secondarySkillIds.includes(skill.id));
    const sourceRefs = skill.sourceRefs.flatMap(ref => ref.physicalPages.map(page => ({ ...citation(ref.file, page), mappingStatus: ref.verification })));
    const externalPrerequisites = skill.prerequisiteIds.filter(id => pending.has(id));
    return { id: null, stableSkillId: null, knowledgeNodeId: null, externalSkillId: skill.id, requirementKey: skill.id, title: skill.title,
      position, mandatory: null, goalIds: [], prerequisiteIds: null, prerequisiteSkillIds: skill.prerequisiteIds,
      externalPrerequisites: externalPrerequisites.map(id => ({ skillId: id, status: "pending" as const })), sourceRefs,
      verification: { kind: "unavailable" as const, status: "needs_check" as const, exerciseKeys: questions.map(q => q.id), rubric: null,
        missingReasons: ["mapping_only_no_prompt_or_answer", "mathematics_unverified", ...(externalPrerequisites.length ? ["external_prerequisites_pending"] : [])] },
      diagnosticQuestionIds: questions.filter(q => q.diagnosticEligible).map(q => q.id),
      measurementStatus: "untested" as const, independentEligibility: "unknown" as const };
  });
  const missingPdfHashes = [...new Set(refs.filter(ref => !manifest.has(ref.file)).map(ref => ref.file))];
  return {
    kind: "material_course_mapping_candidate" as const, status: "proposed" as const, published: false as const,
    ownerUserId: context.ownerUserId ?? null, courseId: context.courseId ?? null,
    routeVersion: context.routeVersion ?? null, teachingVersion: context.teachingVersion ?? null, deadlineAt: context.deadlineAt,
    validationScope: context.validationScope, coverageStatus: context.validationScope === "partial" || pending.size || pack.coverageGaps.length ? "partial" as const : "mapped" as const,
    topics: pack.topics, verificationScope: pack.verificationScope, sourceResolution: pack.sourceResolution,
    pendingExternalPrerequisites: [...pending].sort().map(skillId => ({ skillId, status: "pending" as const })), missingPdfHashes,
    completeness: { localSkills: pack.skills.length, mappedQuestions: pack.questions.length,
      expectedQuestionCount: context.expectedQuestionCount ?? null, pendingExternalSkills: pending.size,
      missingPdfHashes: missingPdfHashes.length, declaredCoverageGaps: pack.coverageGaps.length, bodyStatus: "mapping_only" as const },
    coverageGaps: pack.coverageGaps, questionMappings,
    routeInput: { status: "proposed" as const, requirements },
    teachingInput: { status: "proposed" as const, items: pack.skills.map((s, i) => ({ itemId: s.id, title: s.title, goalIds: [],
      prereqItemIds: s.prerequisiteIds, sourceIds: [...new Set(requirements[i]!.sourceRefs.flatMap(ref => ref.sourceId ?? []))],
      sourceRefs: requirements[i]!.sourceRefs, learningObjectives: s.learningObjectives, commonErrors: s.commonErrors, intendedBlockTypes: ["text"] })) },
    planInput: { status: "proposed" as const, items: requirements.map(r => ({ id: null, title: r.title, skillLabel: r.title,
      requirementKey: r.requirementKey, minutes: null, deadlineAt: context.deadlineAt, diagnosticQuestionIds: r.diagnosticQuestionIds })) },
    coverage: requirements.map(r => ({ skillId: r.externalSkillId, questionIds: r.verification.exerciseKeys, diagnosticQuestionIds: r.diagnosticQuestionIds,
      gaps: pack.coverageGaps.filter(g => g.skillId === r.externalSkillId), measurementStatus: "untested" as const, independentEligibility: "unknown" as const })),
    learnerPrompts: [], privateAnswerKeys: [], factualSupport: "unverified" as const,
  };
}

/** Full author package: strict references/order, but never runtime evidence admission. */
export function adaptMaterialCourseFullPackage(input: unknown, options: MaterialCoursePackageOptions) {
  const pack = materialCourseFullPackageSchema.parse(input);
  const context = optionsSchema.parse(options);
  const errors: string[] = [];
  const order = new Map(pack.prerequisiteOrder.map((id, index) => [id, index]));
  if (order.size !== pack.skills.length || order.size !== pack.prerequisiteOrder.length || pack.skills.some(s => !order.has(s.id))) errors.push("Invalid prerequisiteOrder denominator");
  for (const skill of pack.skills) for (const parent of skill.prerequisiteIds) {
    if (!order.has(parent) || order.get(parent)! >= order.get(skill.id)!) errors.push(`Invalid prerequisite order ${parent} -> ${skill.id}`);
  }
  const skillIds = new Set(pack.skills.map(s => s.id));
  if (new Set(pack.schedule.unmeasuredSkillIds).size !== pack.schedule.unmeasuredSkillIds.length) errors.push("Duplicate unmeasured skill");
  for (const id of pack.schedule.unmeasuredSkillIds) if (!skillIds.has(id)) errors.push(`Unknown unmeasured skill ${id}`);
  const sources = new Set(pack.sources.map(s => s.file));
  for (const file of [...pack.questions.map(q => q.sourceFile), ...pack.skills.flatMap(s => s.sourceRefs.map(ref => ref.file))]) {
    if (!sources.has(file)) errors.push(`Missing source manifest ${file}`);
  }
  const questions = new Map(pack.questions.map(q => [q.id, q]));
  if (pack.diagnostic.questionIds.length !== 20) errors.push("Full package requires the existing 20-item diagnostic entry");
  for (const ids of [pack.diagnostic.questionIds, pack.diagnostic.constructedResponseCandidates]) {
    if (new Set(ids).size !== ids.length) errors.push("Duplicate diagnostic identity");
    for (const id of ids) if (!questions.has(id)) errors.push(`Unknown diagnostic identity ${id}`);
  }
  const visual = pack.questions.filter(q => q.mappingStatus === "needs-visual-check").map(q => q.id);
  const disputed = pack.questions.filter(q => q.assessmentReadiness === "blocked-author-exclusion").map(q => q.id);
  const sameIds = (a: string[], b: string[]) => a.length === b.length && new Set(b).size === b.length && a.every(id => b.includes(id));
  if (pack.validation.sourcePdfs !== pack.sources.length || pack.validation.skillCount !== pack.skills.length || pack.validation.questionCount !== pack.questions.length
    || pack.validation.textMappedCount !== pack.questions.filter(q => q.mappingStatus === "text-reviewed").length
    || !sameIds(visual, pack.validation.visualCheckRequired) || !sameIds(disputed, pack.validation.disputedDiagnosticExclusions)) errors.push("Validation counts/identities mismatch");
  if (errors.length) throw new Error(errors.join("; "));
  const candidate = adaptMaterialCourseMappingPackage({
    schemaVersion: pack.schemaVersion, topics: [...new Set(pack.skills.map(s => s.topic))], skills: pack.skills,
    questions: pack.questions.map(({ assessmentReadiness, bktAdmission, postAttemptNotes, ...q }) => ({ ...q,
      notes: postAttemptNotes,
      diagnosticEligible: assessmentReadiness === "requires-answer-key-and-exposure-check" && bktAdmission !== false })),

    verificationScope: pack.validation.semanticMathVerification, sourceResolution: "Author source manifest PDF hashes; no database bindings", coverageGaps: pack.coverageGaps,
  }, { ...context, validationScope: "complete", expectedQuestionCount: 150,
    sourceManifest: pack.sources.map(s => ({ file: s.file, pdfSha256: s.sha256, pageCount: s.physicalPages, sourceId: null, sourceVersion: null })) });
  const questionMappings = candidate.questionMappings.map(q => {
    const original = questions.get(q.id)!;
    const { notes: _legacyNotes, ...mapping } = q;
    return { ...mapping, assessmentReadiness: original.assessmentReadiness, bktAdmission: original.bktAdmission,
      diagnosticEntryCandidate: pack.diagnostic.questionIds.includes(q.id) && q.diagnosticEligible,
      supplementalDiagnosticCandidate: pack.diagnostic.constructedResponseCandidates.includes(q.id) && q.diagnosticEligible,
      canonicalFamilyId: null, bktEligible: false as const, reliablePartScoring: "unverified" as const };
  });
  const selectedDiagnosticIds = questionMappings.filter(q => q.diagnosticEntryCandidate).map(q => q.id);
  const selected = new Set(selectedDiagnosticIds);
  const conceptBridges = pack.skills.flatMap(skill => skill.prerequisiteIds.map(prerequisiteSkillId => ({
    targetSkillId: skill.id, prerequisiteSkillId, action: "concept_bridge" as const,
    reason: pack.schedule.unmeasuredSkillIds.includes(prerequisiteSkillId) ? "declared_measurement_gap" as const : "no_learner_measurement" as const,
    measurementStatus: "untested" as const, skippable: true as const, requiredPass: false as const, masteryCredit: false as const,
  })));
  const requirements = candidate.routeInput.requirements.map(r => ({ ...r, diagnosticQuestionIds: r.diagnosticQuestionIds.filter(id => selected.has(id)),
    prerequisitePolicy: "concept_bridge_without_mastery_gate" as const,
    conceptBridges: conceptBridges.filter(bridge => bridge.targetSkillId === r.externalSkillId) }));
  const supplemental = new Set(questionMappings.filter(q => q.supplementalDiagnosticCandidate).map(q => q.id));
  // Private feedback/teaching authoring data, never a first-answer prompt or a grading key.
  const postAttemptMetadata = {
    role: "feedback_only" as const,
    questions: pack.questions.map(q => ({ questionId: q.id, postAttemptNotes: q.postAttemptNotes })),
    skills: pack.skills.map(s => ({ skillId: s.id, title: s.title, learningObjectives: s.learningObjectives, commonErrors: s.commonErrors })),
    independentIfExposedBeforeAnswer: false as const, scoringEvidence: false as const,
  };
  const teachingItems = candidate.teachingInput.items.map(({ learningObjectives: _objectives, commonErrors: _errors, ...item }) => item);
  return { ...candidate, kind: "material_course_full_package_candidate" as const,
    postAttemptMetadata,
    // Offline allowlisted planning projection only, NOT a product/client DTO or executable question.
    safeFirstAnswerInput: { status: "proposed" as const, bodyStatus: "missing" as const,
      questions: questionMappings.map(q => ({ questionId: q.id, sourceRef: q.sourceRef })) },
    teachingInput: { status: "proposed" as const, items: teachingItems },
    questionMappings, prerequisiteOrder: pack.prerequisiteOrder, sourceManifestSha256: pack.sourceManifestSha256, questionIndexSha256: pack.questionIndexSha256,
    mappingFiles: pack.mappingFiles, sources: pack.sources, coverageGapNotes: pack.coverageGapNotes, coverageExhaustive: false as const,
    diagnostic: { ...pack.diagnostic, eligibleEntryQuestionIds: pack.diagnostic.questionIds.filter(id => selected.has(id)),
      blockedEntryQuestionIds: pack.diagnostic.questionIds.filter(id => !selected.has(id)),
      declaredConstructedResponseCandidates: pack.diagnostic.constructedResponseCandidates,
      constructedResponseCandidates: pack.diagnostic.constructedResponseCandidates.filter(id => supplemental.has(id)),
      blockedConstructedResponseCandidates: pack.diagnostic.constructedResponseCandidates.filter(id => !supplemental.has(id)), administered: false as const },
    bktBoundary: pack.bktBoundary, schedule: pack.schedule, validation: pack.validation,
    prerequisiteGuidance: { status: "proposed" as const, policy: pack.schedule.unmeasuredPrerequisitePolicy,
      learnerMeasurement: "not_supplied" as const, conceptBridges, masteryCredit: false as const, permanentPassGate: false as const },
    routeInput: { status: "proposed" as const, requirements },
    planInput: { status: "proposed" as const, items: candidate.planInput.items.map(item => ({ ...item, diagnosticQuestionIds: item.diagnosticQuestionIds.filter(id => selected.has(id)) })) },
    coverage: candidate.coverage.map(row => ({ ...row, diagnosticQuestionIds: row.diagnosticQuestionIds.filter(id => selected.has(id)) })),
  };
}
