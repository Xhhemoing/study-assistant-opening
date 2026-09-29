import { taskCreateInputSchema } from "@aistudy/contracts";
import { OpeningApiError, type OpeningApi } from "../client/api";
import { reviewItemKey, reviewItems, type ReviewAction, type ReviewCommand, type ReviewDraft, type ReviewItem, type ReviewOutcome } from "./review-types";

export type ReviewApi = Pick<OpeningApi, "listCandidates" | "listRetestCandidates" | "listSources" | "createTask" | "discardCandidate" | "acceptRetest" | "decideMemoryCandidate">;
export async function loadReviewItems(api: ReviewApi): Promise<ReviewItem[]> {
  const [assistant, retests, sources] = await Promise.all([api.listCandidates(), api.listRetestCandidates(), api.listSources()]);
  return reviewItems(assistant, retests, sources);
}
export function retainUnconfirmedReviews(previous: ReviewItem[], fresh: ReviewItem[], pending: (item: ReviewItem) => unknown): ReviewItem[] {
  const ids = new Set(fresh.map(reviewItemKey));
  return [...fresh, ...previous.filter((item) => !ids.has(reviewItemKey(item)) && pending(item))];
}
const localTime = (time: Date) => new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
export function initialReviewDraft(item: ReviewItem, now = new Date()): ReviewDraft {
  const task = item.proposal.kind === "task" ? item.proposal : null;
  return { title: task?.title ?? "", minutes: String(task?.minutes ?? 20), priority: "1", dueAt: "",
    dueText: task?.dueText ?? "", expiresAt: localTime(new Date(now.getTime() + 86_400_000)) };
}
function instant(text: string): string {
  const value = new Date(text);
  if (!text || !Number.isFinite(value.getTime())) throw new Error("请填写有效的日期和时间。");
  return value.toISOString();
}
export function prepareReviewCommand(item: ReviewItem, draft: ReviewDraft, action: ReviewAction, clientKey: string): ReviewCommand {
  if (item.proposal.kind === "memory") {
    return { kind: "memory", input: { id: item.ref.id, expectedVersion: item.version, clientKey,
      action: action === "accept" ? "confirm" : "reject",
      expiresAt: action === "accept" && item.proposal.temporary ? instant(draft.expiresAt) : null } };
  }
  if (action === "discard") return { kind: "discard", ref: item.ref, clientKey };
  if (item.proposal.kind === "retest") return { kind: "retest", id: item.ref.id, clientKey };
  return { kind: "task", input: taskCreateInputSchema.parse({ candidateId: item.ref.id, candidateRef: item.ref,
    expectedVersion: item.version, clientKey, title: draft.title.trim(), minutes: Number(draft.minutes),
    priority: Number(draft.priority), dueAt: draft.dueAt ? instant(draft.dueAt) : null,
    dueText: draft.dueAt ? null : draft.dueText.trim() || null }) };
}
async function execute(api: ReviewApi, command: ReviewCommand): Promise<ReviewOutcome> {
  switch (command.kind) {
    case "task": {
      const task = await api.createTask(command.input);
      return { kind: "task", task, label: task.reviewResult?.disposition === "already_processed" ? "已有任务，未重复创建" : "任务已接受" };
    }
    case "memory": {
      const memory = await api.decideMemoryCandidate(command.input);
      return command.input.action === "reject" ? { kind: "discarded", label: "已选择不记住" }
        : { kind: "memory", memory, label: "记忆已确认" };
    }
    case "retest": {
      const response = await api.acceptRetest(command.id, command.clientKey);
      return { kind: "retest", taskId: response.taskId, label: "补测已加入任务，尚未安排到日历" };
    }
    case "discard":
      await api.discardCandidate(command.ref, command.clientKey);
      return { kind: "discarded", label: "已忽略这条建议" };
  }
}
/** Keep the exact submitted intent/key through an uncertain response; never silently re-key. */
export function createReviewActions(api: ReviewApi, newKey = () => crypto.randomUUID()) {
  const commands = new Map<string, { action: ReviewAction; command: ReviewCommand }>();
  const completed = new Map<string, ReviewOutcome>();
  return {
    pending(item: ReviewItem) { return commands.get(reviewItemKey(item)); },
    async submit(item: ReviewItem, draft: ReviewDraft, action: ReviewAction): Promise<ReviewOutcome> {
      const id = reviewItemKey(item), known = completed.get(id);
      if (known) return known;
      let saved = commands.get(id);
      if (saved && saved.action !== action) throw new Error("上次请求结果尚未确认，请先重试原操作。");
      if (!saved) {
        saved = { action, command: prepareReviewCommand(item, draft, action, newKey()) };
        commands.set(id, saved);
      }
      try {
        const result = await execute(api, saved.command);
        completed.set(id, result);
        commands.delete(id);
        return result;
      } catch (error) {
        if (error instanceof OpeningApiError && (error.status === 400 || error.status === 422)) commands.delete(id);
        throw error;
      }
    },
  };
}
