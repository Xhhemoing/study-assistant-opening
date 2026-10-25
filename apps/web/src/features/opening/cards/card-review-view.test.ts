import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GradeReviewResponse, ReviewGrade, ReviewQueueItem } from "@aistudy/contracts";

const scenario = vi.hoisted(() => ({ items: [] as ReviewQueueItem[], grading: false, onGrade: undefined as ((grade: ReviewGrade) => void) | undefined }));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => actual.useState(
      initial && typeof initial === "object" && "kind" in initial && initial.kind === "loading"
        ? { kind: "ready", items: scenario.items, index: 0, flipped: true }
        : initial === false ? scenario.grading : initial,
    ),
  };
});

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: { children: import("react").ReactNode; href: string }) => createElement("a", { ...props, href }, children),
}));
vi.mock("./card-stack", async importOriginal => {
  const actual = await importOriginal<typeof import("./card-stack")>();
  return { CardStack: (props: Parameters<typeof actual.CardStack>[0]) => {
    scenario.onGrade = props.onGrade;
    return createElement(actual.CardStack, props);
  } };
});

import { advanceGradedCard, CardReviewView, cardEvidenceNotice } from "./card-review-view";
import { createOpeningCardsClient } from "./cards-client";

function item(id: string): ReviewQueueItem {
  const at = "2026-10-15T00:00:00.000Z";
  return {
    card: { id, ownerUserId: "owner", front: "问题", back: "答案", sourceDocumentId: null, syllabusPointId: null, courseId: null, skillLabel: null,
      tags: ["review:concept"], archived: false, contentVersion: 1, pausedUntil: null, maintainUntil: null, excludeFromAssessment: false, createdAt: at },
    state: { cardId: id, ease: 2.5, intervalDays: 1, dueAt: at, reps: 0, lapses: 0, lastGrade: null, updatedAt: at },
    goalPriority: 0,
  };
}

beforeEach(() => { scenario.items = []; scenario.grading = false; scenario.onGrade = undefined; });

it("advances only the graded card in the queue that submitted it", () => {
  const ready = { kind: "ready" as const, items: [item("a"), item("b")], index: 0, flipped: true };
  expect(advanceGradedCard(ready, "a", 2, 2)).toEqual({ ...ready, index: 1, flipped: false });
  expect(advanceGradedCard(ready, "a", 1, 2)).toBe(ready);
  expect(advanceGradedCard(ready, "b", 2, 2)).toBe(ready);
  const loading = { kind: "loading" as const };
  expect(advanceGradedCard(loading, "a", 2, 2)).toBe(loading);
});

it("does not skip a replacement queue card when an old grade completes", () => {
  const replacement = { kind: "ready" as const, items: [item("a"), item("b")], index: 0, flipped: false };
  expect(advanceGradedCard(replacement, "a", 1, 2)).toBe(replacement);
  const advanced = { ...replacement, index: 1 };
  expect(advanceGradedCard(advanced, "a", 2, 2)).toBe(advanced);
});

it("disables queue reload while a grade is being saved", () => {
  scenario.items = [item("a")];
  scenario.grading = true;
  const html = renderToStaticMarkup(createElement(CardReviewView));
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-label="重新读取"|<button[^>]*aria-label="重新读取"[^>]*disabled=""/);
});

it("does not submit a second grade when shortcuts fire before React updates the saving state", async () => {
  scenario.items = [item("a")];
  let reject!: (reason: Error) => void;
  const pending = new Promise<GradeReviewResponse>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const client = createOpeningCardsClient();
  client.grade = vi.fn(() => pending);
  renderToStaticMarkup(createElement(CardReviewView, { client }));
  const first = scenario.onGrade!("again"), second = scenario.onGrade!("good");
  expect(client.grade).toHaveBeenCalledTimes(1);
  expect(client.grade).toHaveBeenCalledWith(expect.objectContaining({ cardId: "a", grade: "again" }));
  reject(new Error("offline"));
  await Promise.all([first, second]);
});

it("offers a direct assistant entry when no cards are due", () => {
  const html = renderToStaticMarkup(createElement(CardReviewView));
  expect(html).toMatch(/href="\/opening\/assistant"[^>]*>去助理制成卡片<\/a>/);
});

it("embeds the existing grading flow with a section heading and a return to the unified review", () => {
  scenario.items = [item("a")];
  const html = renderToStaticMarkup(createElement(CardReviewView, { embedded: true }));
  expect(html).toMatch(/<h2[^>]*>记忆卡片<\/h2>/);
  expect(html).not.toContain("<h1");
  expect(html).toContain("显示卡片正面");
  expect(html).toMatch(/<progress[^>]*value="0"[^>]*max="1"[^>]*aria-label="本组卡片已完成"/);
  expect(html).toContain("%2Fopening%2Freview%3Ftab%3Dcards");
});

describe("card review evidence notice", () => {
  it("explains a saved review that did not become a learning fact, and stays quiet otherwise", () => {
    expect(cardEvidenceNotice("skipped_course_archived")).toContain("已归档");
    expect(cardEvidenceNotice("skipped_source_unavailable")).toContain("材料暂不可用");
    expect(cardEvidenceNotice("recorded")).toBe("");
    expect(cardEvidenceNotice("skipped_no_course")).toBe("");
    expect(cardEvidenceNotice(undefined)).toBe("");
  });
});
