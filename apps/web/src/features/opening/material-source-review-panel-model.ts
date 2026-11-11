import { materialCourseFullPackageSchema, type MaterialCourseFullPackage } from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { createMaterialSourceLocator, type MaterialSourceLocatorRequest, type MaterialSourceLocatorResult } from "../../../../../packages/domain/src/opening/material-source-locator";

/** Current raw metadata input, NOT an adapter candidate or its private postAttemptMetadata. */
export type MaterialSourceReviewInput = MaterialCourseFullPackage;
export type MaterialSourceReviewQuestionStatus = Readonly<{
  id: string;
  assessmentReadiness: MaterialSourceReviewInput["questions"][number]["assessmentReadiness"];
  bktAdmission: MaterialSourceReviewInput["questions"][number]["bktAdmission"];
  declaredDiagnosticRole: "entry-candidate" | "supplemental-candidate" | null;
  reasons: readonly string[];
}>;
export type MaterialSourceReviewModel = Readonly<{
  choices: readonly Readonly<{
    key: string; label: string; request: MaterialSourceLocatorRequest;
    result: MaterialSourceLocatorResult; questionStatuses: readonly MaterialSourceReviewQuestionStatus[];
  }>[];
}>;

/** Validate an untrusted current metadata package and all explicit host bindings together. */
export function readMaterialSourceReview(input: unknown, providedSources: unknown = []): MaterialSourceReviewModel | null {
  try {
    // Preserve raw bytes at the URL/basename boundary: never pre-trim inputs or invent a URL.
    // The frozen R3 locator owns raw URL, identity, hash and whole-input reference validation.
    const locator = createMaterialSourceLocator(input, providedSources);
    const pack = materialCourseFullPackageSchema.parse(input);
    const choices: { key: string; label: string; request: MaterialSourceLocatorRequest }[] = [
      ...pack.questions.map(q => ({ key: `question:${q.id}`, label: `题目 ${q.id}`, request: { kind: "question" as const, questionId: q.id } })),
      ...pack.skills.map(s => ({ key: `skill:${s.id}`, label: `技能 ${s.id}`, request: { kind: "skill" as const, skillId: s.id } })),
    ];
    const questionStatus = (q: MaterialSourceReviewInput["questions"][number]): MaterialSourceReviewQuestionStatus => ({
      id: q.id, assessmentReadiness: q.assessmentReadiness, bktAdmission: q.bktAdmission,
      declaredDiagnosticRole: pack.diagnostic.questionIds.includes(q.id) ? "entry-candidate"
        : pack.diagnostic.constructedResponseCandidates.includes(q.id) ? "supplemental-candidate" : null,
      reasons: [
        "仅题目元数据，题干、可信答案与既往接触尚未确认；诊断禁用",
        ...(q.mappingStatus === "needs-visual-check" || q.assessmentReadiness === "blocked-visual-check" ? ["待视觉确认，排除诊断"] : []),
        ...(q.assessmentReadiness === "blocked-author-exclusion" ? ["资料作者排除，禁用诊断；不从答后说明判断原因"] : []),
        ...(q.assessmentReadiness === false ? ["assessmentReadiness=false，禁用诊断"] : []),
        ...(q.bktAdmission === false ? ["bktAdmission=false，禁用诊断、评分与 BKT"] : []),
      ],
    });
    // Explicit allowlist. postAttemptNotes/learningObjectives/commonErrors (and adapter
    // postAttemptMetadata) are private feedback/teaching material, never view model content.
    return { choices: choices.map(choice => ({ ...choice, result: locator.resolve(choice.request),
      questionStatuses: pack.questions.filter(q => choice.request.kind === "question"
        ? q.id === choice.request.questionId
        : q.primarySkillId === choice.request.skillId || q.secondarySkillIds.includes(choice.request.skillId)).map(questionStatus),
    })) };
  } catch {
    // Boundary conversion only: never echo input, URLs or validation payloads into the UI.
    return null;
  }
}
