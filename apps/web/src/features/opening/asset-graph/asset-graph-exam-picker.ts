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
  needs_correction: 2,
  due_retest: 1,
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
  pendingRetest: boolean;
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
      taskContext: Extract<CourseRouteTaskContext, { managed: true }> & { retestId: string };
    }
  | {
      kind: "unbound_retest";
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

    const dueRetest = isDelayedRetestDue(progress, asOfMs);
    const pendingRetest = progress.delayedCheck?.status === "pending";

    let bucket: ExamPickerBucket | null = null;
    if (dueRetest) {
      bucket = "due_retest";
    } else if (progress.status === "needs_correction") {
      bucket = "needs_correction";
    } else if (
      pendingRetest ||
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
      pendingRetest,
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

/** Match the live task to the exact delayed check in the current route snapshot. */
export function resolveRetestTaskBinding(
  taskContext: CourseRouteTaskContext | null | undefined,
  courseId: string,
  progress: CourseRequirementProgress,
  asOfMs: number,
): RetestTaskBindingResolution {
  const delayed = progress.delayedCheck;
  if (
    taskContext &&
    taskContext.managed === true &&
    taskContext.available === true &&
    Number.isInteger(taskContext.expectedTaskVersion) && taskContext.expectedTaskVersion > 0 &&
    progress.status !== "blocked" &&
    isDelayedRetestDue(progress, asOfMs) &&
    taskContext.courseId === courseId &&
    taskContext.taskId === delayed?.taskId &&
    typeof taskContext.retestId === "string" &&
    taskContext.retestId === delayed.retestId &&
    taskContext.notBeforeAt === delayed.notBeforeAt &&
    taskContext.requirementId === progress.requirement.id &&
    taskContext.expectedRequirementRevision === progress.requirement.revision
  ) {
    return {
      kind: "bound_retest",
      label: "开始独立复测",
      taskContext: { ...taskContext, retestId: taskContext.retestId },
    };
  }
  const reason =
    delayed && taskContext?.managed && taskContext.courseId === courseId &&
    taskContext.taskId === delayed.taskId && taskContext.retestId === delayed.retestId &&
    taskContext.requirementId === progress.requirement.id &&
    taskContext.expectedRequirementRevision === progress.requirement.revision && taskContext.reason
      ? taskContext.reason
      : "当前复测任务暂不可直接从此启动，可前往今日任务继续。";
  return {
    kind: "unbound_retest",
    reason,
  };
}
