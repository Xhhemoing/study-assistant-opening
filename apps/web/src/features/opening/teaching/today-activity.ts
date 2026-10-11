import type {
  TeachingActivity,
  TeachingActivityCreateInput,
  TeachingActivityGenerateStatus,
  TeachingActivityStatus,
} from "@aistudy/contracts";

const RESUMABLE: ReadonlySet<TeachingActivityStatus> = new Set(["active", "paused"]);

/** Most recently updated active/paused activity, or null. */
export function pickCurrentTeachingActivity(
  activities: readonly TeachingActivity[],
): TeachingActivity | null {
  const resumable = activities.filter((row) => RESUMABLE.has(row.status));
  if (!resumable.length) return null;
  return [...resumable].sort((a, b) => {
    const byTime = b.updatedAt.localeCompare(a.updatedAt);
    return byTime !== 0 ? byTime : b.id.localeCompare(a.id);
  })[0]!;
}

export function todayActivityCtaLabel(activity: TeachingActivity | null): "继续学习" | "开始学习" {
  return activity ? "继续学习" : "开始学习";
}

const GENERATE_STATUS_LABEL: Record<TeachingActivityGenerateStatus, string> = {
  queued: "生成排队中",
  generating: "正在生成主讲内容",
  needs_check: "生成结果待核对",
  ready: "主讲内容已就绪",
  failed: "生成失败",
  unknown: "生成状态未知",
  cancelled: "生成已取消",
  stale: "生成结果已过期",
};

const STATUS_LABEL: Record<TeachingActivityStatus, string> = {
  active: "进行中",
  paused: "已暂停",
  completed: "已完成",
  skipped: "已跳过",
};

export function teachingActivityStatusLabel(status: TeachingActivityStatus): string {
  return STATUS_LABEL[status];
}

export function teachingActivityGenerateStatusLabel(
  generateStatus: TeachingActivityGenerateStatus,
): string {
  return GENERATE_STATUS_LABEL[generateStatus];
}

/** Honest: ready does not imply UI can show full AI 主讲 blocks yet (V2-08+). */
export function teachingActivityContentHonesty(generateStatus: TeachingActivityGenerateStatus): string {
  if (generateStatus === "ready") {
    return "活动记录已就绪；完整 AI 主讲内容仍可能尚未接入本页，不会伪造讲义。";
  }
  if (generateStatus === "queued" || generateStatus === "generating") {
    return "主讲内容仍在准备中，请稍后继续；此处不会假装已有讲义。";
  }
  if (generateStatus === "failed" || generateStatus === "cancelled" || generateStatus === "stale") {
    return "当前无法展示主讲内容；可稍后重试或改用自由对话。";
  }
  if (generateStatus === "needs_check") {
    return "生成结果待核对，本页不自动当作可讲内容。";
  }
  return "生成状态未知，本页不展示虚构主讲内容。";
}

export type StartLearningContext = {
  /** Local calendar date YYYY-MM-DD for idempotent clientKey. */
  localDate: string;
  continueTitle?: string | null;
  continueConversationId?: string | null;
};

/** Build create input for Today「开始学习」— honest summary + idempotent clientKey. */
export function buildStartLearningCreateInput(
  ctx: StartLearningContext,
): TeachingActivityCreateInput {
  if (ctx.continueConversationId && ctx.continueTitle) {
    const summary = `继续：${ctx.continueTitle}`.slice(0, 2000);
    return {
      clientKey: `today-resume:${ctx.localDate}:${ctx.continueConversationId}`,
      intentKind: "resume",
      intentSummary: summary,
      createIntent: {
        intentKind: "resume",
        source: "today",
        conversationId: ctx.continueConversationId,
        localDate: ctx.localDate,
      },
    };
  }
  const summary = "今日主题学习";
  return {
    clientKey: `today-topic:${ctx.localDate}`,
    intentKind: "topic",
    intentSummary: summary,
    createIntent: {
      intentKind: "topic",
      source: "today",
      localDate: ctx.localDate,
    },
  };
}

export function formatActivityUpdatedAt(iso: string, timeZone = "Asia/Shanghai"): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(ms));
  } catch {
    return iso;
  }
}
