import { subscribeOpeningPrivacyChange } from "../client/privacy-change";
import type { CourseLearningHistoryInput, CourseLearningHistoryPage, LearningObservation } from "@aistudy/contracts";

export type CourseHistoryState = {
  status: "idle" | "loading" | "ready" | "loading_more" | "error";
  observations: LearningObservation[];
  snapshotRevision: number | null;
  totalCount: number | null;
  nextCursor: string | null;
  snapshotKey: number;
  notice: string;
  error: string;
};
export const emptyCourseHistory = (): CourseHistoryState => ({
  status: "idle", observations: [], snapshotRevision: null, totalCount: null, nextCursor: null,
  snapshotKey: 0, notice: "", error: "",
});
const privacyNotice = "记录可见性已变化，已清空旧页并重新读取当前首页。";

/** One course/filter scope. Append retains card identity; refresh removes old card caches. */
export function createCourseHistoryController(
  request: (input: CourseLearningHistoryInput) => Promise<CourseLearningHistoryPage>,
  scope: { courseId: string; requirementKey?: string | null },
  publish: (state: CourseHistoryState) => void,
) {
  let state = emptyCourseHistory();
  let generation = 0;
  let unsubscribe: (() => void) | null = null;
  const input = { ...scope, limit: 50 };
  function update(next: CourseHistoryState) { state = next; publish(next); }
  async function load(append: boolean, notice = "") {
    if (append && (state.status !== "ready" || !state.nextCursor)) return;
    const previous = state;
    const current = ++generation;
    update(append ? { ...state, status: "loading_more", error: "" }
      : { ...emptyCourseHistory(), status: "loading", snapshotKey: current, notice });
    try {
      let page = await request({ ...input, ...(append ? { cursor: previous.nextCursor! } : {}) });
      if (generation !== current) return;
      if (page.visibilityChanged) {
        update({ ...emptyCourseHistory(), status: "loading", snapshotKey: current, notice: privacyNotice });
        page = await request(input);
        if (generation !== current) return;
        if (page.visibilityChanged) throw new Error("记录可见性仍在变化，请手动刷新历史。");
        append = false;
      }
      if (append && page.snapshotRevision !== previous.snapshotRevision) throw new Error("历史快照已变化，请刷新后重新翻阅。");
      update({ ...state, status: "ready", observations: append ? [...previous.observations, ...page.observations] : page.observations,
        snapshotRevision: page.snapshotRevision, totalCount: page.totalCount, nextCursor: page.nextCursor, error: "" });
    } catch (error) {
      if (generation !== current) return;
      update({ ...emptyCourseHistory(), status: "error", snapshotKey: current, notice: state.notice,
        error: error instanceof Error ? error.message : "课程历史暂时无法读取，请刷新后重试。" });
    }
  }
  return {
    start() {
      unsubscribe?.();
      unsubscribe = subscribeOpeningPrivacyChange(() => { void load(false, privacyNotice); });
      return load(false);
    },
    refresh: () => load(false),
    loadMore: () => load(true),
    cancel() { generation += 1; unsubscribe?.(); unsubscribe = null; },
  };
}
