import type { Sql } from "postgres";
import { conversationPlanningContextSchema, openingPlanningSettingsSchema, plannedBlockSchema, type ConversationPlanningContext, type Scope } from "@aistudy/contracts";
import { addLocalDays, deriveDayBlocks, evaluateEvidenceEligibility, localDateKeyInZone, resolveLocalDayBounds, resolveWorkspaceTimeZone } from "@aistudy/domain";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { mapLearningObservation } from "./opening-learning-facts";
import { OpeningPlanError } from "./opening-plan-error";
import { createOpeningPlansRepository } from "./opening-plans";

/** Bounded, side-effect-free, owned snapshot. It never repairs or writes learning summaries. */
export async function readOpeningConversationPlanningContext(sql: Sql, scope: Scope, now = new Date()): Promise<ConversationPlanningContext> {
  return sql.begin("isolation level repeatable read read only", async tx => {
    const [workspace] = await tx`SELECT p.planning_settings FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
      WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
    if (!workspace) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
    const parsed = openingPlanningSettingsSchema.safeParse(workspace.planning_settings);
    const timeZone = resolveWorkspaceTimeZone((workspace.planning_settings as { timeZone?: string } | null)?.timeZone);
    const date = localDateKeyInZone(now, timeZone);
    const courses = await tx`SELECT id,title FROM courses WHERE workspace_id=${scope.workspaceId} AND archived_at IS NULL ORDER BY title,id LIMIT 21`;
    const courseAlias = new Map(courses.slice(0, 20).map((row, index) => [String(row.id), `c${index + 1}`]));
    const tasks = await tx`SELECT id,title,minutes,course_id,origin,candidate_id,not_before FROM opening_tasks
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND status='pending'
      ORDER BY priority DESC,created_at,id LIMIT 21`;
    const taskAlias = new Map(tasks.slice(0, 20).map((row, index) => [String(row.id), `t${index + 1}`]));
    const [state] = await tx`SELECT accepted_version,accepted_blocks FROM opening_plan_state WHERE workspace_id=${scope.workspaceId} AND day=${date}::date`;
    const blocks = plannedBlockSchema.array().max(200).parse(state?.accepted_blocks ?? []);
    const timetable = parsed.success ? await createOpeningPlansRepository(tx as unknown as Sql).listTimetable(scope) : [];
    const hard = parsed.success ? deriveDayBlocks(date, parsed.data, timetable)
      .filter(block => block.kind !== "free") : [];
    const from = resolveLocalDayBounds(addLocalDays(date, -13), timeZone).dayStart;
    const heads = await tx`SELECT o.* FROM opening_learning_observations o
      JOIN opening_learning_observations root ON root.id=COALESCE(o.root_observation_id,o.id)
        AND root.workspace_id=o.workspace_id AND root.owner_user_id=o.owner_user_id AND COALESCE(root.effective_head_id,root.id)=o.id
      LEFT JOIN courses c ON c.id=o.course_id AND c.workspace_id=o.workspace_id
      WHERE o.workspace_id=${scope.workspaceId} AND o.owner_user_id=${scope.ownerUserId}
        AND (o.course_id IS NULL OR (c.id IS NOT NULL AND c.archived_at IS NULL))
        AND COALESCE(o.revision_kind,'original')<>'retract' AND o.occurred_at>=${from} AND o.occurred_at<${now}
      ORDER BY o.occurred_at DESC,o.id LIMIT 101`;
    let counts: ConversationPlanningContext["learning"]["counts"] = null;
    if (heads.length <= 100) {
      counts = { observations: 0, independentVerifiedCurrent: 0, unknownQualification: 0 };
      const mapped = heads.map(mapLearningObservation), contexts = await readOpeningLearningEvidenceContexts(tx, scope, mapped);
      for (const observation of mapped) {
        const context = contexts[observation.id]!;
        if (context.context.version?.applicability === "privacy_excluded") continue;
        const eligibility = evaluateEvidenceEligibility(context.observation, context.context);
        counts.observations++;
        if ([eligibility.independentAttempt, eligibility.verifiedCorrect, eligibility.usableForCurrentVersion].every(value => value === "yes")) counts.independentVerifiedCurrent++;
        if ([eligibility.independentAttempt, eligibility.verifiedCorrect, eligibility.usableForCurrentVersion].some(value => value === "unknown")) counts.unknownQualification++;
      }
    }
    return conversationPlanningContextSchema.parse({
      version: "conversation-planning-v1", asOf: now.toISOString(), date, timeZone,
      settings: parsed.success ? "configured" : workspace.planning_settings == null ? "not_configured" : "invalid",
      acceptedVersion: Number(state?.accepted_version ?? 0),
      courses: courses.slice(0, 20).map(row => ({ alias: courseAlias.get(String(row.id)), name: String(row.title).slice(0, 60) })),
      tasks: tasks.slice(0, 20).map(row => ({ alias: taskAlias.get(String(row.id)),
        // Source-derived task text is withheld: this summary does not bypass source admission.
        title: row.candidate_id != null || (row.origin != null && row.origin !== "manual") ? "已确认学习任务" : String(row.title).slice(0, 60),
        minutes: Number(row.minutes), courseAlias: courseAlias.get(String(row.course_id)) ?? null,
        deferred: row.not_before != null && new Date(row.not_before as string | Date).getTime() > now.getTime() })),
      acceptedSlots: blocks.slice(0, 20).map(block => ({ taskAlias: taskAlias.get(block.taskId) ?? null, start: block.start, end: block.end })),
      hardSlots: hard.slice(0, 20), learning: { status: heads.length > 100 ? "limited" : "available", windowDays: 14, counts },
      truncated: courses.length > 20 || tasks.length > 20 || blocks.length > 20 || hard.length > 20 || heads.length > 100,
    });
  }) as Promise<ConversationPlanningContext>;
}
