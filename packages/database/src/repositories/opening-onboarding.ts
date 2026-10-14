import { createHash, randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { openingOnboardingInputSchema, openingOnboardingResultSchema, type OpeningOnboardingInput, type OpeningOnboardingResult, type Scope } from "@aistudy/contracts";
import { buildOpeningOnboardingSeed } from "@aistudy/domain";
import { OpeningPlanError } from "./opening-plan-error";
import { createCourseMembershipRepository } from "./course-membership";

export function createOpeningOnboardingRepository(sql: Sql) {
  return {
    async status(scope: Scope): Promise<OpeningOnboardingResult> {
      const rows = await sql`SELECT p.opening_onboarding,
        EXISTS(SELECT 1 FROM opening_tasks t WHERE t.workspace_id=w.id) OR
        EXISTS(SELECT 1 FROM courses c WHERE c.workspace_id=w.id) OR
        EXISTS(SELECT 1 FROM library_documents d WHERE d.workspace_id=w.id AND d.deleted_at IS NULL) OR
        EXISTS(SELECT 1 FROM opening_sources s WHERE s.workspace_id=w.id AND s.upload_state='uploaded') OR
        EXISTS(SELECT 1 FROM opening_turns t WHERE t.workspace_id=w.id) AS has_content
        FROM workspaces w LEFT JOIN workspace_preferences p ON p.workspace_id=w.id
        WHERE w.id=${scope.workspaceId} AND w.owner_user_id=${scope.ownerUserId}`;
      if (!rows.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
      const stored = rows[0]!.opening_onboarding as { result?: unknown } | null;
      if (stored?.result) return openingOnboardingResultSchema.parse(stored.result);
      return { completed: false, needsOnboarding: !rows[0]!.has_content, courseId: null, taskIds: [] };
    },
    async complete(scope: Scope, raw: OpeningOnboardingInput): Promise<OpeningOnboardingResult> {
      const input = openingOnboardingInputSchema.parse(raw);
      const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const seed = input.action === "complete" ? buildOpeningOnboardingSeed(input) : null;
      return sql.begin(async tx => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningPlanError("NOT_FOUND", "workspace not found");
        const preferences = await tx`SELECT opening_onboarding FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
        const saved = preferences[0]?.opening_onboarding as { requestHash?: string; result?: unknown } | null;
        if (saved?.result) {
          if (saved.requestHash !== requestHash) throw new OpeningPlanError("CONFLICT", "首启已完成；不会重复创建课程和任务。请进入学习空间修改设置。");
          return openingOnboardingResultSchema.parse(saved.result);
        }
        let courseId: string | null = null;
        const taskIds: string[] = [];
        if (input.action === "complete" && seed) {
          for (const sourceId of input.sourceIds) {
            const source = await tx`SELECT s.id FROM opening_sources s WHERE s.id=${sourceId}
              AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
              AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id) FOR SHARE`;
            if (!source.length) throw new OpeningPlanError("NOT_FOUND", "材料不存在、尚未上传完成或已禁止 AI 使用。");
          }
          courseId = randomUUID();
          await createCourseMembershipRepository(tx as unknown as Sql).createCourse({ workspaceId: scope.workspaceId, courseId,
            title: input.subject, slug: `opening-${courseId}`, description: `${seed.goal.baselineReason}。${input.examDate ? `目标考试日期：${input.examDate}（${input.timeZone}，未确认具体时刻）。` : "暂无考试日期。"}` });
          for (const sourceId of input.sourceIds) {
            await tx`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
              VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'core',0,'private')`;
          }
          for (const [index, task] of seed.tasks.entries()) {
            const id = randomUUID(); taskIds.push(id);
            // Exam day is a goal fact, not a made-up task deadline with an invented time.
            await tx`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,title,minutes,priority,client_key,course_id,source_ids)
              VALUES(${id},${scope.workspaceId},${scope.ownerUserId},${task.title},${task.minutes},${task.priority},
                ${`onboarding:${input.clientKey}:${index}`},${courseId},${input.sourceIds})`;
          }
        }
        const result = { completed: true, needsOnboarding: false, courseId, taskIds };
        const record = { version: 1, requestHash, result, goal: seed?.goal ?? null, presetVersion: seed?.presetVersion ?? null, completedAt: new Date().toISOString() };
        await tx`INSERT INTO workspace_preferences(workspace_id,opening_onboarding,planning_settings)
          VALUES(${scope.workspaceId},${tx.json(record)},${seed ? tx.json(seed.settings) : null})
          ON CONFLICT(workspace_id) DO UPDATE SET opening_onboarding=EXCLUDED.opening_onboarding,
            planning_settings=COALESCE(workspace_preferences.planning_settings,EXCLUDED.planning_settings),updated_at=now()`;
        return result;
      });
    },
  };
}
