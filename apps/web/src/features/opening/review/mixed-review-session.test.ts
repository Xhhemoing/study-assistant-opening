import { describe, expect, it } from "vitest";
import type { ReviewQueueItem, TaskItem } from "@aistudy/contracts";
import { createMixedReviewSession, readMixedReviewSession, resolveMixedReviewSession, reviewEntryKey, saveMixedReviewSession } from "./mixed-review-session";

const ids = Array.from({ length: 6 }, (_, index) => `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`);
const now = Date.parse("2026-10-21T12:00:00Z");
const card = (index: number) => ({ card: { id: ids[index] } }) as ReviewQueueItem;
const task = (index: number, patch: Partial<TaskItem> = {}): TaskItem => ({ id: ids[index]!, title: "复习", minutes: 10, priority: 1, status: "pending", courseId: ids[5], dueAt: null, suggestionKind: "weak_skill", ...patch });

describe("continuous review queue", () => {
  it("alternates real cards with accepted ready tasks and excludes future/ordinary tasks", () => {
    const session = createMixedReviewSession([card(0), card(1)], [task(2), task(3, { notBefore: "2026-10-22T00:00:00Z" }), task(4, { suggestionKind: undefined })], now);
    expect(session.entries).toEqual([{ kind: "card", id: ids[0] }, { kind: "task", id: ids[2] }, { kind: "card", id: ids[1] }]);
  });
  it("keeps a returned pending task active until the server marks it done", () => {
    const session = createMixedReviewSession([], [task(2)], now);
    expect(resolveMixedReviewSession(session, [], [task(2)], now)[0]?.status).toBe("task");
    expect(resolveMixedReviewSession(session, [], [task(2, { status: "done" })], now)[0]?.status).toBe("done");
    expect(resolveMixedReviewSession(session, [], [], now)[0]?.status).toBe("unavailable");
    expect(resolveMixedReviewSession(session, [], [task(2, { status: "skipped" })], now)[0]?.status).toBe("server_skipped");
  });
  it("does not turn a removed card into a completed learning task", () => {
    const session = createMixedReviewSession([card(0)], [], now);
    expect(resolveMixedReviewSession(session, [], [], now)).toEqual([{ entry: session.entries[0], status: "no_longer_due" }]);
  });
  it("rechecks deferred times after a task was added and distinguishes local skipping", () => {
    const session = createMixedReviewSession([], [task(2)], now);
    const delayed = task(2, { notBefore: "2026-10-22T00:00:00Z" });
    expect(resolveMixedReviewSession(session, [], [delayed], now)[0]?.status).toBe("waiting");
    expect(resolveMixedReviewSession(session, [], [delayed], Date.parse(delayed.notBefore!))[0]?.status).toBe("task");
    session.skipped.push(reviewEntryKey(session.entries[0]!));
    expect(resolveMixedReviewSession(session, [], [task(2)], now)[0]?.status).toBe("skipped");
    expect(task(2).status).toBe("pending");
  });
  it("persists navigation under the verified account/workspace and rejects corrupt or fabricated keys", () => {
    const map = new Map<string, string>();
    const storage = { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); } };
    const session = createMixedReviewSession([card(0)], [task(2)], now);
    session.skipped.push(reviewEntryKey(session.entries[0]!));
    saveMixedReviewSession(storage, "owner/workspace", session);
    expect(readMixedReviewSession(storage, "owner/workspace")).toEqual(session);
    expect(readMixedReviewSession(storage, "another/workspace")).toBeNull();
    const key = [...map.keys()][0]!;
    map.set(key, "{");
    expect(() => readMixedReviewSession(storage, "owner/workspace")).toThrow();
    map.set(key, JSON.stringify({ ...session, skipped: [`task:${ids[5]}`] }));
    expect(() => readMixedReviewSession(storage, "owner/workspace")).toThrow();
    map.set(key, JSON.stringify({ ...session, entries: [...session.entries, session.entries[0]] }));
    expect(() => readMixedReviewSession(storage, "owner/workspace")).toThrow();
  });
});
