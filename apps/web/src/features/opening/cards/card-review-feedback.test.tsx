// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GradeReviewResponse, ReviewQueueItem } from "@aistudy/contracts";
import type { OpeningCardsClient } from "./cards-client";

vi.mock("../teaching/learner-state-card", () => ({ LearnerStateCard: () => null }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: { children: React.ReactNode; href: string }) => createElement("a", props, children) }));
import { CardReviewView } from "./card-review-view";

function item(id: string): ReviewQueueItem {
  const at = "2026-10-15T00:00:00.000Z";
  return { card: { id, ownerUserId: "owner", front: `题目 ${id}`, back: `答案 ${id}`, sourceDocumentId: null, syllabusPointId: null, courseId: null, skillLabel: null, tags: [], archived: false, contentVersion: 1, pausedUntil: null, maintainUntil: null, excludeFromAssessment: false, createdAt: at },
    state: { cardId: id, ease: 2.5, intervalDays: 1, dueAt: at, reps: 0, lapses: 0, lastGrade: null, updatedAt: at }, goalPriority: 0 };
}
const result = { evidence: "recorded" } as GradeReviewResponse;
const vibrate = vi.fn();
let container: HTMLDivElement;
let root: Root;
let grade: ReturnType<typeof vi.fn<OpeningCardsClient["grade"]>>;
let client: OpeningCardsClient;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  document.documentElement.dataset.motion = "full";
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false })));
  vi.stubGlobal("navigator", { vibrate });
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vibrate.mockReset().mockReturnValue(true);
  grade = vi.fn<OpeningCardsClient["grade"]>().mockResolvedValue(result);
  client = { listDue: vi.fn().mockResolvedValue([item("a"), item("b")]), grade } as unknown as OpeningCardsClient;
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove(); delete document.documentElement.dataset.motion;
  vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function render(next = client) { await act(async () => root.render(createElement(CardReviewView, { client: next }))); }
function card() { return container.querySelector<HTMLButtonElement>('button[aria-pressed]')!; }
function gradeButton() { return Array.from(container.querySelectorAll("button")).find(button => button.textContent === "记得")!; }
async function reveal() { await act(async () => card().click()); }
async function tick(ms = 200) { await act(async () => vi.advanceTimersByTimeAsync(ms)); }

it("waits for a confirmed grade before sliding left, then raises the next card with one pulse and no repeated request", async () => {
  let confirm!: (value: GradeReviewResponse) => void;
  grade.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await render(); await reveal();
  card().focus();
  await act(async () => {
    card().dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
    card().dispatchEvent(new KeyboardEvent("keydown", { key: "3", bubbles: true }));
  });
  expect(grade).toHaveBeenCalledTimes(1);
  expect(vibrate).not.toHaveBeenCalled();
  expect(container.querySelector('[data-card-transition="exit"]')).toBeNull();
  await act(async () => confirm(result));
  expect(vibrate).toHaveBeenCalledExactlyOnceWith(8);
  expect(container.querySelector('[data-card-transition="exit"]')).not.toBeNull();
  expect(card().textContent).toContain("答案 a");
  expect(card().disabled).toBe(true);
  await tick(199);
  expect(card().textContent).toContain("答案 a");
  await tick(1);
  expect(card().textContent).toContain("题目 b");
  expect(container.querySelector('[data-card-transition="enter"]')).not.toBeNull();
  expect(card().disabled).toBe(false);
  expect(document.activeElement).toBe(card());
  expect(grade).toHaveBeenCalledTimes(1);
});

it("keeps a failed grade on the same card without feedback, and retries with the same intent key", async () => {
  grade.mockRejectedValueOnce(new Error("offline"));
  await render(); await reveal();
  await act(async () => gradeButton().click());
  expect(container.textContent).toContain("offline");
  expect(card().textContent).toContain("答案 a");
  expect(vibrate).not.toHaveBeenCalled();
  expect(container.querySelector('[data-card-transition="exit"]')).toBeNull();
  await act(async () => gradeButton().click());
  expect(grade.mock.calls[1]?.[0]).toEqual(grade.mock.calls[0]?.[0]);
  expect(vibrate).toHaveBeenCalledTimes(1);
  await tick();
  expect(card().textContent).toContain("题目 b");
});

it.each(["user", "system"])("advances immediately without haptics or an exit transition under %s reduced motion", async preference => {
  if (preference === "user") document.documentElement.dataset.motion = "reduce";
  else vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true })));
  await render(); await reveal();
  await act(async () => gradeButton().click());
  expect(card().textContent).toContain("题目 b");
  expect(card().disabled).toBe(false);
  expect(container.querySelector('[data-card-transition="exit"]')).toBeNull();
  expect(vibrate).not.toHaveBeenCalled();
});

it("does not animate or pulse for a late grade from a superseded queue", async () => {
  let confirm!: (value: GradeReviewResponse) => void;
  grade.mockImplementationOnce(() => new Promise(resolve => { confirm = resolve; }));
  await render(); await reveal();
  await act(async () => gradeButton().click());
  await render({ ...client, listDue: vi.fn().mockResolvedValue([item("replacement")]) });
  await act(async () => confirm(result));
  expect(card().textContent).toContain("题目 replacement");
  expect(container.querySelector('[data-card-transition="exit"]')).toBeNull();
  expect(vibrate).not.toHaveBeenCalled();
});

it("finishes the last card after its confirmed exit and emits one success pulse", async () => {
  await render({ ...client, listDue: vi.fn().mockResolvedValue([item("last")]) });
  await reveal();
  await act(async () => gradeButton().click());
  expect(container.textContent).not.toContain("这组记忆卡片已经处理完毕");
  await tick();
  expect(container.textContent).toContain("这组记忆卡片已经处理完毕");
  expect(vibrate).toHaveBeenCalledExactlyOnceWith(8);
});


it("notifies the mixed queue only after a saved grade and keeps navigation busy during an uncertain response", async () => {
  const onGraded = vi.fn();
  const onBusyChange = vi.fn();
  grade.mockRejectedValueOnce(new Error("offline"));
  await act(async () => root.render(createElement(CardReviewView, { client, onGraded, onBusyChange })));
  await reveal();
  await act(async () => gradeButton().click());
  expect(onGraded).not.toHaveBeenCalled();
  expect(onBusyChange.mock.calls.map(call => call[0])).toEqual([true, false]);
  await act(async () => gradeButton().click());
  expect(onGraded).not.toHaveBeenCalled();
  expect(onBusyChange).toHaveBeenLastCalledWith(true);
  await tick();
  expect(onGraded).toHaveBeenCalledExactlyOnceWith("a", result);
  expect(onBusyChange).toHaveBeenLastCalledWith(false);
});
