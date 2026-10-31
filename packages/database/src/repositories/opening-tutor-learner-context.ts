import { readProjectedOpeningAdaptivePrefs } from "./opening-learning-goal-bridge";
import type { Sql, TransactionSql } from "postgres";
import { openingAdaptivePrefsSchema, tutorLearnerContextSchema, type LearningObservation, type Scope, type TutorLearnerContext } from "@aistudy/contracts";
import { evaluateEvidenceEligibility, resolveEvidenceAssistance } from "@aistudy/domain";
import { contextSourceRefsIncluded, mergeContextSourceRefs } from "./opening-context-provenance";
import { learningError, mapLearningObservation } from "./opening-learning-facts";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { readLearningPreferenceSources } from "./opening-learning-preferences";

/** Feedback may inherit material from an earlier correction. Preserve every captured version;
 * a missing version is unknown provenance, never a material-free observation. */
async function admittedLineageRefs(tx: TransactionSql, scope: Scope, records: LearningObservation[], selected: ReadonlySet<string>) {
  const rootIds = records.map(record => record.rootObservationId ?? record.id);
  const lineage = rootIds.length ? await tx`SELECT COALESCE(root_observation_id,id) root_id,source_ids,source_versions,reference_source_id,reference_check
    FROM opening_learning_observations WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND COALESCE(root_observation_id,id)=ANY(${rootIds}::uuid[])` : [];
  const byRoot = new Map<string, TutorLearnerContext["sourceRefs"]>(), unknown = new Set<string>();
  for (const row of lineage) {
    const rootId = String(row.root_id), versions = (row.source_versions ?? {}) as Record<string, unknown>;
    const check = row.reference_check as { referenceId?: string } | null;
    const ids = new Set([...(row.source_ids ?? []) as string[], ...Object.keys(versions),
      ...(row.reference_source_id ? [String(row.reference_source_id)] : []), ...(check?.referenceId ? [check.referenceId] : [])]);
    const refs: TutorLearnerContext["sourceRefs"] = [];
    for (const sourceId of ids) {
      const version = versions[sourceId];
      if (!selected.has(sourceId) || typeof version !== "number" || !Number.isSafeInteger(version) || version < 0) unknown.add(rootId);
      else refs.push({ sourceId, sourceVersion: version });
    }
    byRoot.set(rootId, mergeContextSourceRefs(byRoot.get(rootId) ?? [], refs));
  }
  const candidates = [...byRoot].filter(([rootId, refs]) => !unknown.has(rootId) && refs.length <= 960)
    .map(([rootId, refs]) => ({ rootId, refs }));
  const admitted = candidates.length ? await tx`SELECT candidate->>'rootId' root_id
    FROM jsonb_array_elements(${tx.json(candidates)}) candidate
    WHERE ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`candidate->'refs'`)}` : [];
  return new Map(admitted.map(row => [String(row.root_id), byRoot.get(String(row.root_id))!]));
}

