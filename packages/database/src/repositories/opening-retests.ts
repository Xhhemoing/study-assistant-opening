import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { retestCandidateSchema, type RetestCandidate } from "@aistudy/contracts";
import type { RetestEvidenceIdentity } from "@aistudy/domain";
import type { OpeningScope } from "./opening-sources";
import { lockLearningHistory, lockLearningOwner, lockWorkspaceLearningHistory, mapLearningObservation, nextWorkspaceLearningHistoryRevision } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContext } from "./opening-learning-evidence-context";
import { lockOpeningRetestReviewCandidate } from "./opening-review-candidates";
import { createOpeningRetestActivityRepository } from "./opening-retest-activities";
import { lockLearningPreferences, readLearningAutomationState } from "./opening-learning-preferences";

/**
 * L02 retest proposals as opening_jobs (kind=retest). No new migration.
 * Accept stores a due entry only — not P02 calendar scheduling.
 */
export function createOpeningRetestRepository(sql: Sql) {
  const activities = createOpeningRetestActivityRepository(sql);
  return {
    async saveCandidates(scope: OpeningScope, candidates: RetestCandidate[], expectedPrivacyEpoch?: number, sourceJobId?: string): Promise<RetestCandidate[]> {
      if (candidates.length === 0) return [];
      return sql.begin(async (tx) => {
        await lockWorkspaceLearningHistory(tx, scope);
        await lockLearningOwner(tx, scope);
        if (expectedPrivacyEpoch !== undefined) {
          const [workspace] = await tx`SELECT privacy_epoch FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
          if (Number(workspace?.privacy_epoch) !== expectedPrivacyEpoch) throw Object.assign(new Error("privacy epoch changed before retest writeback"), { code: "CONFLICT" });
        }
        const courseIds = [...new Set(candidates.map((candidate) => candidate.courseId))].sort();
        const allowed = new Set<string>();
        for (const courseId of courseIds) {
          await lockLearningPreferences(tx, scope, courseId);
          const { preferences } = await readLearningAutomationState(tx, scope, courseId);
          if (preferences.retestSuggestionsEnabled) allowed.add(courseId);
        }
        if (sourceJobId) {
          const [sourceJob] = await tx`SELECT created_at FROM opening_jobs WHERE id=${sourceJobId}
            AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND kind='retest'`;
          if (!sourceJob) throw Object.assign(new Error("retest source job not found"), { code: "NOT_FOUND" });
          for (const courseId of [...allowed]) {
            const [fresh] = await tx`SELECT j.created_at >= GREATEST(p.retest_suggestions_enabled_at,c.retest_suggestions_enabled_at) AS current
              FROM opening_jobs j JOIN courses c ON c.id=${courseId} AND c.workspace_id=j.workspace_id
              JOIN workspace_preferences p ON p.workspace_id=j.workspace_id
              WHERE j.id=${sourceJobId} AND j.workspace_id=${scope.workspaceId}`;
            if (fresh?.current !== true) allowed.delete(courseId);
          }
        }
        for (const courseId of courseIds.filter((id) => allowed.has(id))) {
          await lockLearningHistory(tx, scope, courseId);
        }
        const saved: RetestCandidate[] = [];
        for (const candidate of candidates) {
          if (!allowed.has(candidate.courseId)) continue;
          const heads = candidate.evidenceObservationIds ?? [];
          const roots = candidate.evidenceRootIds ?? [];
          if (heads.length || roots.length) {
            if (!heads.length) continue;
            const rows = await tx`SELECT o.*,COALESCE(o.root_observation_id,o.id) AS root_id FROM opening_learning_observations o
              JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
                AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id AND COALESCE(root.effective_head_id,root.id)=o.id
              WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.id IN ${tx(heads)}
                AND o.course_id=${candidate.courseId} AND o.skill_label=${candidate.skillLabel}
                AND o.requirement_key IS NOT DISTINCT FROM ${candidate.requirementKey ?? null}
                AND COALESCE(o.revision_kind,'original') <> 'retract' FOR SHARE OF root`;
            const actualRoots = new Set(rows.map((row) => String(row.root_id)));
            if (rows.length !== new Set(heads).size || (roots.length && (actualRoots.size !== new Set(roots).size || roots.some((root) => !actualRoots.has(root))))) continue;
            let privacyExcluded = false;
            for (const row of rows) {
              const evidence = await readOpeningLearningEvidenceContext(tx, scope, mapLearningObservation(row));
              if (evidence.context.version?.applicability === "privacy_excluded") { privacyExcluded = true; break; }
            }
            if (privacyExcluded) continue;
          }
          const sourceIds = [...new Set(candidate.sourceIds)].sort();
          if (sourceIds.length) {
            const sources = await tx`SELECT s.id FROM opening_sources s WHERE s.workspace_id=${scope.workspaceId}
              AND s.id IN ${tx(sourceIds)} AND s.upload_state='uploaded'
              AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${scope.workspaceId} AND e.source_id=s.id)
              ORDER BY s.id FOR SHARE`;
            if (sources.length !== sourceIds.length) continue;
          }
          const active = await tx`SELECT id FROM opening_retest_activities
            WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
              AND course_id=${candidate.courseId} AND skill_label=${candidate.skillLabel}
              AND requirement_key IS NOT DISTINCT FROM ${candidate.requirementKey ?? null}
              AND purpose='retest' AND status IN ('proposed','accepted','in_progress')
            FOR UPDATE`;
          if (active.length) continue;
          // A terminal history alone does not authorize a new cycle: policy
          // upgrades and worker retries must not regenerate a declined or
          // finished proposal for unchanged evidence. Only genuinely new
          // evidence roots (or no recorded evidence at all) may start one.
          const prior = await tx`SELECT id, status, reason FROM opening_retest_activities
            WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
              AND course_id=${candidate.courseId} AND skill_label=${candidate.skillLabel}
              AND requirement_key IS NOT DISTINCT FROM ${candidate.requirementKey ?? null}
              AND purpose='retest' AND status IN ('completed','declined','cancelled','invalidated','superseded')
            ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`;
          const priorRow = prior[0] as { id: string; status: string; reason: string | null } | undefined;
          const candidateRoots = [...new Set(candidate.evidenceRootIds ?? [])].sort();
          if (priorRow && priorRow.reason === "evidence_changed") {
            // Evidence already changed under this identity: the reconciler
            // recorded the change, so a new cycle with the fresh roots is legitimate.
          } else if (priorRow) {
            const seen = await tx`SELECT payload FROM opening_jobs
              WHERE id=(SELECT candidate_id FROM opening_retest_activities WHERE id=${priorRow.id})
                AND workspace_id=${scope.workspaceId}`;
            const priorPayload = (seen[0] as { payload?: { evidenceRootIds?: string[] } } | undefined)?.payload;
            const priorRoots = [...new Set((Array.isArray(priorPayload?.evidenceRootIds) ? priorPayload.evidenceRootIds : []) as string[])].sort();
            const sameEvidence = priorRoots.length > 0 && priorRoots.length === candidateRoots.length
              && priorRoots.every((root, index) => root === candidateRoots[index]);
            if (sameEvidence) continue;
          }
          const id = candidate.id || randomUUID();
          const row = { ...candidate, id, accepted: false, kind: "task" as const };
          const inserted = await tx`INSERT INTO opening_jobs (id,workspace_id,owner_user_id,key,kind,payload,privacy_epoch,state)
            VALUES (${id},${scope.workspaceId},${scope.ownerUserId},${`retest:${id}`},'retest',${tx.json(row as never)},0,'succeeded')
            ON CONFLICT (workspace_id,key) DO NOTHING RETURNING id`;
          if (inserted.length) {
            const activity = await tx`INSERT INTO opening_retest_activities (
              id, workspace_id, owner_user_id, course_id, skill_label, requirement_key, purpose, evidence_cycle_id,
              candidate_id, status, version, proposed_at, recommended_at
            ) VALUES (
              ${randomUUID()}, ${scope.workspaceId}, ${scope.ownerUserId}, ${candidate.courseId}, ${candidate.skillLabel},
              ${candidate.requirementKey ?? null}, 'retest', ${id}, ${id}, 'proposed', 1, ${candidate.dueAt}, ${candidate.dueAt}
            ) ON CONFLICT DO NOTHING RETURNING id`;
            if (!activity.length) {
              await tx`DELETE FROM opening_jobs WHERE id=${id} AND workspace_id=${scope.workspaceId}`;
              continue;
            }
            saved.push(row);
          }
        }
        if (saved.length) await nextWorkspaceLearningHistoryRevision(tx, scope);
        return saved;
      }) as Promise<RetestCandidate[]>;
    },
    async accept(
      scope: OpeningScope,
      id: string,
      clientKey: string,
    ): Promise<RetestCandidate> {
      if (!clientKey || clientKey.length < 8) {
        throw Object.assign(new Error("clientKey required"), { code: "VALIDATION" });
      }
      return sql.begin(async (tx) => {
        const locked = await lockOpeningRetestReviewCandidate(tx, scope, id);
        if (locked.discarded) throw Object.assign(new Error("retest candidate was discarded"), { code: "CONFLICT" });
        const payload = retestCandidateSchema.passthrough().parse(locked);
        if (payload.accepted) return payload;
        const accepted: RetestCandidate = { ...payload, accepted: true };
        await tx`UPDATE opening_jobs SET payload=${tx.json(accepted as never)},
          result=${tx.json({ accepted: true, clientKey, dueAt: accepted.dueAt, scheduled: false })},updated_at=now()
          WHERE id=${id} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        return accepted;
      }) as Promise<RetestCandidate>;
    },

    async listAcceptedEvidence(scope: OpeningScope, courseId: string): Promise<RetestEvidenceIdentity[]> {
      const activeRows = await sql`SELECT course_id, skill_label, requirement_key FROM opening_retest_activities
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${courseId}
          AND status IN ('proposed','accepted','in_progress')`;
      const active = new Set(activeRows.map((row) => JSON.stringify([
        String(row.course_id), String(row.skill_label), row.requirement_key == null ? null : String(row.requirement_key),
      ])));
      const rows = await sql`SELECT id, payload FROM opening_jobs
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND kind='retest'`;
      const activityCandidates = new Set((await sql`SELECT candidate_id FROM opening_retest_activities
        WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND candidate_id IS NOT NULL`)
        .map((row) => String((row as { candidate_id: string }).candidate_id)));
      const identities: RetestEvidenceIdentity[] = [];
      const schema = retestCandidateSchema.pick({ courseId: true, skillLabel: true, requirementKey: true, accepted: true, evidenceChanged: true }).strip();
      for (const row of rows) {
        const parsed = schema.safeParse(row.payload);
        if (parsed.success && parsed.data.accepted && !parsed.data.evidenceChanged && parsed.data.courseId === courseId) {
          const key = JSON.stringify([parsed.data.courseId, parsed.data.skillLabel, parsed.data.requirementKey ?? null]);
          if (!active.has(key) && !activityCandidates.has(String((row as { id: string }).id))) {
            identities.push({ courseId, skillLabel: parsed.data.skillLabel, requirementKey: parsed.data.requirementKey ?? null });
          }
        }
      }
      for (const row of activeRows) identities.push({
        courseId: String(row.course_id), skillLabel: String(row.skill_label),
        requirementKey: row.requirement_key == null ? null : String(row.requirement_key),
      });
      return identities;
    },

    async listAcceptedSkillLabels(
      scope: OpeningScope,
      courseId: string,
    ): Promise<string[]> {
      const identities = await this.listAcceptedEvidence(scope, courseId);
      return [...new Set(identities.map((identity) => identity.skillLabel))];
    },

    /**
     * Return only due business activities for the retest worker. Historical
     * accepted identities remain available through listAcceptedEvidence, but
     * they must not drive a new candidate before their task is due.
     */
    async listDueEvidence(
      scope: OpeningScope,
      courseId: string,
      now = new Date().toISOString(),
    ): Promise<RetestEvidenceIdentity[]> {
      const due = await activities.listDue(scope, courseId, now);
      return due.map((activity) => ({
        courseId: activity.courseId!,
        skillLabel: activity.skillLabel!,
        requirementKey: activity.requirementKey ?? null,
      }));
    },
  };
}

