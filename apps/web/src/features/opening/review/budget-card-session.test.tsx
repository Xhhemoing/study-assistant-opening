// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { LearningCardSession, ReviewQueueItem } from "@aistudy/contracts";
import { BudgetCardSession } from "./budget-card-session";
import type { LearningManagementClient } from "../planning/learning-management-client";
import type { OpeningCardsClient } from "../cards/cards-client";
vi.mock("../../auth/session-identity", () => ({ getVerifiedSessionNamespace: () => "verified-card-test" }));
vi.mock("../cards/card-review-view", () => ({ CardReviewView: ({ onGraded, onBusyChange }: { onGraded: (id: string, result: unknown) => void; onBusyChange: (value: boolean) => void }) => <div><p>受限真实卡片队列</p><button onClick={() => { onBusyChange(false); onGraded(id, { evidence: "saved" }); }}>已收评分回执</button></div> }));
const id = "11111111-1111-4111-8111-111111111111";
const session: LearningCardSession = { activityId: id, status: "active", revision: 1, cardIds: [id], reviewedCardIds: [], budgetMinutes: 10, elapsedSeconds: 0, startedAt: "2026-10-27T00:00:00Z", stoppedAt: null, href: `/opening/review?cardSession=${id}` };
let host: HTMLDivElement, root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear(); window.history.replaceState(null, "", "/opening/review"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function button(text: string) { const node = [...host.querySelectorAll("button")].find(item => item.textContent === text); if (!node) throw new Error(`missing ${text}`); return node; }
function clients() { return { management: { cardSessions: vi.fn(async () => [session]), cardCommand: vi.fn(async () => session) } as unknown as Pick<LearningManagementClient, "cardSessions" | "cardCommand">, cards: { listDue: vi.fn(async () => [{ card: { id } } as ReviewQueueItem]) } as unknown as OpeningCardsClient }; }
async function render(value: ReturnType<typeof clients>, activityId?: string) { await act(async () => root.render(<BudgetCardSession initialActivityId={activityId} client={value.management} cardsClient={value.cards} />)); }
it("requires an explicit timed-session start and leaves normal card review available", async () => { const value = clients(); await render(value); expect(value.management.cardCommand).not.toHaveBeenCalled(); expect(host.textContent).toContain("本次卡片分钟"); expect(host.querySelector('a[href="/opening/review?tab=cards"]')).toBeTruthy(); await act(async () => button("开始本次限时复习").click()); expect(value.management.cardCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "start", budgetMinutes: 10, cardIds: [id], goalIds: [] })); });
it("restores the exact real session without creating a replacement", async () => { const value = clients(); await render(value, id); expect(value.management.cardSessions).toHaveBeenCalledWith(id); expect(value.management.cardCommand).not.toHaveBeenCalled(); expect(host.textContent).toContain("受限真实卡片队列"); });
it("stops with only acknowledged graded cards and the exact activity revision", async () => { const value = clients(); vi.mocked(value.management.cardCommand).mockResolvedValue({ ...session, status: "paused", revision: 2 }); await render(value, id); await act(async () => button("已收评分回执").click()); await act(async () => button("暂停并保存停止点").click()); expect(value.management.cardCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "stop", activityId: id, expectedRevision: 1, reviewedCardIds: [id], reason: "pause" })); });
it("keeps an unknown stop frozen for an identical retry", async () => { const value = clients(); vi.mocked(value.management.cardCommand).mockRejectedValueOnce(new TypeError("lost")); await render(value, id); await act(async () => button("暂停并保存停止点").click()); const original = vi.mocked(value.management.cardCommand).mock.calls[0]; expect(host.textContent).toContain("停止点保存待确认"); await act(async () => button("重新确认这次停止点").click()); expect(vi.mocked(value.management.cardCommand).mock.calls[1]).toEqual(original); });
it("stops at the explicit budget and excludes hidden page time", async () => {
  vi.useFakeTimers();
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    const value = clients(); vi.mocked(value.management.cardSessions).mockResolvedValue([{ ...session, budgetMinutes: 1 }]); vi.mocked(value.management.cardCommand).mockResolvedValue({ ...session, budgetMinutes: 1, status: "completed", revision: 2 });
    await render(value, id);
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(90_000));
    expect(value.management.cardCommand).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => vi.advanceTimersByTimeAsync(40_000));
    expect(value.management.cardCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "stop", elapsedSeconds: 60, reason: "time_used", reviewedCardIds: [] }));
  } finally { vi.useRealTimers(); }
});
it.each([401, 409])("keeps an unknown stop intent after retry status %s", async status => { const { LearningManagementRequestError } = await import("../planning/learning-management-client"); const value = clients(); vi.mocked(value.management.cardCommand).mockRejectedValueOnce(new TypeError("lost")).mockRejectedValueOnce(new LearningManagementRequestError("请核对", status)); await render(value, id); await act(async () => button("暂停并保存停止点").click()); const original = vi.mocked(value.management.cardCommand).mock.calls[0]; await act(async () => button("重新确认这次停止点").click()); await act(async () => button("重新读取卡片活动").click()); expect(host.textContent).toContain("停止点保存待确认"); await act(async () => button("重新确认这次停止点").click()); expect(vi.mocked(value.management.cardCommand).mock.calls[2]).toEqual(original); });
