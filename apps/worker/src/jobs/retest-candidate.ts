import type { LearningObservation, RetestCandidate, Scope } from "@aistudy/contracts";
import type { OpeningJobRecord } from "@aistudy/database";
import {
  buildRetestCandidates,
  summarizeObservations,
} from "@aistudy/domain";

export type RetestCandidateDeps = {
  listObservations(scope: Scope, courseId: string): Promise<LearningObservation[]>;
  listDueRetestSkills(scope: Scope, courseId: string): Promise<string[]>;
  /** Persist proposal rows (not calendar tasks). */
  saveCandidates(scope: Scope, candidates: RetestCandidate[]): Promise<RetestCandidate[]>;
  now?: () => string;
};

export type RetestCandidatePayload = {
  courseId: string;
  sourceIdsBySkill?: Record<string, string[]>;
  promptsBySkill?: Record<string, string>;
  limit?: number;
  delayDays?: number;
};

/**
 * L02: small retest proposal batch from explainable summaries.
 * Does not schedule calendar work (P02) — proposals only until accept.
 */
export function createRetestCandidateHandler(deps: RetestCandidateDeps) {
  return async function processRetestCandidate(
    job: OpeningJobRecord,
    payload: unknown,
  ): Promise<{ candidates: RetestCandidate[] }> {
    const body = payload as RetestCandidatePayload;
    if (!body || typeof body.courseId !== "string") {
      throw new Error("retest payload missing courseId");
    }
    const scope: Scope = {
      workspaceId: job.workspaceId,
      ownerUserId: job.ownerUserId,
    };
    const now = (deps.now ?? (() => new Date().toISOString()))();
    const observations = await deps.listObservations(scope, body.courseId);
    const dueSkills = await deps.listDueRetestSkills(scope, body.courseId);
    const summaries = summarizeObservations(observations, now, {
      dueRetestSkillLabels: new Set(dueSkills),
    });

    const sourceIdsBySkill: Record<string, string[]> = {};
    const promptsBySkill = { ...(body.promptsBySkill ?? {}) };
    for (const summary of summaries) {
      const owned = observations.find(
        (o) => o.skillLabel === summary.skillLabel && (o.sourceIds?.length ?? 0) > 0,
      );
      const ownedIds = owned?.sourceIds ?? [];
      const requested = body.sourceIdsBySkill?.[summary.skillLabel];
      if (requested?.length) {
        const allowed = new Set(ownedIds);
        if (requested.every((id) => allowed.has(id))) {
          sourceIdsBySkill[summary.skillLabel] = requested;
        }
      } else if (ownedIds.length) {
        sourceIdsBySkill[summary.skillLabel] = ownedIds;
      }
    }

    const candidates = buildRetestCandidates({
      courseId: body.courseId,
      summaries,
      now,
      sourceIdsBySkill,
      promptsBySkill,
      limit: body.limit,
      delayDays: body.delayDays,
    });
    const saved = await deps.saveCandidates(scope, candidates);
    return { candidates: saved };
  };
}
