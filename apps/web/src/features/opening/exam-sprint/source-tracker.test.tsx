// @vitest-environment jsdom
import type { ExamSourceItem, ExamSprintOverview, SourceRecord } from "@aistudy/contracts";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SourceTracker } from "./source-tracker";
import type { WorkReviewContext } from "./work-review-panel";

const sourceId = "11111111-1111-4111-8111-111111111111";
const courseId = "22222222-2222-4222-8222-222222222222";
const date = "2026-11-12T00:00:00Z";
const versionedDownload = `/api/opening/sources/${sourceId}/download?version=3&disposition=inline`;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function pdf(name: string, overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: sourceId, workspaceId: courseId, name, mime: "application/pdf", bytes: 100, sha256: "a".repeat(64),
    version: 3, uploadState: "uploaded", parseState: "ready", error: null, createdAt: date, ...overrides,
  };
}

async function showItem(sourceTitle: string, boundTitle: string | null, sourcePage: number | null, resource: SourceRecord | null = pdf(sourceTitle)) {
  const item: ExamSourceItem = { id: "q1", topicId: "t1", label: "原题 Q1", sourceTitle, sourcePage, kind: "choice", suggestedDay: 1, skills: [] };
  const overview: ExamSprintOverview = {
    pack: { id: "math-i", version: "1", title: "考前冲刺", description: "", topics: [], lessons: [], sourceItems: [item], weekPlan: [], limitations: [] },
    state: { version: 1, startedAt: date, examDate: null, dailyMinutes: 60, runs: [], sourceRecords: [] },
    attempts: [], lessonContents: [], activeRun: null, currentAttempt: null, skills: [], recommendations: [],
    summary: { sourceTotal: 1, sourceCovered: 0, sourceIndependent: 0, sourceDelayed: 0, onlineAnswered: 0, onlineIndependentCorrect: 0 },
    workload: { remainingItems: 1, estimatedMinutes: null, availableMinutes: null, overloaded: false, message: "" },
  };
  const send = vi.fn();
  const reviewContext: WorkReviewContext = {
    resources: resource ? { courses: [], sources: [resource], goals: {} } : null, review: null, send, refresh: vi.fn(),
    integration: {
      binding: boundTitle ? { courseId, packSourceId: sourceId, boundAt: date, milestoneId: null, skills: [],
        materials: [{ sourceTitle: boundTitle, sourceId, sourceVersion: 3 }] } : null,
      links: [], sourceMappings: [], courseGoal: null,
      bkt: { calibrated: false, eligible: 0, excluded: 0, bktBrier: null, baselineBrier: null, skills: [], message: "" },
    },
  };
  await act(async () => root.render(createElement(SourceTracker, { overview, disabled: false, send, reviewContext })));
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent?.startsWith(item.label))!.click());
  const detail = host.querySelector('[aria-label="原题 Q1 学习登记"]')!;
  const links = [...detail.querySelectorAll("a")].filter(link => !link.closest("details:not([open])"));
  expect(detail.querySelector("form button[type=submit]")).not.toBeNull();
  expect(detail.querySelector("details summary")?.textContent).toContain("AI 过程点评（可选）");
  expect(send).not.toHaveBeenCalled();
  return Object.fromEntries(links.map(link => [link.textContent, link.getAttribute("href")]));
}

it.each([
  ["Topic_1_Example_Test_to_Practice.pdf", 5, "查看答案页"],
  ["Topic_4_Example_Test_to_Practice.pdf", 5, "查看答案页"],
  ["Topic_5_Example_Test_to_Practice.pdf", 6, "查看答案页"],
  ["Topic_3_Example_Problems_to_Practice.pdf", 3, "查看参考解答"],
] as const)("opens the bound %s at the original and answer pages without expanding AI", async (title, answerPage, answerLabel) => {
  expect(await showItem(title, title, 1)).toEqual({
    "打开原题": `${versionedDownload}#page=1`,
    [answerLabel]: `${versionedDownload}#page=${answerPage}`,
  });
});

it("shows only the original file link when its page and answer section are unconfirmed", async () => {
  expect(await showItem("其他练习.pdf", "其他练习.pdf", null)).toEqual({ "打开原题": versionedDownload });
});

const catalogTitle = "Topic_1_Example_Test_to_Practice.pdf";
it.each([
  ["a different filename", pdf("另一份试卷.pdf")],
  ["a different source ID", pdf(catalogTitle, { id: courseId })],
  ["a newer current version than the binding", pdf(catalogTitle, { version: 4 })],
  ["a non-PDF source", pdf(catalogTitle, { mime: "text/plain" })],
  ["resources unavailable", null],
] as const)("keeps only the pinned file link for %s", async (_reason, resource) => {
  expect(await showItem(catalogTitle, catalogTitle, 1, resource)).toEqual({ "打开原题": versionedDownload });
});

it.each([null, "其他练习.pdf"])("does not link an exercise without a matching material binding (%s)", async boundTitle => {
  expect(await showItem("Topic_1_Example_Test_to_Practice.pdf", boundTitle, 1)).toEqual({});
});
