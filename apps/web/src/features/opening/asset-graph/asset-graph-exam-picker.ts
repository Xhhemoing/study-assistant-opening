import type {
  CourseRequirementProgress,
  CourseRouteSnapshot,
  CourseRouteTaskContext,
} from "@aistudy/contracts";

export const EXAM_PICKER_PRACTICE_MINUTES = 15 as const;

export type ExamPickerBucket =
  | "needs_correction"
  | "due_retest"
  | "pending_verification"
  | "unobserved";

export const EXAM_PICKER_BUCKET_RANK: Record<ExamPickerBucket, number> = {
  needs_correction: 1,
  due_retest: 2,
  pending_verification: 3,
  unobserved: 4,
};

export const EXAM_PICKER_BUCKET_LABELS: Record<ExamPickerBucket, string> = {
  needs_correction: "优先纠错",
  due_retest: "到期复测",
  pending_verification: "待独立检验",
  unobserved: "待开始练习",
};

export type ExamPickerItem = {
  progress: CourseRequirementProgress;
  bucket: ExamPickerBucket;
  dueRetest: boolean;
  retestTaskId: string | null;
  paperMarked: boolean;
};

export type ExamPickerPlan = {
  scopeState: CourseRouteSnapshot["scopeState"];
  totalCount: number;
  verifiedCount: number;
  blockedCount: number;
  items: ExamPickerItem[];
  blockedItems: CourseRequirementProgress[];
  dueRetestTaskIds: string[];
};

export type RetestTaskBindingResolution =
  | {
      kind: "bound_retest";
      label: "开始独立复测";
      taskContext: Extract<CourseRouteTaskContext, { managed: true }>;
    }
  | {
      kind: "unbound_retest";
      ordinaryLabel: "按 15 分钟普通练习开始（不替代复测任务）";
      todayHref: "/opening/today";
      reason: string;
    };

/** Determine whether a requirement's delayed retest is pending and due at or before `asOfMs`. */
export function isDelayedRetestDue(
  progress: CourseRequirementProgress,
  asOfMs: number,
): boolean {
  const delayed = progress.delayedCheck;
  if (!delayed || delayed.status !== "pending" || !delayed.notBeforeAt) {
    return false;
  }
  const notBeforeMs = Date.parse(delayed.notBeforeAt);
  if (!Number.isFinite(notBeforeMs) || !Number.isFinite(asOfMs)) {
    return false;
  }
  return notBeforeMs <= asOfMs;
}

/**
 * Compute full-course 1A exam picking priority without dropping verified+due retests
 * and without mixing blocked requirements into immediate start recommendations.
 */
export function buildCourseExamPickerPlan(
  snapshot: CourseRouteSnapshot,
  options: {
    asOf?: string | null;
    isPaperMarked?: (requirementId: string, revision: number) => boolean;
  } = {},
): ExamPickerPlan {
  const parsedAsOf = options.asOf ? Date.parse(options.asOf) : Number.NaN;
  const asOfMs = Number.isFinite(parsedAsOf) ? parsedAsOf : Date.now();
  const isPaperMarked = options.isPaperMarked ?? (() => false);

  const blockedItems: CourseRequirementProgress[] = [];
  const items: ExamPickerItem[] = [];
  const dueRetestTaskIds: string[] = [];

  for (const progress of snapshot.requirements) {
    if (progress.status === "blocked") {
      blockedItems.push(progress);
      continue;
    }

    // CRITICAL: Check delayed retest due BEFORE skipping status === "verified"!
    const dueRetest = isDelayedRetestDue(progress, asOfMs);

    let bucket: ExamPickerBucket | null = null;
    if (progress.status === "needs_correction") {
      bucket = "needs_correction";
    } else if (dueRetest) {
      bucket = "due_retest";
    } else if (
      progress.status === "assisted" ||
      progress.status === "needs_verification"
    ) {
      bucket = "pending_verification";
    } else if (progress.status === "unobserved") {
      bucket = "unobserved";
    } else if (progress.status === "verified") {
      // Only skip verified requirements that do NOT have a due delayed retest.
      bucket = null;
    }

    if (!bucket) continue;

    const retestTaskId = dueRetest ? (progress.delayedCheck?.taskId ?? null) : null;
    if (retestTaskId && !dueRetestTaskIds.includes(retestTaskId)) {
      dueRetestTaskIds.push(retestTaskId);
    }

    items.push({
      progress,
      bucket,
      dueRetest,
      retestTaskId,
      paperMarked: isPaperMarked(progress.requirement.id, progress.requirement.revision),
    });
  }

  items.sort((a, b) => {
    const bucketDiff = EXAM_PICKER_BUCKET_RANK[a.bucket] - EXAM_PICKER_BUCKET_RANK[b.bucket];
    if (bucketDiff !== 0) return bucketDiff;
    // Tie-breaker 1: Not yet paper-marked in current 2A round first (marked items stay visible).
    if (a.paperMarked !== b.paperMarked) return a.paperMarked ? 1 : -1;
    // Tie-breaker 2: Mandatory requirements first.
    if (a.progress.requirement.mandatory !== b.progress.requirement.mandatory) {
      return a.progress.requirement.mandatory ? -1 : 1;
    }
    // Tie-breaker 3: Requirement position ascending.
    if (a.progress.requirement.position !== b.progress.requirement.position) {
      return a.progress.requirement.position - b.progress.requirement.position;
    }
    return a.progress.requirement.id.localeCompare(b.progress.requirement.id);
  });

  return {
    scopeState: snapshot.scopeState,
    totalCount: snapshot.summary.total,
    verifiedCount: snapshot.summary.verified,
    blockedCount: snapshot.summary.blocked,
    items,
    blockedItems,
    dueRetestTaskIds,
  };
}

/**
 * Enforce the retest task-binding invariant:
 * ONLY when `managed === true && available === true && requirementId === expectedRequirementId`
 * may the UI label the action "开始独立复测" and start the bound retest task.
 */
export function resolveRetestTaskBinding(
  taskContext: CourseRouteTaskContext | null | undefined,
  expectedRequirementId: string,
): RetestTaskBindingResolution {
  if (
    taskContext &&
    taskContext.managed === true &&
    taskContext.available === true &&
    taskContext.requirementId === expectedRequirementId
  ) {
    return {
      kind: "bound_retest",
      label: "开始独立复测",
      taskContext,
    };
  }
  const reason =
    taskContext && taskContext.managed === true && taskContext.reason
      ? taskContext.reason
      : "当前复测任务暂不可直接从此启动，可前往今日任务继续。";
  return {
    kind: "unbound_retest",
    ordinaryLabel: "按 15 分钟普通练习开始（不替代复测任务）",
    todayHref: "/opening/today",
    reason,
  };
}
