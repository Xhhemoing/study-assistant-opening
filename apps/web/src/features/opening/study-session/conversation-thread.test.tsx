// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StudySession, StudySessionShell } from "./study-session-shell";
import type { ConversationEntry, QuestionStep, StudySessionPort, StudySessionView } from "./model";

vi.mock("../v3/motion/view-transition", () => ({ useTransitionRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }) }));

beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ""; });

const question: QuestionStep = { kind: "question", id: "q", title: "span", prompt: "求系数", purpose: "practice", estimateMinutes: null, photo: false, coordinates: 3 };
const base: StudySessionView = { step: question, position: { index: 1, total: 4 }, help: { level: "none", hints: [], next: null }, answer: {}, sealed: false, result: null, next: null, photo: null };
const learn = (id: string): StudySessionView => ({ ...base, step: { kind: "learn", id, title: `讲解 ${id}`, body: `正文 ${id}`, estimateMinutes: null } });
const noop = () => {};
const handlers = { onPrimary: noop, onHelp: noop, onPause: noop, onReload: noop, onEdit: noop, onChoosePhoto: noop, onRemovePhoto: noop };

function mountShell() {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  const render = (view: StudySessionView, conversation?: { history: ConversationEntry[] }) =>
    act(() => root.render(<StudySessionShell view={view} conversation={conversation} {...handlers} onRedo={noop} onContinue={noop} />));
  return { host, render, unmount: () => act(() => root.unmount()) };
}

/** A port that walks through the given views, one per primary action. */
async function mountSession(views: StudySessionView[]) {
  let index = 0;
  const port: StudySessionPort = { load: async () => views[0]!, primary: async () => views[++index]!, edit: () => views[index]!,
    help: async () => views[index]!, choosePhoto: async () => views[index]!, removePhoto: () => views[index]!, pause: async () => undefined };
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<StudySession port={port} />));
  const next = () => act(async () => host.querySelector<HTMLButtonElement>("[data-primary-action]")!.click());
  const history = () => [...host.querySelectorAll("ol[aria-label='学习对话'] li[aria-label^='已完成']")];
  return { host, next, history, unmount: () => act(async () => root.unmount()) };
}

it("moves the previous step into read-only history when the step changes", async () => {
  const sealed: StudySessionView = { ...base, sealed: true, answerSummary: "属于 span；α = 2，β = -1", result: { outcome: "incorrect", assistance: "independent" } };
  const ui = await mountSession([learn("a"), sealed, learn("b")]);
  try {
    expect(ui.history()).toHaveLength(0);
    await ui.next();
    expect(ui.history()).toHaveLength(1);
    expect(ui.history()[0]!.querySelector("summary")?.textContent).toBe("讲解 a");
    expect(ui.history()[0]!.querySelector("details")!.open).toBe(false);
    await ui.next();
    const [first, second] = ui.history();
    expect(second!.textContent).toContain("求系数");
    expect(second!.textContent).toContain("我的作答：属于 span；α = 2，β = -1");
    expect(second!.textContent).toContain("还没对，原答案已保留");
    for (const entry of [first!, second!]) expect(entry.querySelectorAll("input, select, textarea, button, fieldset, [data-primary-action]")).toHaveLength(0);
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
  } finally { await ui.unmount(); }
});

it("does not repeat a step that comes back, and keeps only the latest 20 entries", async () => {
  const revisit = await mountSession([learn("a"), learn("b"), learn("a"), learn("b")]);
  try {
    await revisit.next(); await revisit.next(); await revisit.next();
    expect(revisit.history().map(entry => entry.getAttribute("aria-label"))).toEqual(["已完成：讲解 b", "已完成：讲解 a"]);
  } finally { await revisit.unmount(); }
  const long = await mountSession(Array.from({ length: 23 }, (_, index) => learn(String(index))));
  try {
    for (let step = 0; step < 22; step++) await long.next();
    const titles = long.history().map(entry => entry.querySelector("summary")?.textContent);
    expect(titles).toHaveLength(20);
    expect(titles[0]).toBe("讲解 2");
    expect(titles.at(-1)).toBe("讲解 21");
  } finally { await long.unmount(); }
});

