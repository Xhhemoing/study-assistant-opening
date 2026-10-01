import type { CourseLearningSummaryInput, CourseLearningSummaryPage, LearningSummaryAggregate } from "@aistudy/contracts";
import { subscribeOpeningPrivacyChange } from "../client/privacy-change";

export type CourseSummaryState = {
  status: "idle" | "loading" | "ready" | "loading_more" | "updating" | "error";
  groups: LearningSummaryAggregate[]; snapshotRevision: number | null; evaluatedAt: string | null;
  nextCursor: string | null; pendingProjectionCount: number; notice: string; error: string; snapshotKey: number;
};
export const emptyCourseSummary = (): CourseSummaryState => ({ status: "idle", groups: [], snapshotRevision: null, evaluatedAt: null,
  nextCursor: null, pendingProjectionCount: 0, notice: "", error: "", snapshotKey: 0 });
export const learningSummaryIdentity = (group: LearningSummaryAggregate) => JSON.stringify([
  group.identity.courseId, group.identity.requirementKey, group.identity.skillLabel,
]);

/** A controller owns one course scope. Repair continuation requires explicit server progress. */
export function createCourseSummaryController(
  request: (input: CourseLearningSummaryInput, signal?: AbortSignal) => Promise<CourseLearningSummaryPage>,
  scope: { courseId: string }, publish: (state: CourseSummaryState) => void,
) {
  let state = emptyCourseSummary(), generation = 0, disposed = false;
  let abort: AbortController | null = null, unsubscribe: (() => void) | null = null;
  const input = { courseId: scope.courseId, limit: 10 };
  function update(next: CourseSummaryState) { state = next; publish(next); }
  async function load(append: boolean, notice = "") {
    if (disposed || (append && (state.status !== "ready" || !state.nextCursor))) return;
    const previous = state, current = ++generation;
    abort?.abort(); abort = new AbortController();
    const signal = abort.signal;
    update(append ? { ...state, status: "loading_more", error: "" }
      : { ...emptyCourseSummary(), status: "loading", snapshotKey: current, notice });
    let cursor = append ? previous.nextCursor : null;
    let revision = append ? previous.snapshotRevision : null, evaluatedAt = append ? previous.evaluatedAt : null;
    let previousPending: number | null = null;
    try {
      for (;;) {
        const page = await request({ ...input, ...(cursor ? { groupCursor: cursor } : {}) }, signal);
        if (generation !== current || disposed) return;
        if ((revision !== null && revision !== page.snapshotRevision) || (evaluatedAt !== null && evaluatedAt !== page.evaluatedAt)) {
          throw new Error("学习记录快照已变化，请刷新摘要后继续翻阅。");
        }
        revision = page.snapshotRevision; evaluatedAt = page.evaluatedAt;
        if (page.status === "updating") {
          const progressed = previousPending === null || page.pendingProjectionCount < previousPending;
          update({ ...emptyCourseSummary(), status: "updating", snapshotKey: current, snapshotRevision: revision, evaluatedAt,
            pendingProjectionCount: page.pendingProjectionCount,
            notice: !progressed || !page.nextCursor ? "资格更新暂未推进，请手动刷新摘要。" : "正在更新当前页的证据资格，完成后再显示结论。" });
          if (!progressed || !page.nextCursor) return;
          previousPending = page.pendingProjectionCount; cursor = page.nextCursor;
          continue;
        }
        const groups = append ? [...previous.groups, ...page.groups] : page.groups;
        update({ ...state, status: "ready", groups: [...new Map(groups.map(group => [learningSummaryIdentity(group), group])).values()],
          snapshotRevision: revision, evaluatedAt, pendingProjectionCount: 0, nextCursor: page.nextCursor, notice, error: "" });
        return;
      }
    } catch (error) {
      if (generation !== current || disposed) return;
      const conflict = error !== null && typeof error === "object" && "status" in error && error.status === 409;
      update({ ...emptyCourseSummary(), status: "error", snapshotKey: current, notice,
        error: conflict ? "学习记录已变化，请刷新摘要后继续翻阅。" : error instanceof Error ? error.message : "课程摘要暂时无法读取，请手动刷新。" });
    }
  }
  return {
    start() {
      disposed = false; unsubscribe?.();
      unsubscribe = subscribeOpeningPrivacyChange(() => { void load(false, "记录可见性已变化，旧摘要与代表资格已清空。"); });
      return load(false);
    },
    refresh: () => load(false), loadMore: () => load(true),
    cancel() { disposed = true; generation++; abort?.abort(); unsubscribe?.(); unsubscribe = null; },
  };
}
