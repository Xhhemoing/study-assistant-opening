import type { ExamAttempt, ExamExposureCoverage, ExamLessonExposure, ExamPack, ExamSprintState } from "@aistudy/contracts";
import { validExamLessonExposure } from "./lesson-exposure-mapping";

export type ExamAttemptExposureQualification = {
  lessonAssistance: boolean | null; seenExample: boolean | null;
  partialExample: boolean | null; firstFamilyExposure: boolean | null; exposureHistoryUncertain: boolean;
};

/** Uses frozen attempt facts, never a later lesson ledger or wall-clock inference. */
export function examAttemptExposureQualification(attempt: ExamAttempt, state: ExamSprintState, pack: ExamPack): ExamAttemptExposureQualification {
  const exposureHistoryUncertain = attempt.exposureCoverage !== undefined;
  const question = pack.questions.find(item => item.id === attempt.questionId);
  if (!question) return { lessonAssistance: null, seenExample: null, partialExample: null, firstFamilyExposure: null, exposureHistoryUncertain };
  const exposures = state.lessonExposures ?? [];
  const validReference = (exposure: ExamLessonExposure): boolean => {
    const lesson = pack.lessons.find(item => item.id === exposure.lessonId);
    const mapping = lesson ? validExamLessonExposure(lesson) : null;
    return Boolean(mapping && exposure.packId === pack.id && exposure.packVersion === pack.version
      && (exposure.runId === null || state.runs.some(run => run.id === exposure.runId))
      && exposure.contentFingerprint === mapping.contentFingerprint && exposure.mappingVersion === mapping.mappingVersion
      && JSON.stringify(exposure.displayedFamilyIds) === JSON.stringify(mapping.displayedFamilyIds)
      && JSON.stringify(exposure.partialFamilyIds ?? []) === JSON.stringify(mapping.partialFamilyIds ?? []));
  };
  const fact = (ids: string[] | undefined, matches: (exposure: ExamLessonExposure) => boolean): boolean | null => {
    if (!ids?.length) return false;
    return ids.every(id => {
      const references = exposures.filter(exposure => exposure.id === id);
      return references.length === 1 && validReference(references[0]!) && matches(references[0]!);
    }) ? true : null;
  };
  const lessonAssistance = fact(attempt.lessonExposureIds, exposure => exposure.runId === attempt.runId && exposure.lessonId === question.lessonId);
  const seenExample = fact(attempt.seenExampleExposureIds, exposure => exposure.displayedFamilyIds.includes(question.familyId));
  const partialExample = fact(attempt.partialExampleExposureIds, exposure => Boolean(exposure.partialFamilyIds?.includes(question.familyId)));
  const index = state.attempts.findIndex(item => item.id === attempt.id);
  const previouslyPresented = state.attempts.slice(0, index < 0 ? state.attempts.length : index)
    .some(previous => pack.questions.find(item => item.id === previous.questionId)?.familyId === question.familyId);
  const firstFamilyExposure = seenExample === true || partialExample === true || previouslyPresented || attempt.firstFamilyExposure === false ? false
    : exposureHistoryUncertain || lessonAssistance === null || seenExample === null || partialExample === null || attempt.firstFamilyExposure === null ? null : true;
  return { lessonAssistance, seenExample, partialExample, firstFamilyExposure, exposureHistoryUncertain };
}

/** Only pending work may consume new authorizations. Submitted evidence is immutable. */
export function captureExamAttemptExposures(attempt: ExamAttempt, state: ExamSprintState, pack: ExamPack, exposureCoverage?: ExamExposureCoverage): void {
  if (attempt.answeredAt !== null) return;
  if (!attempt.exposureCoverage && exposureCoverage) attempt.exposureCoverage = structuredClone(exposureCoverage);
  const question = pack.questions.find(item => item.id === attempt.questionId);
  if (!question) return;
  const exposures = (state.lessonExposures ?? []).filter(exposure => exposure.packId === pack.id);
  attempt.lessonExposureIds = exposures.filter(exposure => exposure.runId === attempt.runId && exposure.lessonId === question.lessonId).map(exposure => exposure.id);
  attempt.seenExampleExposureIds = exposures.filter(exposure => exposure.displayedFamilyIds.includes(question.familyId)).map(exposure => exposure.id);
  attempt.partialExampleExposureIds = exposures.filter(exposure => exposure.partialFamilyIds?.includes(question.familyId)).map(exposure => exposure.id);
  attempt.firstFamilyExposure = examAttemptExposureQualification(attempt, state, pack).firstFamilyExposure;
}