it("puts the only primary action into the successor card, with the notice visible and the reason folded", () => {
  const ui = mountShell();
  try {
    ui.render({ ...base, result: { outcome: "correct", assistance: "independent" },
      next: { href: "/x", label: "回到课程", notice: "请先授权导师安排。", reason: "最近两题都卡在同一步", alternatives: [{ href: "/y", label: "回到今日" }] } }, { history: [] });
    const card = ui.host.querySelector("ol[aria-label='学习对话'] > li:last-child section[aria-label='下一步']")!;
    expect(card.getAttribute("aria-live")).toBe("polite");
    expect(card.querySelector("h2")?.textContent).toBe("下一步");
    expect(card.querySelector("[data-primary-action]")?.textContent).toBe("回到课程");
    expect(ui.host.querySelector("footer [data-primary-action]")).toBeNull();
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
    expect(ui.host.querySelector("footer")!.textContent).toContain("提示");
    const notice = [...card.querySelectorAll("p")].find(node => node.textContent === "请先授权导师安排。");
    expect(notice?.closest("details")).toBeNull();
    const why = card.querySelector("details")!;
    expect(why.open).toBe(false);
    expect(why.textContent).toContain("最近两题都卡在同一步");
    expect(card.querySelector("a[href='/y']")?.textContent).toBe("回到今日");
    // The feedback no longer repeats the successor notice.
    expect(ui.host.querySelector("section[aria-label='作答结果']")!.textContent).not.toContain("请先授权导师安排。");
  } finally { ui.unmount(); }
});

it("keeps exactly one primary action in every conversation state", () => {
  const ui = mountShell();
  const incorrect = { outcome: "incorrect" as const, assistance: "hinted" as const };
  const states: [StudySessionView, "footer" | "card"][] = [
    [base, "footer"], [{ ...base, answer: { membership: "in_span" } }, "footer"], [{ ...base, sealed: true, answerSummary: "属于 span" }, "footer"],
    [{ ...base, result: incorrect, canRedo: true }, "footer"],
    [{ ...base, result: incorrect, canRedo: true, next: { href: "/x", label: "回到课程", alternatives: [] } }, "footer"],
    [{ ...base, result: { outcome: "correct", assistance: "independent" } }, "card"],
    [{ ...base, result: { outcome: "correct", assistance: "independent" }, canPracticeVariant: true }, "card"],
    [{ ...base, result: { outcome: "needs_manual", assistance: "independent" }, canRedo: true }, "card"],
    [{ ...base, blocked: "资料不可用" }, "footer"], [learn("l"), "footer"],
  ];
  try {
    for (const [view, place] of states) {
      ui.render(view, { history: [{ stepId: "old", title: "旧题", body: "旧题干", resultLabel: "独立答对" }] });
      expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
      expect(ui.host.querySelector(place === "card" ? "section[aria-label='下一步'] [data-primary-action]" : "footer [data-primary-action]")).not.toBeNull();
    }
  } finally { ui.unmount(); }
});

it("shows the sealed answer summary as my answer in the conversation", () => {
  const ui = mountShell();
  try {
    ui.render({ ...base, sealed: true, answerSummary: "不属于 span；α = 2，β = 2" }, { history: [] });
    expect(ui.host.querySelector("ol[aria-label='学习对话'] section[aria-label='我的作答']")?.textContent).toContain("不属于 span；α = 2，β = 2");
    ui.render({ ...base, answerSummary: "不属于 span" }, { history: [] });
    expect(ui.host.querySelector("section[aria-label='我的作答']")).toBeNull();
  } finally { ui.unmount(); }
});

it("without a conversation keeps the single-step layout and the footer primary action", () => {
  const ui = mountShell();
  try {
    ui.render({ ...base, sealed: true, answerSummary: "属于 span", result: { outcome: "correct", assistance: "independent" }, next: { href: "/x", label: "回到课程", notice: "请先授权导师安排。", alternatives: [] } });
    expect(ui.host.querySelector("ol[aria-label='学习对话']")).toBeNull();
    expect(ui.host.querySelector("section[aria-label='下一步']")).toBeNull();
    expect(ui.host.querySelector("section[aria-label='我的作答']")).toBeNull();
    expect(ui.host.querySelector("main > section[aria-label='作答结果']")!.textContent).toContain("请先授权导师安排。");
    expect(ui.host.querySelector("footer [data-primary-action]")?.textContent).toBe("回到课程");
    expect(ui.host.querySelectorAll("[data-primary-action]")).toHaveLength(1);
  } finally { ui.unmount(); }
});