export function createOpeningTutorLearnerContextRepository(sql: Sql) {
  return {
    async read(scope: Scope, input: { courseId?: string | null; sourceIds: readonly string[] }): Promise<TutorLearnerContext | null> {
      if (!input.courseId) return null;
      return sql.begin("isolation level repeatable read read only", async tx => {
        const [course] = await tx`SELECT c.id,c.title,c.description,w.privacy_epoch,p.adaptive_planning FROM courses c
          JOIN workspaces w ON w.id=c.workspace_id AND w.owner_user_id=${scope.ownerUserId}
          LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
          WHERE c.id=${input.courseId!} AND c.workspace_id=${scope.workspaceId} AND c.archived_at IS NULL`;
        if (!course) throw learningError("NOT_FOUND", "study course not found");
        const projected = await readProjectedOpeningAdaptivePrefs(tx, scope, course.adaptive_planning); const preferences = openingAdaptivePrefsSchema.safeParse(projected);
        const goal = preferences.success ? preferences.data.courseGoals[input.courseId!] : undefined;
        // Only the bridge's selected formal projection supplies formal identity/lifecycle.
        const { goalId, revision, lifecycle, milestones: _milestones, ...definition } = goal ?? {};
        const profileGoal = goal && goalId && revision && lifecycle && preferences.success && preferences.data.courseGoalRefs?.[input.courseId!] === goalId
          ? { source: "course_goals", goalId, revision, lifecycle, definition }
          : goal ? { source: "legacy", revision: revision ?? null, lifecycle: "unknown", definition }
            : { source: "unknown", reason: !preferences.success ? "invalid"
              : preferences.data.courseGoalRefs?.[input.courseId!] ? "unresolved"
                : preferences.data.courseGoalRevisions?.[input.courseId!] !== undefined ? "cleared" : "missing" };
        const learningPreferences = await readLearningPreferenceSources(tx, scope, input.courseId!);
        const heads = await tx`SELECT o.* FROM opening_learning_observations o
          JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
            AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id AND COALESCE(root.effective_head_id,root.id)=o.id
          WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId} AND o.course_id=${input.courseId!}
            AND COALESCE(o.revision_kind,'original')<>'retract'
          ORDER BY o.recorded_at DESC NULLS LAST,o.id DESC LIMIT 30`;
        const records = heads.map(mapLearningObservation);
        const contexts = await readOpeningLearningEvidenceContexts(tx, scope, records, false);
        const lineageRefs = await admittedLineageRefs(tx, scope, records, new Set(input.sourceIds));
        type Sample = { record: LearningObservation; refs: TutorLearnerContext["sourceRefs"] };
        const groups = new Map<string, { summary: TutorLearnerContext["weaknesses"][number]; samples: Sample[]; recency: number }>();
        const recentMistakes: TutorLearnerContext["recentMistakes"] = [], mistakeSamples: Sample[] = [];
        for (const [recency, record] of records.entries()) {
          const evidence = contexts[record.id]!;
          const eligibility = evaluateEvidenceEligibility(evidence.observation, evidence.context);
          const refs = lineageRefs.get(record.rootObservationId ?? record.id);
          if (eligibility.usableForCurrentVersion !== "yes" || !refs) continue;
          const key = `${record.requirementKey ?? ""}:${record.skillLabel}`;
          let group = groups.get(key);
          if (!group) {
            group = { summary: { skillLabel: record.skillLabel, requirementKey: record.requirementKey ?? null, incorrect: 0, assisted: 0, samples: 0 }, samples: [], recency };
            groups.set(key, group);
          }
          const sample = { record, refs };
          if (group.summary.samples < 5) {
            group.summary.samples++;
            if (eligibility.verifiedCorrect === "no") group.summary.incorrect++;
            if (eligibility.independentAttempt === "no") group.summary.assisted++;
            group.samples.push(sample);
          }
          if (recentMistakes.length < 3 && eligibility.verifiedCorrect === "no" && record.aiEvaluation) {
            recentMistakes.push({ observationId: record.id, skillLabel: record.skillLabel, feedback: record.aiEvaluation.feedback.slice(0, 1200),
              unmetCriteria: record.aiEvaluation.criteria.filter(criterion => criterion.verdict !== "correct")
                .slice(0, 6).map(criterion => `${criterion.label}：${criterion.feedback}`.slice(0, 240)), assistance: resolveEvidenceAssistance(evidence.observation, evidence.context) });
            mistakeSamples.push(sample);
          }
        }
        const weakGroups = [...groups.values()].filter(group => group.summary.incorrect || group.summary.assisted)
          .sort((a, b) => b.summary.incorrect - a.summary.incorrect || b.summary.assisted - a.summary.assisted || a.recency - b.recency).slice(0, 5);
        const used = [...new Map([...weakGroups.flatMap(group => group.samples), ...mistakeSamples].map(sample => [sample.record.id, sample])).values()];
        const sourceRefs = mergeContextSourceRefs(...used.map(sample => sample.refs));
        // A context must retain all consumed origins. Avoid truncating provenance to fit the wire bound.
        if (sourceRefs.length > 960) throw learningError("CONFLICT", "学习记录关联资料过多，请缩小资料范围后重试");
        const observationIds = used.map(sample => sample.record.id);
        return tutorLearnerContextSchema.parse({ courseId: input.courseId, title: String(course.title).slice(0, 200), asOf: new Date().toISOString(),
          privacyEpoch: Number(course.privacy_epoch),
          goalPreferenceProfile: { version: 1, goal: profileGoal, learningPreferences },
          goal: { description: String(course.description ?? "").slice(0, 1000), targetDate: goal?.targetDate ?? null, weeklyMinutes: goal?.weeklyMinutes ?? null },
          weaknesses: weakGroups.map(group => group.summary), recentMistakes, observationIds, sourceRefs });
      }) as Promise<TutorLearnerContext>;
    },
    async assertCurrent(scope: Scope, context: TutorLearnerContext): Promise<void> {
      const [current] = await sql`SELECT c.id FROM courses c JOIN workspaces w ON w.id=c.workspace_id
        WHERE c.id=${context.courseId} AND c.workspace_id=${scope.workspaceId} AND c.archived_at IS NULL
          AND w.owner_user_id=${scope.ownerUserId} AND w.privacy_epoch=${context.privacyEpoch}
          AND ${contextSourceRefsIncluded(sql, scope.workspaceId, sql`${sql.json(context.sourceRefs)}`)}
          AND NOT EXISTS (SELECT 1 FROM unnest(${context.observationIds}::uuid[]) expected(id)
            WHERE NOT EXISTS (SELECT 1 FROM opening_learning_observations o
              JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
                AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id AND COALESCE(root.effective_head_id,root.id)=o.id
              WHERE o.id=expected.id AND o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
                AND o.course_id=c.id AND COALESCE(o.revision_kind,'original')<>'retract'))`;
      if (!current) throw learningError("CONFLICT", "学习记录或资料已变化，请重新发送问题");
    },
  };
}
