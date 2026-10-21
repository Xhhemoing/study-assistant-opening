import { z } from "zod";
import type { ReviewQueueItem, TaskItem } from "@aistudy/contracts";
import { groupReviewTasks, type ReviewTask } from "./review-queue";

const entrySchema = z.object({ kind: z.enum(["card", "task"]), id: z.string().uuid() }).strict();
const sessionSchema = z.object({ version: z.literal(1), entries: z.array(entrySchema).max(2000), skipped: z.array(z.string().max(50)).max(2000) }).strict();
export type MixedReviewEntry = z.infer<typeof entrySchema>;
export type MixedReviewSession = z.infer<typeof sessionSchema>;
export const reviewEntryKey = (entry: MixedReviewEntry): string => `${entry.kind}:${entry.id}`;

/** Local session state is navigation only. It never records scores or marks tasks done. */
export function createMixedReviewSession(cards: ReviewQueueItem[], tasks: TaskItem[], now: number): MixedReviewSession {
  const dueTasks = groupReviewTasks(tasks, now).ready;
  const entries: MixedReviewEntry[] = [];
  for (let index = 0; index < Math.max(cards.length, dueTasks.length); index++) {
    if (cards[index]) entries.push({ kind: "card", id: cards[index]!.card.id });
    if (dueTasks[index]) entries.push({ kind: "task", id: dueTasks[index]!.task.id });
  }
  return { version: 1, entries, skipped: [] };
}

export type ResolvedReviewEntry = { entry: MixedReviewEntry } & (
  | { status: "card"; item: ReviewQueueItem }
  | { status: "task"; item: ReviewTask }
  | { status: "skipped" | "no_longer_due" | "done" | "server_skipped" | "waiting" | "unavailable" }
);

/** Missing rows and queue removal do not prove learning completion. */
export function resolveMixedReviewSession(session: MixedReviewSession, cards: ReviewQueueItem[], tasks: TaskItem[], now: number): ResolvedReviewEntry[] {
  const groups = groupReviewTasks(tasks, now);
  return session.entries.map(entry => {
    if (session.skipped.includes(reviewEntryKey(entry))) return { entry, status: "skipped" };
    if (entry.kind === "card") {
      const item = cards.find(item => item.card.id === entry.id);
      return item ? { entry, status: "card", item } : { entry, status: "no_longer_due" };
    }
    const task = tasks.find(item => item.id === entry.id);
    if (task?.status === "done") return { entry, status: "done" };
    if (task?.status === "skipped") return { entry, status: "server_skipped" };
    const item = groups.ready.find(item => item.task.id === entry.id);
    if (item) return { entry, status: "task", item };
    return { entry, status: groups.upcoming.some(item => item.task.id === entry.id) ? "waiting" : "unavailable" };
  });
}

const storageKey = (namespace: string) => `aistudy.review-session.v1:${namespace}`;
export function readMixedReviewSession(storage: Pick<Storage, "getItem">, namespace: string): MixedReviewSession | null {
  const raw = storage.getItem(storageKey(namespace));
  if (raw === null) return null;
  const parsed = sessionSchema.parse(JSON.parse(raw));
  const keys = parsed.entries.map(reviewEntryKey);
  if (new Set(keys).size !== keys.length || parsed.skipped.some(key => !keys.includes(key))) throw new Error("复习进度无效，请重新开始本轮；已有评分和作答不受影响。");
  return parsed;
}
export function saveMixedReviewSession(storage: Pick<Storage, "setItem">, namespace: string, session: MixedReviewSession): void {
  storage.setItem(storageKey(namespace), JSON.stringify(session));
}
