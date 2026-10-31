// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { gradeReviewRequestSchema, gradeReviewResponseSchema, type ReviewGrade } from "@aistudy/contracts";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import { CardReviewView } from "./card-review-view";
import { createOpeningCardsClient } from "./cards-client";
import { BudgetCardSession } from "../review/budget-card-session";
import { cardStudySessionView } from "../study-session/adapters/cards";
vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("../../auth/session-identity", () => ({ getVerifiedSessionNamespace: () => "card-v2-test" }));
const id = "11111111-1111-4111-8111-111111111111";
const nextId = "22222222-2222-4222-8222-222222222222";
const at = "2026-10-31T00:00:00.000Z";
function item(cardId = id, tags = ["review:concept"]) {
  return { card: { id: cardId, ownerUserId: id, front: `正面 ${cardId}`, back: `秘密背面 ${cardId}`, sourceDocumentId: null, syllabusPointId: null, courseId: null, skillLabel: null, tags, archived: false, contentVersion: 1, pausedUntil: null, maintainUntil: null, excludeFromAssessment: false, createdAt: at },
    state: { cardId, ease: 2.5, intervalDays: 1, dueAt: at, reps: 0, lapses: 0, lastGrade: null, updatedAt: at }, goalPriority: 0 };
}
function receipt(input: unknown) {
  const parsed = gradeReviewRequestSchema.parse(input);
  return gradeReviewResponseSchema.parse({ state: { ...item(parsed.cardId).state, lastGrade: parsed.grade, reps: 1 }, evidence: "skipped_source_unavailable",
    event: { id, workspaceId: id, ownerUserId: id, type: "review", schemaVersion: 1, idempotencyKey: parsed.idempotencyKey, occurredAt: at, createdAt: at, contentId: parsed.cardId, contentVersion: 1, syllabusPointId: null, correctsEventId: null,
      payload: { grade: parsed.grade, assisted: parsed.assisted, excludeFromAssessment: false } } });
}
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); sessionStorage.clear();
  document.documentElement.dataset.motion = "reduce";
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete document.documentElement.dataset.motion; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
function button(label: string) { const found = [...host.querySelectorAll("button")].find(node => node.textContent === label); if (!found) throw new Error(`missing ${label}`); return found; }
async function click(label: string) { await act(async () => button(label).click()); }
function api(items = [item(), item(nextId)]) {
  const submissions: unknown[] = [];
  const save = vi.fn(async (input: unknown) => receipt(input));
  const transport = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).startsWith("/api/reviews?")) return Response.json({ items });
    const input = JSON.parse(String(init?.body));
    gradeReviewRequestSchema.parse(input); submissions.push(input);
    return Response.json(await save(input));
  });
  return { client: createOpeningCardsClient(transport as typeof fetch), submissions, save, transport };
}
async function render(client: ReturnType<typeof api>["client"], enabled = true, onGraded = vi.fn()) {
  await act(async () => root.render(<OpeningCapabilitiesContext.Provider value={{ ...CLOSED_CAPABILITIES, studySessionV2: enabled }}><CardReviewView client={client} onGraded={onGraded} /></OpeningCapabilitiesContext.Provider>));
}
it("omits the back from the unrevealed view model", () => {
  const view = cardStudySessionView(item(), { index: 0, total: 2 }, false, null);
  expect(JSON.stringify(view)).not.toContain("秘密背面"); expect(view.result).toBeNull();
});
it.each([["again", "重来"], ["hard", "困难"], ["good", "记得"], ["easy", "轻松"]] as const)("saves original %s only after explicit confirmation through the real HTTP client and schemas", async (grade: ReviewGrade, label) => {
  const value = api(); const onGraded = vi.fn(); await render(value.client, true, onGraded);
  expect(host.textContent).not.toContain("秘密背面");
  expect(host.innerHTML).not.toContain(encodeURIComponent("秘密背面"));
  expect(host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
  expect(host.textContent).not.toContain("拍照附上过程"); expect(host.textContent).not.toContain("独立答对");
  await click("翻面核对"); expect(host.textContent).toContain(`秘密背面 ${id}`);
  expect(button("保存回忆情况").disabled).toBe(true);
  await click(label); expect(value.submissions).toHaveLength(0);
  await click("保存回忆情况");
  expect(gradeReviewRequestSchema.parse(value.submissions[0])).toMatchObject({ cardId: id, grade, assisted: false });
  expect(onGraded).toHaveBeenCalledTimes(1);
  expect(host.textContent).toContain(`正面 ${nextId}`); expect(host.textContent).not.toContain(`秘密背面 ${nextId}`);
  expect(host.textContent).toContain(`上一张回忆情况已保存：${label}`); expect(host.textContent).toContain("材料暂不可用");
  await click("翻面核对"); await click(label); await click("保存回忆情况");
  expect(host.textContent).toContain("这组记忆卡片已经处理完毕"); expect(host.textContent).toContain(`上一张回忆情况已保存：${label}`);
});
it("retains card, selected grade and key after failure and advances only on the receipt", async () => {
  const value = api(); value.save.mockRejectedValueOnce(new Error("offline")); const onGraded = vi.fn();
  await render(value.client, true, onGraded); await click("翻面核对"); await click("困难"); await click("保存回忆情况");
  expect(onGraded).not.toHaveBeenCalled(); expect(host.textContent).toContain(`秘密背面 ${id}`); expect(button("困难").getAttribute("aria-pressed")).toBe("true");
  expect(host.querySelector('[role="alert"]')).toBeTruthy();
  let confirm!: (value: ReturnType<typeof receipt>) => void;
  value.save.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await click("保存回忆情况"); expect(button("困难").matches(":disabled")).toBe(true);
  expect(value.submissions[1]).toEqual(value.submissions[0]); expect(onGraded).not.toHaveBeenCalled();
  await act(async () => confirm(receipt(value.submissions[1]))); expect(onGraded).toHaveBeenCalledTimes(1); expect(host.textContent).toContain(`正面 ${nextId}`);
});
it("keeps legacy flip and immediate grading when the flag is off", async () => {
  const value = api(); await render(value.client, false);
  expect(host.querySelector("[data-primary-action]")).toBeNull();
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-pressed]')!.click());
  await click("记得"); expect(value.submissions).toHaveLength(1); expect(host.textContent).toContain(`正面 ${nextId}`);
});
it("keeps unclassified cards in the original classification branch", async () => {
  const value = api([item(id, [])]); await render(value.client);
  expect(host.querySelector("[data-primary-action]")).toBeNull(); expect(button("题目：做新变式")).toBeTruthy(); expect(button("定义或术语：翻卡回忆")).toBeTruthy();
});
it("keeps question cards on the original variant branch without grading or a new shell", async () => {
  const value = api([item(id, ["review:question"])]);
  const startVariant = vi.fn().mockRejectedValue(new Error("not ready"));
  await render({ ...value.client, startVariant });
  expect(startVariant).toHaveBeenCalledWith(id, false);
  expect(host.querySelector('[aria-label="变式复习"]')).toBeTruthy();
  expect(host.querySelector("[data-primary-action]")).toBeNull(); expect(value.submissions).toHaveLength(0);
});
it("waits for an in-flight real card receipt at the time limit, then stops with that confirmed card only", async () => {
  vi.useFakeTimers(); vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const value = api();
  const session = { activityId: id, status: "active" as const, revision: 1, cardIds: [id, nextId], reviewedCardIds: [], budgetMinutes: 1, elapsedSeconds: 59, startedAt: at, stoppedAt: null, href: `/opening/review?cardSession=${id}` };
  const management = { cardSessions: vi.fn(async () => [session]), cardCommand: vi.fn(async () => ({ ...session, status: "completed" as const, revision: 2 })) };
  await act(async () => root.render(<OpeningCapabilitiesContext.Provider value={{ ...CLOSED_CAPABILITIES, studySessionV2: true }}><BudgetCardSession initialActivityId={id} client={management} cardsClient={value.client} /></OpeningCapabilitiesContext.Provider>));
  await click("翻面核对"); await click("重来");
  let confirm!: (value: ReturnType<typeof receipt>) => void;
  value.save.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await click("保存回忆情况");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(management.cardCommand).not.toHaveBeenCalled(); expect(button("重来").matches(":disabled")).toBe(true);
  await act(async () => confirm(receipt(value.submissions[0])));
  expect(management.cardCommand).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ action: "stop", reason: "time_used", elapsedSeconds: 60, reviewedCardIds: [id] }));
});
it("the real timed owner excludes failed grades, locks stop while saving and records only confirmed IDs", async () => {
  const value = api(); value.save.mockRejectedValueOnce(new Error("offline"));
  const session = { activityId: id, status: "active" as const, revision: 1, cardIds: [id, nextId], reviewedCardIds: [], budgetMinutes: 1, elapsedSeconds: 0, startedAt: at, stoppedAt: null, href: `/opening/review?cardSession=${id}` };
  const management = { cardSessions: vi.fn(async () => [session]), cardCommand: vi.fn(async () => ({ ...session, status: "paused" as const, revision: 2 })) };
  await act(async () => root.render(<OpeningCapabilitiesContext.Provider value={{ ...CLOSED_CAPABILITIES, studySessionV2: true }}><BudgetCardSession initialActivityId={id} client={management} cardsClient={value.client} /></OpeningCapabilitiesContext.Provider>));
  await click("翻面核对"); await click("轻松"); await click("保存回忆情况"); expect(host.textContent).toContain("已确认评分 0/2 张");
  let confirm!: (value: ReturnType<typeof receipt>) => void;
  value.save.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await click("保存回忆情况"); expect(button("暂停并保存停止点").disabled).toBe(true); expect(button("结束本次复习").disabled).toBe(true);
  await act(async () => confirm(receipt(value.submissions[1]))); expect(host.textContent).toContain("已确认评分 1/2 张");
  await click("暂停并保存停止点"); expect(management.cardCommand).toHaveBeenCalledWith(expect.objectContaining({ action: "stop", reviewedCardIds: [id], expectedRevision: 1 }));
  expect(value.submissions[1]).toEqual(value.submissions[0]);
});