export type OpeningRetestRepository = ReturnType<typeof createOpeningRetestRepository>;

export type RetestEvidenceRevision = {
  rootObservationId: string;
  previousHeadObservationId: string;
  headObservationId: string;
  previousIdentity: RetestEvidenceIdentity;
  currentIdentity: RetestEvidenceIdentity | null;
  historyRevision: number;
};

/** Nested helper: the observation revision transaction owns semantic revision and history/root locks. */
export async function reconcileOpeningRetestEvidence(tx: TransactionSql, scope: OpeningScope, input: RetestEvidenceRevision): Promise<void> {
  const identities = [input.previousIdentity, ...(input.currentIdentity ? [input.currentIdentity] : [])];
  const courseIds = [...new Set(identities.map((identity) => identity.courseId))];
  const jobs = await tx`SELECT id,payload FROM opening_jobs WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND kind='retest' AND payload->>'courseId' IN ${tx(courseIds)} ORDER BY id FOR UPDATE`;
  for (const job of jobs) {
    const parsed = retestCandidateSchema.passthrough().safeParse(job.payload);
    if (!parsed.success || parsed.data.discarded === true) continue;
    const candidate = parsed.data;
    const roots = candidate.evidenceRootIds ?? [];
    const heads = candidate.evidenceObservationIds ?? [];
    const linked = roots.includes(input.rootObservationId) || heads.includes(input.previousHeadObservationId);
    const legacyMatch = roots.length === 0 && heads.length === 0 && identities.some((identity) =>
      candidate.courseId === identity.courseId && candidate.skillLabel === identity.skillLabel && (candidate.requirementKey ?? null) === identity.requirementKey,
    );
    if (!linked && !legacyMatch) continue;
    const change = candidate.accepted
      ? { evidenceChanged: true }
      : { invalidated: true, invalidationReason: "observation_revised", evidenceChanged: true };
    await tx`UPDATE opening_jobs SET payload=payload || ${tx.json(change)},updated_at=now() WHERE id=${job.id}`;
    await tx`UPDATE opening_retest_activities
      SET status='invalidated', reason='evidence_changed', invalidated_at=now(), snoozed_until=NULL,
        version=version + 1, updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND candidate_id=${job.id} AND status IN ('proposed','accepted','in_progress')`;
    await tx`UPDATE opening_retest_activities
      SET reason='evidence_changed', updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
        AND candidate_id=${job.id} AND status='completed'`;
  }
}
