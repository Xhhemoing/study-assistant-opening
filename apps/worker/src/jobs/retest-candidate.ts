import type { LearningPreferences, RetestCandidate, Scope } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";
import { buildRetestCandidates, summarizeObservations, DEFAULT_RETEST_BATCH_LIMIT, type CourseEvidence, type RetestEvidenceIdentity } from "@aistudy/domain";

export type RetestCandidateDeps = {
  readLearningPreferences?: (scope: Scope, courseId: string) => Promise<LearningPreferences>;
  readCourseEvidence(scope: Scope, courseId: string): Promise<CourseEvidence>;
  listDueRetests(scope: Scope, courseId: string): Promise<RetestEvidenceIdentity[]>;
  /** Persist proposal rows (not calendar tasks). */
  saveCandidates(scope: Scope, candidates: RetestCandidate[], expectedPrivacyEpoch?: number, sourceJobId?: string): Promise<RetestCandidate[]>;
  now?: () => string;
};

export type RetestCandidatePayload = {
  courseId: string;
  sourceIdsBySkill?: Record<string, string[]>;
  promptsBySkill?: Record<string, string>;
  limit?: number;
  delayDays?: number;
};

/** L02 proposals consume the same qualification facts as the course read path. */
export function createRetestCandidateHandler(deps: RetestCandidateDeps) {
  return async function processRetestCandidate(
    job: OpeningJobRecord,
    payload: unknown,
  ): Promise<{ candidates: RetestCandidate[] }> {
    const body = payload as RetestCandidatePayload;
    if (!body || typeof body.courseId !== "string") throw new Error("retest payload missing courseId");
    const scope: Scope = { workspaceId: job.workspaceId, ownerUserId: job.ownerUserId };
    if (deps.readLearningPreferences && !(await deps.readLearningPreferences(scope, body.courseId)).retestSuggestionsEnabled) {
      return { candidates: [] };
    }
    const now = (deps.now ?? (() => new Date().toISOString()))();
    const { observations, evidenceContexts } = await deps.readCourseEvidence(scope, body.courseId);
    const dueRetests = await deps.listDueRetests(scope, body.courseId);
    const summaries = summarizeObservations(observations, now, {
      dueRetests, evidenceContexts,
    });
    const candidates: RetestCandidate[] = [];
    const limit = body.limit ?? DEFAULT_RETEST_BATCH_LIMIT;
    for (const summary of summaries) {
      if (candidates.length >= limit) break;
      // Keep references attached to this course/requirement's evidence; equal labels are not identity.
      const allowedEvidence = new Set(summary.evidenceEligibility
        .filter(({ observationId, eligibility }) => {
          const availability = evidenceContexts[observationId]?.context.version?.applicability;
          return eligibility.usableForCurrentVersion !== "no" && availability !== "unavailable" && availability !== "privacy_excluded";
        })
        .map(({ observationId }) => observationId));
      const ownedIds = [...new Set(observations
        .filter((row) => allowedEvidence.has(row.id))
        .flatMap((row) => row.sourceIds))];
      const requested = body.sourceIdsBySkill?.[summary.skillLabel];
      const allowed = new Set(ownedIds);
      const sourceIds = requested?.length ? requested.every((id) => allowed.has(id)) ? requested : [] : ownedIds;
      candidates.push(...buildRetestCandidates({
        courseId: body.courseId,
        summaries: [summary],
        now,
        sourceIdsBySkill: { [summary.skillLabel]: sourceIds },
        promptsBySkill: body.promptsBySkill ?? {},
        limit: limit - candidates.length,
        delayDays: body.delayDays,
      }).map((candidate) => ({
        ...candidate, requirementKey: summary.requirementKey,
        evidenceObservationIds: summary.evidenceIds,
        evidenceRootIds: [...new Set(observations.filter((row) => summary.evidenceIds.includes(row.id)).map((row) => row.rootObservationId ?? row.id))],
      })));
    }
    return { candidates: await deps.saveCandidates(scope, candidates, job.privacyEpoch, job.id) };
  };
}
