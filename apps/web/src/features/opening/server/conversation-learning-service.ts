import "server-only";
import { createHash } from "node:crypto";
import {
  type ConversationLearningPreview,
  type ConversationSkillEvidence,
  type LearningSummaryAggregate,
  type Scope,
  type TimeBlock,
} from "@aistudy/contracts";
import {
  addLocalDays,
  deriveDayBlocks,
  localDateKeyInZone,
  previewConversationLearningLoop,
  resolveLocalDayBounds,
  summarizeLearningAggregate,
} from "@aistudy/domain";
import {
  createOpeningKnowledgeRepository,
  createOpeningPlanningSettingsRepository,
  createOpeningPlansRepository,
  listReadySourceIdsForCourse,
  readOpeningCourseLearningSummary,
} from "@aistudy/database";
import type { Sql } from "postgres";
import { ApiError } from "../../auth/service";

/** Do not turn two incompatible requirements with the same label into one success. */
export function toConversationSkillEvidence(groups: readonly LearningSummaryAggregate[]): ConversationSkillEvidence[] {
  const byLabel = new Map<string, LearningSummaryAggregate[]>();
  for (const group of groups) {
    const rows = byLabel.get(group.identity.skillLabel) ?? [];
    rows.push(group);
    byLabel.set(group.identity.skillLabel, rows);
  }
  return [...byLabel.entries()].map(([label, rows]) => {
    const dueRetest = rows.some((row) => row.openChecks.dueCount > 0);
    const qualified = rows.every((row) => summarizeLearningAggregate(row).recentComparableEvidence.status === "observed_independent");
    const sampleCount = rows.reduce((sum, row) => sum + row.sampleCount, 0);
    return {
      label, sampleCount,
      verifiedIndependentCount: rows.reduce((sum, row) =>
        sum + (row.identity.requirementKey
          ? row.latestIndependentVerifiedCurrentCount : row.independentVerifiedCurrentCount), 0),
      dueRetest,
      status: dueRetest ? "needs_review" as const
        : sampleCount === 0 ? "unobserved" as const
          : qualified ? "observed_independent" as const : "needs_check" as const,
    };
  });
}

/** Deterministic and scoped: replaying a suggestion yields the same UUID-shaped preview ID. */
function previewTaskId(workspaceId: string, key: string): string {
  const hex = createHash("sha256").update(workspaceId).update(":").update(key).digest("hex");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-4" + hex.slice(13, 16) + "-8" + hex.slice(17, 20) + "-" + hex.slice(20, 32);
}

export async function previewConversationLearningFromWorkspace(
  sql: Sql,
  scope: Scope,
  input: { courseId: string; message: string; date?: string },
  now = new Date(),
): Promise<ConversationLearningPreview> {
  // Strict owner-scoped reads: never trust model-supplied learner state or schedule.
  const courses = await sql<{ title: string }[]>`
    SELECT c.title FROM courses c
    JOIN workspaces w ON w.id = c.workspace_id AND w.owner_user_id = ${scope.ownerUserId}
    WHERE c.id = ${input.courseId} AND c.workspace_id = ${scope.workspaceId} AND c.archived_at IS NULL`;
  const owned = courses[0];
  if (!owned) throw new ApiError("NOT_FOUND", "课程不存在或无法访问。", 404);

  const plans = createOpeningPlansRepository(sql);
  const settings = await createOpeningPlanningSettingsRepository(sql).get(scope);
  const timeZone = settings.settings?.timeZone ?? "Asia/Shanghai";
  const today = localDateKeyInZone(now, timeZone);
  const date = input.date ?? today;
  resolveLocalDayBounds(date, timeZone);
  if (date < today || date > addLocalDays(today, 14)) {
    throw new ApiError("VALIDATION", "只能预览今天起14天内的学习安排。", 422);
  }

  const [knowledge, sourceIds, tasks, accepted] = await Promise.all([
    createOpeningKnowledgeRepository(sql).get(scope, input.courseId),
    listReadySourceIdsForCourse(sql, scope, input.courseId),
    plans.listTasks(scope),
    plans.getToday(scope, date),
  ]);

  // A partial or updating aggregate is NOT evidence of zero observations.
  const groups: LearningSummaryAggregate[] = [];
  let cursor: string | null = null;
  let summaryComplete = true;
  for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
    const page = await readOpeningCourseLearningSummary(sql, scope, {
      courseId: input.courseId, limit: 50,
      ...(cursor ? { groupCursor: cursor } : {}),
    });
    if (page.status !== "ready") {
      summaryComplete = false;
      break;
    }
    groups.push(...page.groups);
    cursor = page.nextCursor;
    if (!cursor) break;
    if (pageNumber === 3) summaryComplete = false;
  }
  const skills = toConversationSkillEvidence(groups);
  const knownTopics = [
    ...skills.map((skill) => skill.label),
    ...(knowledge?.snapshot.nodes ?? []).map((node) => node.label),
  ];
  let freeBlocks: TimeBlock[] | null = null;
  if (settings.saved && !settings.invalidStoredSettings && settings.settings) {
    try {
      freeBlocks = deriveDayBlocks(date, settings.settings, await plans.listTimetable(scope));
    } catch {
      // A missing period/clock map cannot become invented free time.
      freeBlocks = null;
    }
  }

  return previewConversationLearningLoop({
    courseId: input.courseId, courseTitle: owned.title, message: input.message,
    date, timeZone, now, skills, knownTopics, summaryComplete,
    hasUsableMaterials: sourceIds.length > 0,
    tasks, acceptedBlocks: accepted?.blocks ?? [], freeBlocks,
    idFor: (key) => previewTaskId(scope.workspaceId, key),
  });
}
