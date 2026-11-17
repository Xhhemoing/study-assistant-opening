// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MaterialCourseFullPackage } from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { MaterialWorkbench } from "./material-workbench";

const inputPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
const load = (): MaterialCourseFullPackage => {
  const bytes = readFileSync(inputPath!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  return JSON.parse(bytes.toString());
};
const render = (input: MaterialCourseFullPackage | null) => renderToStaticMarkup(createElement(MaterialWorkbench, { input }));
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = (input: MaterialCourseFullPackage | null) => act(() => root.render(createElement(MaterialWorkbench, { input })));
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const panel = () => host.querySelector<HTMLElement>('[role="tabpanel"]:not([hidden])')!;
const skills = () => [...panel().querySelectorAll<HTMLButtonElement>("nav button")];
function key(node: HTMLElement, value: string) {
  act(() => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })));
}
function search(value: string) {
  const input = panel().querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("current workbench composition", () => {
  it("closes the entire composition on missing input without exposing children", () => {
    const html = render(null);
    expect(html).toContain('role="alert"'); expect(html).not.toContain("主诊断入口"); expect(html).not.toContain("技能列表");
  });
});

describe.skipIf(!inputPath)("041fc627 → R3 → real preview and route", () => {
  it("renders the real current preview in SSR and mounts the actual route on its local tab", () => {
    const input = load(), before = JSON.stringify(input), html = render(input);
    expect(html).toContain("资料工作台 · 候选未发布"); expect(html).toContain("主诊断入口");
    expect(html).toContain("不是首答界面"); expect(html).toContain("独立条件未知");
    expect(html).not.toMatch(/<(form|script)\b/);
    mount(input); act(() => tabs()[1]!.click());
    expect(panel().textContent).toContain("技能先修路线"); expect(skills()).toHaveLength(77);
    for (const skill of input.skills) {
      const button = skills().find(node => node.textContent?.startsWith(skill.title))!;
      expect(button.textContent).toContain(`Topic ${skill.topic} · 未测`);
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("never renders postAttemptNotes, objectives or errors across preview and all real route details", () => {
    const input = load();
    input.questions.forEach(q => { q.postAttemptNotes = "PRIVATE_FEEDBACK_SENTINEL"; });
    input.skills.forEach(s => { s.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"]; s.commonErrors = ["PRIVATE_ERROR_SENTINEL"]; });
    expect(render(input)).not.toMatch(/PRIVATE_(FEEDBACK|OBJECTIVE|ERROR)_SENTINEL/);
    mount(input);
    for (const tab of tabs()) {
      act(() => tab.click());
      expect(host.innerHTML).not.toMatch(/PRIVATE_(FEEDBACK|OBJECTIVE|ERROR)_SENTINEL/);
      if (tab === tabs()[1]) for (const button of skills()) {
        act(() => button.click());
        expect(host.innerHTML).not.toMatch(/PRIVATE_(FEEDBACK|OBJECTIVE|ERROR)_SENTINEL/);
      }
    }
    expect(host.querySelectorAll('textarea, form, button[type="submit"]')).toHaveLength(0);
    expect(host.textContent).toContain("不是首答");
  });

  it("shows genuine concept bridges as optional, unmeasured and without mastery credit", () => {
    const input = load(); mount(input); act(() => tabs()[1]!.click());
    const skill = input.skills.find(s => s.prerequisiteIds.length)!;
    act(() => skills().find(button => button.textContent?.startsWith(skill.title))!.click());
    const bridge = panel().querySelector('[aria-label="可选概念桥接"]')!;
    expect(bridge.textContent).toContain("也可跳过"); expect(bridge.textContent).toContain("不计掌握");
    expect(bridge.textContent).toContain("不是永久门槛"); expect(bridge.textContent).toContain("不要求先通过");
    expect(bridge.querySelectorAll('button, a')).toHaveLength(0);
    // The route has no lock: a different skill can be selected without passing a prerequisite.
    act(() => skills().at(-1)!.click());
    expect(panel().querySelector('[aria-label="所选技能详情"] h3')!.textContent).toContain("未测");
  });

  it("renders actual 150/77/15/main20/supp5 and every skill/edge with unknown defaults", () => {
    const input = load(), html = render(input);
    for (const count of [150, 77, 15, 20]) expect(html).toContain(`>${count}</dd>`);
    for (const source of input.sources) expect(html).toContain(source.file);
    mount(input);
    const main = [...panel().querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent?.startsWith("主诊断入口"))!;
    for (const id of [...input.diagnostic.questionIds, ...input.diagnostic.constructedResponseCandidates]) expect(main.textContent).toContain(`（${id}）`);
    for (const id of [...input.validation.visualCheckRequired, "T5-Q9"]) {
      expect(main.textContent).not.toContain(`（${id}）`); expect(panel().textContent).toContain(`（${id}）`);
    }
    expect(panel().textContent).toContain("清单不穷尽");
    expect([...panel().querySelectorAll("dd")].filter(dd => dd.textContent === "待绑定")).toHaveLength(7);
    for (const gap of input.coverageGaps) expect(panel().textContent).toContain(gap.scope);
    act(() => tabs()[1]!.click());
    for (const skill of input.skills) {
      act(() => skills().find(button => button.textContent?.startsWith(skill.title))!.click());
      const detail = panel().querySelector('[aria-label="所选技能详情"]')!;
      expect(detail.querySelector("h3")!.textContent).toBe(`${skill.title} · 未测`);
      const parents = [...detail.querySelectorAll('[aria-label="直接先修"] button')].map(button => button.textContent?.split(" · Topic")[0]?.trim());
      expect(parents).toEqual(skill.prerequisiteIds.map(id => input.skills.find(s => s.id === id)!.title));
    }
  });

  it("supports tabs with automatic activation and roving keyboard focus", () => {
    mount(load()); expect(tabs().map(t => t.tabIndex)).toEqual([0, -1]);
    tabs()[0]!.focus(); key(tabs()[0]!, "ArrowRight");
    expect(document.activeElement).toBe(tabs()[1]); expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(panel().textContent).toContain("技能先修路线");
    expect(host.querySelector('[role="tabpanel"][hidden]')!.textContent).toBe("");
    key(tabs()[1]!, "ArrowRight"); expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0]!, "ArrowLeft"); expect(document.activeElement).toBe(tabs()[1]);
    key(tabs()[1]!, "Home"); expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0]!, "End"); expect(document.activeElement).toBe(tabs()[1]);
  });

  it("filters/searches current topics, resets filters and remounts without stale detail", () => {
    const input = load(); mount(input); act(() => tabs()[1]!.click());
    const topic = input.skills.at(-1)!.topic, select = panel().querySelector("select")!;
    act(() => { select.value = String(topic); select.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(skills()).toHaveLength(input.skills.filter(s => s.topic === topic).length);
    skills()[0]!.focus(); key(skills()[0]!, "End"); expect(document.activeElement).toBe(skills().at(-1));
    key(skills().at(-1)!, "Home"); expect(document.activeElement).toBe(skills()[0]);
    key(skills()[0]!, "ArrowDown"); expect(document.activeElement).toBe(skills()[1]);
    key(skills()[1]!, "ArrowUp"); expect(document.activeElement).toBe(skills()[0]);
    search("no-real-workbench-match"); expect(skills()).toHaveLength(0);
    expect(panel().querySelector('[role="status"]')!.textContent).toContain("没有匹配技能");
    expect(panel().querySelector('[aria-label="所选技能详情"]')!.textContent).toBe("暂无所选技能。");
    act(() => [...panel().querySelectorAll("button")].find(b => b.textContent === "重置筛选")!.click());
    expect(panel().querySelector("input")!.value).toBe(""); expect(skills()).toHaveLength(77);
    search("another-no-match"); act(() => tabs()[0]!.click()); act(() => tabs()[1]!.click());
    expect(skills()).toHaveLength(77); expect(panel().querySelector("input")!.value).toBe("");
    search("another-no-match"); mount(structuredClone(input));
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    act(() => tabs()[1]!.click()); expect(skills()).toHaveLength(77);
    act(() => root.unmount()); root = createRoot(host); mount(input);
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("uses unique accessible tab/panel/filter/skill relationships even with two hosts", () => {
    const input = load();
    act(() => root.render(createElement("div", null, createElement(MaterialWorkbench, { input }), createElement(MaterialWorkbench, { input }))));
    for (const workbench of host.querySelectorAll('[aria-label="资料工作台"]')) {
      for (const tab of workbench.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
        const target = document.getElementById(tab.getAttribute("aria-controls")!)!;
        expect(target.getAttribute("aria-labelledby")).toBe(tab.id); expect(target.tabIndex).toBe(0);
      }
      act(() => workbench.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!.click());
      for (const field of workbench.querySelectorAll("input, select")) expect(workbench.querySelector(`label[for="${field.id}"]`)).not.toBeNull();
      const selected = workbench.querySelector('nav button[aria-pressed="true"]')!;
      expect(document.getElementById(selected.getAttribute("aria-controls")!)!.getAttribute("aria-label")).toBe("所选技能详情");
      expect(workbench.querySelectorAll('nav button[tabindex="0"]')).toHaveLength(1);
    }
    const ids = [...host.querySelectorAll("[id]")].map(node => node.id); expect(new Set(ids).size).toBe(ids.length);
  });

  it("closes empty/mismatched/private snapshots without residual children or error echo, then recovers", () => {
    const input = load(); mount(input); act(() => tabs()[1]!.click()); search("no-match");
    const bad: unknown[] = [null, {}, { candidate: input, skillTopics: [] }, { ...input, questionMappings: [] },
      { ...input, skills: input.skills.slice(1) }, { ...input, validation: { ...input.validation, questionCount: 149 } },
      { ...input, questions: input.questions.map((q, i) => i ? q : { ...q, prompt: "SECRET_SENTINEL" }) }];
    for (const snapshot of bad) {
      mount(snapshot as MaterialCourseFullPackage);
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1); expect(tabs()).toHaveLength(0);
      expect(host.querySelectorAll('input, select, nav, details, [role="tabpanel"]')).toHaveLength(0);
      expect(host.textContent).not.toContain("SECRET_SENTINEL");
    }
    mount(input); expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("only changes local UI and never calls storage, network or learning writes", () => {
    const input = load(), before = JSON.stringify(input), fetch = vi.fn(() => { throw new Error("unexpected fetch"); });
    vi.stubGlobal("fetch", fetch);
    const get = vi.spyOn(Storage.prototype, "getItem"), set = vi.spyOn(Storage.prototype, "setItem");
    try {
      mount(input); act(() => tabs()[1]!.click()); search("no-match"); search(""); act(() => skills().at(-1)!.click());
      expect(fetch).not.toHaveBeenCalled(); expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
      expect(JSON.stringify(input)).toBe(before); expect(host.querySelectorAll('a, form, button[type="submit"]')).toHaveLength(0);
    } finally { get.mockRestore(); set.mockRestore(); }
  });

  it("closes polluted declared diagnostic lists instead of displaying filtered partial children", () => {
    for (const list of ["questionIds", "constructedResponseCandidates"] as const) {
      const input = load(); input.diagnostic[list][0] = "T1-P3"; mount(input);
      expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(tabs()).toHaveLength(0);
      expect(host.querySelectorAll('details, nav, input, select')).toHaveLength(0);
      expect(host.textContent).not.toContain("T1-P3");
    }
  });
});
