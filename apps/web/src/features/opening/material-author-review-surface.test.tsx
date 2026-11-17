// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialAuthorReviewSurface, type MaterialAuthorReviewSurfaceProps } from "./material-author-review-surface";

type Input = NonNullable<MaterialAuthorReviewSurfaceProps["input"]>;
const inputPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
function load(): Input {
  const bytes = readFileSync(inputPath!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  return JSON.parse(bytes.toString());
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = (input: Input | null, providedSources?: unknown) => act(() => root.render(createElement(MaterialAuthorReviewSurface, { input, providedSources })));
const surface = () => host.querySelector<HTMLElement>('[aria-label="资料作者审阅"]')!;
const outerTabs = () => [...surface().querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="资料作者审阅视图"] > button')];
const click = (node: HTMLElement) => act(() => node.click());
const sourceSelect = () => host.querySelector<HTMLSelectElement>('select[aria-controls$="-detail"]')!;
const workbench = () => host.querySelector<HTMLElement>('[aria-label="资料工作台"]')!;
const routeTab = () => workbench().querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!;
const skills = () => [...workbench().querySelectorAll<HTMLButtonElement>("nav button")];
function select(node: HTMLSelectElement, value: string) {
  act(() => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
}
function key(node: HTMLElement, value: string, extra: KeyboardEventInit = {}) {
  act(() => node.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...extra })));
}
function search(value: string) {
  const input = workbench().querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const bindings = (input: Input) => input.sources.map((source, index) => ({
  file: source.file, pdfSha256: source.sha256, sourceId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  sourceVersion: 0, pdfUrl: `https://review.example.invalid/material-${index}.pdf`,
}));

/** Synthetic metadata only, not a copy of the private course or PDF content.
 * The full-package adapter requires 150 entries and a 20-item diagnostic declaration. */
function syntheticInput(): Input {
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64), questionIndexSha256: "b".repeat(64), mappingFiles: [],
    sources: [{ file: "synthetic.pdf", sha256: "c".repeat(64), physicalPages: 2 }],
    skills: [1, 2].map(topic => ({ id: `synthetic-skill-${topic}`, title: `Synthetic skill ${topic}`, topic,
      prerequisiteIds: topic === 2 ? ["synthetic-skill-1"] : [], learningObjectives: ["PRIVATE_OBJECTIVE_SYNTHETIC"], commonErrors: ["PRIVATE_ERROR_SYNTHETIC"],
      sourceRefs: [{ file: "synthetic.pdf", physicalPages: [topic], verification: "text-reviewed" }] })),
    prerequisiteOrder: ["synthetic-skill-1", "synthetic-skill-2"],
    questions: Array.from({ length: 150 }, (_, i) => ({ id: `synthetic-q-${i}`, topic: i % 2 + 1, kind: "Test", number: i + 1,
      sourceFile: "synthetic.pdf", physicalPage: i % 2 + 1, primarySkillId: `synthetic-skill-${i % 2 + 1}`, secondarySkillIds: [],
      evidenceType: "objective-choice", mappingStatus: "text-reviewed", postAttemptNotes: "PRIVATE_NOTES_SYNTHETIC",
      assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification" })),
    diagnostic: { status: "candidate-not-administered", source: "Synthetic declaration only", questionIds: Array.from({ length: 20 }, (_, i) => `synthetic-q-${i}`), constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "No admission", requiredRuntimeChecks: [], constructedResponsePolicy: "No scoring", familyPolicy: "No family identity", feedbackPolicy: "After answer only" },
    schedule: { productTarget: "Synthetic target", latestProductUseDate: "Synthetic target", actualExamDate: null, dailyStudyMinutes: null, policy: "No inferred date",
      unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [] },
    coverageGaps: [], coverageGapNotes: [],
    validation: { sourcePdfs: 1, questionCount: 150, skillCount: 2, textMappedCount: 150, visualCheckRequired: [], disputedDiagnosticExclusions: [], semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
}

it("closes missing input without mounting either child", () => {
  mount(null);
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelectorAll('input, select, [role="tab"], a')).toHaveLength(0);
});

describe("self-contained same-input workbench + panel (no private environment)", () => {
  it("mounts the real children, preserves independent selections, and exposes only explicitly bound locations", () => {
    const input = syntheticInput(), before = JSON.stringify(input);
    mount(input); click(routeTab());
    expect(skills()).toHaveLength(2);
    select(workbench().querySelector("select")!, "2");
    search("no-synthetic-match"); expect(skills()).toHaveLength(0);
    click(outerTabs()[1]!); select(sourceSelect(), "skill:synthetic-skill-2");
    expect(sourceSelect().options).toHaveLength(152); expect(host.querySelectorAll("a")).toHaveLength(0);
    mount(input, bindings(input));
    expect(sourceSelect().value).toBe("skill:synthetic-skill-2");
    expect(host.querySelector("a")!.getAttribute("href")).toBe("https://review.example.invalid/material-0.pdf#page=2");
    click(outerTabs()[0]!);
    expect(workbench().querySelector("input")!.value).toBe("no-synthetic-match");
    expect(workbench().querySelector("select")!.value).toBe("2");
    click([...workbench().querySelectorAll("button")].find(b => b.textContent === "重置筛选")!);
    expect(skills()).toHaveLength(2); expect(sourceSelect().value).toBe("skill:synthetic-skill-2");
    expect(host.innerHTML).not.toMatch(/PRIVATE_(NOTES|OBJECTIVE|ERROR)_SYNTHETIC/);
    expect(host.textContent).toContain("此处不可作答、施测、评分或用于 BKT");
    expect(host.textContent).toContain("尚未实现帮助或接触记录");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("resets the entire session across A → B → identical A, null and invalid input without residual private fields", () => {
    const a = syntheticInput(), b = structuredClone(a); b.skills[1]!.title = "Replacement synthetic skill";
    mount(a);
    const dirty = () => { click(routeTab()); search("no-match"); click(outerTabs()[1]!); select(sourceSelect(), "skill:synthetic-skill-2"); };
    const reset = () => {
      expect(outerTabs()[0]!.getAttribute("aria-selected")).toBe("true");
      expect(workbench().querySelectorAll('[role="tab"]')[0]!.getAttribute("aria-selected")).toBe("true");
      expect(sourceSelect().value).toBe("question:synthetic-q-0");
      click(routeTab()); expect(workbench().querySelector("input")!.value).toBe(""); expect(skills()).toHaveLength(2);
    };
    dirty();
    for (const input of [b, a]) { mount(input); reset(); dirty(); }
    mount(null); expect(host.querySelectorAll('select, nav, a, [role="tab"]')).toHaveLength(0);
    mount(a); reset(); dirty();
    const polluted = structuredClone(a); Object.assign(polluted.questions[0]!, { prompt: "PRIVATE_BODY_SYNTHETIC", answer: "PRIVATE_ANSWER_SYNTHETIC" });
    mount(polluted);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(host.querySelectorAll("select, nav, a, details")).toHaveLength(0);
    expect(host.innerHTML).not.toMatch(/PRIVATE_(BODY|ANSWER)_SYNTHETIC/);
    mount(a); reset();
  });

  it("captures one shared snapshot on binding-only renders and rejects a fresh polluted reference", () => {
    const input = syntheticInput(); mount(input);
    input.skills[1]!.title = "MUTATED_SYNTHETIC_TITLE";
    Object.assign(input.questions[0]!, { answer: "PRIVATE_ANSWER_SYNTHETIC" });
    mount(input, bindings(input)); click(routeTab());
    expect(skills()).toHaveLength(2); expect(sourceSelect().options).toHaveLength(152);
    expect(host.innerHTML).not.toMatch(/MUTATED_SYNTHETIC_TITLE|PRIVATE_ANSWER_SYNTHETIC/);
    mount(structuredClone(input));
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
    expect(host.querySelectorAll("select, nav, a, details")).toHaveLength(0);
    mount(syntheticInput()); expect(sourceSelect().selectedIndex).toBe(0);
  });
});

// Opt-in private replay: provide the exact 041fc input; preview tests additionally
// require the superseded-input and superseded-candidate paths. No private fallback.
describe.skipIf(!inputPath)("041fc current package → real frozen workbench + source panel", () => {
  it("actually mounts both components with the same raw package and no inferred bindings", () => {
    const input = load(), before = JSON.stringify(input);
    mount(input);
    expect(host.querySelector('[aria-label="资料工作台"]')).not.toBeNull();
    expect(host.textContent).toContain("主诊断入口");
    click(outerTabs()[1]!);
    expect(sourceSelect().options).toHaveLength(227);
    expect(host.textContent).toContain("未绑定（unbound）");
    expect(host.querySelectorAll("a")).toHaveLength(0);
    expect(host.textContent).toContain("资料作者审阅 · 私有只读");
    expect(host.textContent).toContain("尚未实现帮助或接触记录");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("supports independent accessible keyboard tabs, wrapping, modifiers and unique instances", () => {
    mount(load());
    expect(outerTabs().map(t => t.tabIndex)).toEqual([0, -1]);
    outerTabs()[0]!.focus(); key(outerTabs()[0]!, "ArrowRight");
    expect(document.activeElement).toBe(outerTabs()[1]);
    expect(outerTabs()[1]!.getAttribute("aria-selected")).toBe("true");
    key(outerTabs()[1]!, "ArrowRight"); expect(document.activeElement).toBe(outerTabs()[0]);
    key(outerTabs()[0]!, "ArrowLeft"); expect(document.activeElement).toBe(outerTabs()[1]);
    key(outerTabs()[1]!, "Home"); expect(document.activeElement).toBe(outerTabs()[0]);
    key(outerTabs()[0]!, "End"); expect(document.activeElement).toBe(outerTabs()[1]);
    key(outerTabs()[1]!, "Home", { ctrlKey: true }); expect(document.activeElement).toBe(outerTabs()[1]);
    key(outerTabs()[1]!, "Home", { isComposing: true }); expect(document.activeElement).toBe(outerTabs()[1]);
    const input = load();
    act(() => root.render(createElement("div", null, createElement(MaterialAuthorReviewSurface, { input }), createElement(MaterialAuthorReviewSurface, { input }))));
    const ids = [...host.querySelectorAll("[id]")].map(n => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of host.querySelectorAll('[role="tab"]')) {
      const panel = document.getElementById(tab.getAttribute("aria-controls")!)!;
      expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
      expect(panel.hidden).toBe(tab.getAttribute("aria-selected") !== "true");
    }
  });

  it("keeps search, topic and source selection across outer tabs and binding-only updates", () => {
    const input = load(); mount(input); click(routeTab());
    const topic = input.skills.at(-1)!.topic;
    select(workbench().querySelector("select")!, String(topic));
    expect(skills()).toHaveLength(input.skills.filter(s => s.topic === topic).length);
    skills()[0]!.focus(); key(skills()[0]!, "End"); expect(document.activeElement).toBe(skills().at(-1));
    key(skills().at(-1)!, "Home"); expect(document.activeElement).toBe(skills()[0]);
    search("no-author-review-match"); expect(skills()).toHaveLength(0);
    click(outerTabs()[1]!); select(sourceSelect(), `skill:${input.skills.at(-1)!.id}`);
    const selected = sourceSelect().value;
    mount(input, bindings(input));
    expect(outerTabs()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(sourceSelect().value).toBe(selected); expect(host.querySelectorAll("a").length).toBeGreaterThan(0);
    mount(input); expect(sourceSelect().value).toBe(selected); expect(host.querySelectorAll("a")).toHaveLength(0);
    click(outerTabs()[0]!);
    expect(routeTab().getAttribute("aria-selected")).toBe("true");
    expect(workbench().querySelector("input")!.value).toBe("no-author-review-match");
    expect(workbench().querySelector("select")!.value).toBe(String(topic));
    click([...workbench().querySelectorAll("button")].find(b => b.textContent === "重置筛选")!);
    expect(workbench().querySelector("input")!.value).toBe(""); expect(skills()).toHaveLength(77);
    click(outerTabs()[1]!); expect(sourceSelect().value).toBe(selected);
  });

  it("resets on A → B → the identical A reference, null → A, and remount", () => {
    const a = load(), b = structuredClone(a); b.skills[0]!.title = "Replacement skill";
    mount(a); click(routeTab()); search("no-match"); click(outerTabs()[1]!);
    select(sourceSelect(), `skill:${a.skills.at(-1)!.id}`);
    for (const input of [b, a]) {
      mount(input);
      expect(outerTabs()[0]!.getAttribute("aria-selected")).toBe("true");
      expect(workbench().querySelectorAll('[role="tab"]')[0]!.getAttribute("aria-selected")).toBe("true");
      expect(sourceSelect().value).toBe(`question:${input.questions[0]!.id}`);
      click(routeTab()); expect(workbench().querySelector("input")!.value).toBe(""); expect(skills()).toHaveLength(77);
      search("no-match"); click(outerTabs()[1]!); select(sourceSelect(), `skill:${input.skills.at(-1)!.id}`);
    }
    mount(null); expect(outerTabs()).toHaveLength(0); expect(host.querySelectorAll("select, nav, a")).toHaveLength(0);
    mount(a); expect(outerTabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(sourceSelect().selectedIndex).toBe(0);
    click(outerTabs()[1]!);
    act(() => root.unmount()); root = createRoot(host); mount(a);
    expect(outerTabs()[0]!.getAttribute("aria-selected")).toBe("true"); expect(sourceSelect().selectedIndex).toBe(0);
  });

  it("captures the input once for both children, rather than reading independent live snapshots", () => {
    const input = load(); mount(input); const original = sourceSelect().options[0]!.text;
    // The current capture stays coherent on a binding-only render even if the caller mutates A.
    input.questions[0]!.id = "MUTATED_RAW_ID";
    Object.assign(input.questions[0]!, { prompt: "UNTRUSTED_BODY" });
    mount(input, []);
    expect(sourceSelect().options[0]!.text).toBe(original); expect(host.innerHTML).not.toContain("MUTATED_RAW_ID");
    // A new raw reference exposes the forbidden body field to both strict raw schemas.
    mount(structuredClone(input));
    expect(host.querySelectorAll("select, nav, details, a")).toHaveLength(0);
    expect(host.innerHTML).not.toContain("MUTATED_RAW_ID");
  });

  it("SSR renders real 150/77/15/main20/supp5 metadata with fixed private-review warnings", () => {
    const input = load();
    const html = renderToStaticMarkup(createElement(MaterialAuthorReviewSurface, { input }));
    const doc = document.createElement("div"); doc.innerHTML = html;
    for (const count of [150, 77, 15, 20]) expect(html).toContain(`>${count}</dd>`);
    for (const source of input.sources) expect(doc.textContent).toContain(source.file);
    expect(input.diagnostic.questionIds).toHaveLength(20);
    expect(input.diagnostic.constructedResponseCandidates).toHaveLength(5);
    const diagnostic = [...doc.querySelectorAll("details")].find(d => d.querySelector("summary")?.textContent?.startsWith("主诊断入口"))!;
    for (const id of [...input.diagnostic.questionIds, ...input.diagnostic.constructedResponseCandidates]) expect(diagnostic.textContent).toContain(`（${id}）`);
    expect(doc.querySelectorAll("select option")).toHaveLength(227);
    expect(html).toContain("不是首答界面"); expect(html).toContain("尚未实现帮助或接触记录");
    expect(html).toContain("未绑定（unbound）"); expect(html).not.toMatch(/<(form|textarea|iframe|script)\b/);
    for (const value of [...input.questions.flatMap(q => q.postAttemptNotes ? [q.postAttemptNotes] : []),
      ...input.skills.flatMap(s => [...s.learningObjectives, ...s.commonErrors])]) {
      expect(doc.textContent).not.toContain(value);
    }
    expect(doc.querySelectorAll("a")).toHaveLength(0);
  });

  it("renders all 385 real locations without body/answer or private teaching fields in any detail", () => {
    const input = load();
    input.questions.forEach(q => { q.postAttemptNotes = "PRIVATE_NOTES_SENTINEL"; });
    input.skills.forEach(s => { s.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"]; s.commonErrors = ["PRIVATE_ERROR_SENTINEL"]; });
    const provided = bindings(input), before = JSON.stringify(input);
    const checkPrivate = () => expect(host.innerHTML).not.toMatch(/PRIVATE_(NOTES|OBJECTIVE|ERROR)_SENTINEL/);
    const html = renderToStaticMarkup(createElement(MaterialAuthorReviewSurface, { input, providedSources: provided }));
    expect(html).not.toMatch(/PRIVATE_(NOTES|OBJECTIVE|ERROR)_SENTINEL/);
    mount(input, provided); click(routeTab());
    for (const skill of input.skills) {
      click(skills().find(button => button.textContent?.startsWith(skill.title))!);
      expect(workbench().querySelector('[aria-label="所选技能详情"] h3')!.textContent).toBe(`${skill.title} · 未测`);
      checkPrivate();
    }
    click(outerTabs()[1]!);
    const choices = [
      ...input.questions.map(q => ({ key: `question:${q.id}`, locations: [{ file: q.sourceFile, page: q.physicalPage }] })),
      ...input.skills.map(s => ({ key: `skill:${s.id}`, locations: s.sourceRefs.flatMap(ref => ref.physicalPages.map(page => ({ file: ref.file, page }))) })),
    ];
    let total = 0;
    for (const choice of choices) {
      select(sourceSelect(), choice.key);
      const detail = host.querySelector('[aria-label="所选来源详情"]')!;
      const links = [...detail.querySelectorAll<HTMLAnchorElement>("a")];
      expect(links).toHaveLength(choice.locations.length);
      choice.locations.forEach((location, index) => {
        const binding = provided.find(p => p.file === location.file)!;
        expect(links[index]!.getAttribute("href")).toBe(`${binding.pdfUrl}#page=${location.page}`);
        expect(links[index]!.target).toBe("_blank"); expect(links[index]!.rel).toBe("noopener noreferrer");
        expect(links[index]!.getAttribute("referrerpolicy")).toBe("no-referrer");
        expect(links[index]!.parentElement!.textContent).toContain(`物理页 ${location.page} /`);
      });
      expect(detail.textContent).toContain("此处不可作答、施测、评分或用于 BKT");
      checkPrivate(); total += links.length;
    }
    expect(total).toBe(385); expect(choices).toHaveLength(227);
    expect(host.querySelectorAll('form, textarea, iframe, button[type="submit"]')).toHaveLength(0);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("inherits exact locator URL rejection without falling back to fabricated source links", () => {
    const input = load(), provided = bindings(input); mount(input, provided); click(outerTabs()[1]!);
    const selected = `skill:${input.skills.at(-1)!.id}`; select(sourceSelect(), selected);
    const bad = ["javascript:alert(1)", "http://review.example.invalid/a.pdf", "https://user:pass@review.example.invalid/a.pdf",
      "https://review.example.invalid/a.pdf#page=1", " https://review.example.invalid/a.pdf", "https://review.example.invalid/../a.pdf",
      "https://review.example.invalid/%2e%2e/a.pdf", "https://review.example.invalid/a%2fb.pdf", "https://review.example.invalid/a\\b.pdf"];
    for (const pdfUrl of bad) {
      mount(input, provided.map((source, index) => index ? source : { ...source, pdfUrl }));
      expect(host.querySelectorAll("a")).toHaveLength(0); expect(sourceSelect()).toBeNull();
      expect(host.textContent).not.toContain(pdfUrl);
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    }
    mount(input, provided); expect(sourceSelect().value).toBe(selected);
    expect(host.querySelectorAll("a").length).toBeGreaterThan(0);
    mount(input, provided.map((source, index) => index ? source : { ...source, pdfSha256: "0".repeat(64) }));
    expect(host.querySelectorAll("a")).toHaveLength(0); expect(sourceSelect()).toBeNull();
    mount(input); expect(sourceSelect().value).toBe(selected); expect(host.textContent).toContain("未绑定（unbound）");
    expect(host.querySelectorAll("a")).toHaveLength(0);
  });

  it("does not turn caller purpose or readiness declarations into authorization or help evidence", () => {
    const input = load();
    const props = Object.assign({ input, providedSources: bindings(input) }, { purpose: "post-attempt", diagnosticEligible: true, exposureRecorded: true });
    act(() => root.render(createElement(MaterialAuthorReviewSurface, props)));
    click(outerTabs()[1]!);
    expect(host.textContent).toContain("当前用途：资料审阅（非无帮助首答）");
    expect(host.textContent).not.toContain("当前用途：答后核对");
    expect(host.textContent).toContain("传入用途不代表授权或已验证作答");
    expect(host.textContent).toContain("尚未实现帮助或接触记录");
    expect(host.textContent).toContain("不授予诊断、评分或 BKT 使用条件");
    expect(host.querySelectorAll('form, textarea, button[type="submit"]')).toHaveLength(0);
  });

  it("never fetches or persists during navigation, search, selection or binding updates", () => {
    const input = load(), before = JSON.stringify(input), fetch = vi.fn(() => { throw new Error("unexpected fetch"); });
    vi.stubGlobal("fetch", fetch);
    const get = vi.spyOn(Storage.prototype, "getItem"), set = vi.spyOn(Storage.prototype, "setItem");
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    try {
      mount(input); click(routeTab()); search("no-match"); search(""); click(skills().at(-1)!);
      click(outerTabs()[1]!); select(sourceSelect(), `skill:${input.skills.at(-1)!.id}`);
      mount(input, bindings(input)); mount(input); mount(null); mount(input);
      expect(fetch).not.toHaveBeenCalled(); expect(xhr).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled(); expect(JSON.stringify(input)).toBe(before);
    } finally { get.mockRestore(); set.mockRestore(); xhr.mockRestore(); }
  });

  it("hides invalid body-bearing input without echoing secrets, then recovers a fresh session", () => {
    const input = load(); mount(input); click(outerTabs()[1]!);
    for (const bad of [{}, { ...input, questions: input.questions.map((q, i) => i ? q : { ...q, prompt: "PRIVATE_BODY_SECRET", answer: "PRIVATE_ANSWER_SECRET" }) }]) {
      mount(bad as Input);
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
      expect(host.querySelectorAll("details, nav, select, a")).toHaveLength(0);
      expect(host.innerHTML).not.toMatch(/PRIVATE_(BODY|ANSWER)_SECRET/);
    }
    mount(input); expect(outerTabs()[0]!.getAttribute("aria-selected")).toBe("true"); expect(sourceSelect().selectedIndex).toBe(0);
  });
});
