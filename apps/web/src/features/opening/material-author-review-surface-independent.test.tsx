// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialAuthorReviewSurface, type MaterialAuthorReviewSurfaceProps } from "./material-author-review-surface";
import { syntheticReviewInput, syntheticReviewBindings, PRIVATE_REVIEW_CANARIES, loadExplicitRealReviewInput } from "./material-author-review-surface-independent.fixture";

type Input = NonNullable<MaterialAuthorReviewSurfaceProps["input"]>;
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const render = (input: Input | null, providedSources?: unknown) => act(() => root.render(createElement(MaterialAuthorReviewSurface, { input, providedSources })));
function required<T>(node: T | null | undefined): T { expect(node).not.toBeNull(); expect(node).not.toBeUndefined(); return node!; }
const click = (node: HTMLElement) => act(() => node.click());
const outerTabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="资料作者审阅视图"] > button')];
const workbench = () => required(host.querySelector<HTMLElement>('[aria-label="资料工作台"]'));
const innerTabs = () => [...workbench().querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const sourceChoice = () => host.querySelector<HTMLSelectElement>('select[aria-controls$="-detail"]');
const skills = () => [...workbench().querySelectorAll<HTMLButtonElement>('nav[aria-label="技能列表"] button')];
const skillDetail = () => required(workbench().querySelector('[aria-label="所选技能详情"]'));
function select(node: HTMLSelectElement, value: string) {
  expect([...node.options].map(o => o.value)).toContain(value);
  act(() => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(node.value).toBe(value);
}
function search(value: string) {
  const field = required(workbench().querySelector("input"));
  act(() => {
    required(Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set).call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  expect(field.value).toBe(value);
}
function key(node: HTMLElement, key: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...extra });
  act(() => { node.dispatchEvent(event); });
  return event;
}
function showRoute() { click(required(innerTabs()[1])); expect(innerTabs()[1]?.getAttribute("aria-selected")).toBe("true"); }
function showSources() { click(required(outerTabs()[1])); expect(outerTabs()[1]?.getAttribute("aria-selected")).toBe("true"); }
function expectClosedChildren() {
  expect(host.querySelectorAll('[role="alert"]')).toHaveLength(2);
  expect(host.querySelectorAll("select, nav, details, a")).toHaveLength(0);
}

describe("independent card1 — actual surface/workbench/panel, synthetic default CI", () => {
  it("joins both actual children from one capture and retains their DOM/state over outer navigation", () => {
    const input = syntheticReviewInput(); const before = JSON.stringify(input);
    render(input);
    const workbenchNode = workbench(), selectNode = required(sourceChoice());
    expect(selectNode.options).toHaveLength(154);
    expect([...selectNode.options].map(o => o.value)).toEqual([
      ...input.questions.map(q => `question:${q.id}`), ...input.skills.map(s => `skill:${s.id}`),
    ]);
    showRoute(); expect(skills()).toHaveLength(4);
    select(required(workbench().querySelector("select")), "1"); search("BETA");
    expect(skills()).toHaveLength(1); expect(skillDetail().textContent).toContain("A beta · 未测");
    showSources(); select(selectNode, "skill:synthetic-orphan");
    const sourceDetail = required(host.querySelector('[aria-label="所选来源详情"]'));
    expect(sourceDetail.querySelector("h3")?.textContent).toBe("技能 synthetic-orphan");
    expect(sourceDetail.textContent).toContain(input.skills[3]!.sourceRefs[0]!.file);
    for (const page of input.skills[3]!.sourceRefs[0]!.physicalPages) expect(sourceDetail.textContent).toContain(`物理页 ${page} / 200`);
    click(required(outerTabs()[0]));
    expect(workbench()).toBe(workbenchNode); expect(sourceChoice()).toBe(selectNode);
    expect(innerTabs()[1]?.getAttribute("aria-selected")).toBe("true");
    expect(required(workbench().querySelector("input")).value).toBe("BETA");
    expect(required(workbench().querySelector("select")).value).toBe("1");
    expect(skills()).toHaveLength(1); expect(skillDetail().textContent).toContain("A beta · 未测");
    expect(sourceChoice()?.value).toBe("skill:synthetic-orphan");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("drives keyboard focus, wrap, ARIA panels and ignored modifiers/IME through mounted controls", () => {
    render(syntheticReviewInput());
    const tabs = outerTabs(); required(tabs[0]).focus();
    for (const [from, pressed, to] of [[0, "ArrowLeft", 1], [1, "ArrowRight", 0], [0, "End", 1], [1, "Home", 0]] as const) {
      expect(key(required(tabs[from]), pressed).defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(tabs[to]);
      expect(tabs.map(t => t.tabIndex)).toEqual(to === 0 ? [0, -1] : [-1, 0]);
      for (const tab of tabs) {
        const panel = required(document.getElementById(required(tab.getAttribute("aria-controls"))));
        expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
        expect(panel.hidden).toBe(tab.getAttribute("aria-selected") !== "true");
      }
    }
    for (const extra of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }]) {
      expect(key(required(tabs[0]), "End", extra).defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(tabs[0]); expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    }
    expect(key(required(tabs[0]), "Escape").defaultPrevented).toBe(false);
    showRoute(); required(skills()[0]).focus();
    key(required(skills()[0]), "ArrowUp"); expect(document.activeElement).toBe(skills()[3]);
    expect(skillDetail().textContent).toContain("A orphan · 未测");
    key(required(skills()[3]), "ArrowDown"); expect(document.activeElement).toBe(skills()[0]);
    key(required(skills()[0]), "End"); expect(document.activeElement).toBe(skills()[3]);
    key(required(skills()[3]), "Home"); expect(document.activeElement).toBe(skills()[0]);
    expect(skills().map(s => s.getAttribute("aria-pressed"))).toEqual(["true", "false", "false", "false"]);
  });

  it("resets actual route filters without clearing the sibling source selection; inner-tab reset stays owned by workbench", () => {
    render(syntheticReviewInput()); showRoute();
    select(required(workbench().querySelector("select")), "2"); search("no-synthetic-match");
    expect(skills()).toHaveLength(0); expect(skillDetail().textContent).toContain("暂无所选技能");
    showSources(); select(required(sourceChoice()), "question:SYN-Q149");
    click(required(outerTabs()[0]));
    click(required([...workbench().querySelectorAll("button")].find(b => b.textContent === "重置筛选")));
    expect(required(workbench().querySelector("select")).value).toBe("all");
    expect(required(workbench().querySelector("input")).value).toBe(""); expect(skills()).toHaveLength(4);
    expect(sourceChoice()?.value).toBe("question:SYN-Q149");
    search("beta"); click(required(innerTabs()[0])); showRoute();
    expect(required(workbench().querySelector("input")).value).toBe(""); expect(skills()).toHaveLength(4);
    expect(sourceChoice()?.value).toBe("question:SYN-Q149");
  });

  it("isolates same-reference caller pollution, then closes both actual children when a new reference crosses validation", () => {
    const input = syntheticReviewInput(); render(input); showRoute();
    const originalOptions = required(sourceChoice()).innerHTML;
    input.skills[0]!.title = "CALLER_POLLUTED_TITLE";
    Object.assign(input.questions[0]!, { prompt: "CALLER_PRIVATE_BODY", answer: "CALLER_PRIVATE_ANSWER" });
    render(input, syntheticReviewBindings(input));
    expect(required(sourceChoice()).innerHTML).toBe(originalOptions);
    expect(skillDetail().textContent).toContain("A alpha · 未测");
    expect(host.innerHTML).not.toMatch(/CALLER_(POLLUTED_TITLE|PRIVATE_BODY|PRIVATE_ANSWER)/);
    render(structuredClone(input)); expectClosedChildren();
    expect(host.innerHTML).not.toMatch(/CALLER_(POLLUTED_TITLE|PRIVATE_BODY|PRIVATE_ANSWER)/);
    render(syntheticReviewInput("Recovered")); expect(sourceChoice()?.selectedIndex).toBe(0);
    expect(outerTabs()[0]?.getAttribute("aria-selected")).toBe("true");
    showRoute(); expect(skillDetail().textContent).toContain("Recovered alpha · 未测");
  });
});

function detailLinks() {
  return [...required(host.querySelector('[aria-label="所选来源详情"]')).querySelectorAll<HTMLAnchorElement>("a")];
}
function expectPrivateAbsent(markup = host.innerHTML) {
  const decoded = document.createElement("div"); decoded.innerHTML = markup;
  const decodedText = decoded.textContent;
  for (const sentinel of PRIVATE_REVIEW_CANARIES) {
    expect(markup).not.toContain(sentinel); expect(decodedText).not.toContain(sentinel);
    expect(markup).not.toContain(sentinel.split("_<")[0]);
  }
}

describe("independent card2 — session, binding and private-data boundaries", () => {
  it("keeps exact source/route state on binding-only replace, rejects invalid bindings, and recovers the same selection", () => {
    const input = syntheticReviewInput(), bindings = syntheticReviewBindings(input);
    render(input); showRoute(); search("gamma"); click(required(skills()[0]));
    showSources(); select(required(sourceChoice()), "skill:synthetic-gamma");
    for (const provided of [bindings, syntheticReviewBindings(input, "replacement")]) {
      render(input, provided);
      expect(outerTabs()[1]?.getAttribute("aria-selected")).toBe("true");
      expect(sourceChoice()?.value).toBe("skill:synthetic-gamma");
      expect(detailLinks().map(a => a.getAttribute("href"))).toEqual([`${provided[0]!.pdfUrl}#page=4`, `${provided[0]!.pdfUrl}#page=9`]);
      expect(required(workbench().querySelector("input")).value).toBe("gamma");
      expect(skillDetail().textContent).toContain("A gamma · 未测");
    }
    const privateError = "PRIVATE_BINDING_GETTER_ERROR";
    const throwing = { ...bindings[0] };
    Object.defineProperty(throwing, "pdfUrl", { enumerable: true, get() { throw new Error(privateError); } });
    for (const bad of [
      [{ ...bindings[0], pdfSha256: "0".repeat(64) }, bindings[1]],
      [{ ...bindings[0], pdfUrl: "javascript:PRIVATE_UNSAFE_URL" }, bindings[1]],
      [bindings[0], { ...bindings[1], pdfUrl: bindings[0]!.pdfUrl }],
      [throwing, bindings[1]],
    ]) {
      render(input, bad);
      expect(sourceChoice()).toBeNull(); expect(host.querySelectorAll("a")).toHaveLength(0);
      expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
      expect(host.innerHTML).not.toMatch(/PRIVATE_BINDING_GETTER_ERROR|PRIVATE_UNSAFE_URL/);
      expect(required(workbench().querySelector("input")).value).toBe("gamma");
    }
    render(input, bindings);
    expect(sourceChoice()?.value).toBe("skill:synthetic-gamma"); expect(detailLinks()).toHaveLength(2);
    render(input); expect(sourceChoice()?.value).toBe("skill:synthetic-gamma");
    expect(detailLinks()).toHaveLength(0); expect(host.textContent).toContain("未绑定（unbound）");
  });

  it("resets A to B to the identical A reference and null to A without carrying selection, filters or URLs", () => {
    const a = syntheticReviewInput("A"), b = syntheticReviewInput("B");
    const aBindings = syntheticReviewBindings(a, "private-a"), bBindings = syntheticReviewBindings(b, "private-b");
    render(a, aBindings); showRoute(); search("beta"); showSources(); select(required(sourceChoice()), "skill:synthetic-beta");
    for (const [input, provided, staleUrl] of [[b, bBindings, aBindings[1]!.pdfUrl], [a, aBindings, bBindings[1]!.pdfUrl]] as const) {
      render(input, provided);
      expect(outerTabs()[0]?.getAttribute("aria-selected")).toBe("true");
      expect(innerTabs()[0]?.getAttribute("aria-selected")).toBe("true");
      expect(sourceChoice()?.value).toBe("question:SYN-Q1");
      expect(detailLinks().map(a => a.getAttribute("href"))).toEqual([`${provided[0]!.pdfUrl}#page=1`]);
      expect(host.innerHTML).not.toContain(staleUrl);
      showRoute(); expect(required(workbench().querySelector("input")).value).toBe(""); expect(skills()).toHaveLength(4);
      expect(skillDetail().textContent).toContain(`${input === a ? "A" : "B"} alpha · 未测`);
      search("orphan"); showSources(); select(required(sourceChoice()), "skill:synthetic-orphan");
    }
    render(null, aBindings); expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelectorAll("select, nav, a, [role=tab]")).toHaveLength(0);
    render(a); expect(outerTabs()[0]?.getAttribute("aria-selected")).toBe("true");
    expect(sourceChoice()?.value).toBe("question:SYN-Q1"); expect(detailLinks()).toHaveLength(0);
    showRoute(); expect(required(workbench().querySelector("input")).value).toBe("");
  });

  it("never reuses A URLs for a fresh B input, including a rejected stale binding set", () => {
    const a = syntheticReviewInput("A"), b = syntheticReviewInput("B");
    const provided = syntheticReviewBindings(a, "private-a");
    render(a, provided); showSources(); select(required(sourceChoice()), "question:SYN-Q2"); expect(detailLinks()).toHaveLength(1);
    render(b, provided); expect(sourceChoice()).toBeNull(); expect(host.querySelectorAll("a")).toHaveLength(0);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.innerHTML).not.toContain(provided[1]!.pdfUrl);
    render(b); expect(sourceChoice()?.value).toBe("question:SYN-Q1"); expect(detailLinks()).toHaveLength(0);
    const bBindings = syntheticReviewBindings(b, "private-b"); render(b, bBindings);
    expect(detailLinks().map(a => a.getAttribute("href"))).toEqual([`${bBindings[0]!.pdfUrl}#page=1`]);
    expect(host.innerHTML).not.toContain(provided[0]!.pdfUrl);
  });

  it("captures alternating private getters once across both real children and never leaks throwing-getter errors", () => {
    const input = syntheticReviewInput(); const original = input.skills;
    let reads = 0;
    Object.defineProperty(input, "skills", { enumerable: true, get() {
      reads++; return reads === 1 ? original : original.map(s => ({ ...s, title: "PRIVATE_SECOND_CAPTURE" }));
    } });
    render(input); expect(reads).toBe(1); showRoute(); expect(skillDetail().textContent).toContain("A alpha · 未测");
    showSources(); select(required(sourceChoice()), "skill:synthetic-orphan");
    render(input, syntheticReviewBindings(input)); expect(reads).toBe(1);
    expect(host.innerHTML).not.toContain("PRIVATE_SECOND_CAPTURE");
    const invalid = syntheticReviewInput();
    Object.defineProperty(invalid.questions[0], "postAttemptNotes", { enumerable: true, get() { throw new Error("PRIVATE_RAW_GETTER_ERROR"); } });
    render(invalid);
    expect(host.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(host.querySelectorAll("input, select, nav, a, [role=tab]")).toHaveLength(0);
    expect(host.innerHTML).not.toMatch(/PRIVATE_RAW_GETTER_ERROR|PRIVATE_SECOND_CAPTURE/);
    render(syntheticReviewInput("Recovered")); showRoute(); expect(skillDetail().textContent).toContain("Recovered alpha · 未测");
  });

  it("keeps private post-notes/objectives/common-errors out of first HTML and every reachable detail; exclusion reason stays factual", () => {
    const input = syntheticReviewInput(); const provided = syntheticReviewBindings(input);
    const before = JSON.stringify(input);
    const html = renderToStaticMarkup(createElement(MaterialAuthorReviewSurface, { input, providedSources: provided }));
    expectPrivateAbsent(html);
    const initial = document.createElement("div"); initial.innerHTML = html;
    expect(initial.querySelectorAll("select option")).toHaveLength(154);
    expect(initial.querySelectorAll("a")).toHaveLength(1);
    expect(initial.querySelectorAll("form, textarea, iframe, script")).toHaveLength(0);
    expect(initial.textContent).toContain("尚未实现帮助或接触记录");
    render(input, provided); showRoute();
    for (const button of skills()) { click(button); expectPrivateAbsent(); }
    showSources();
    for (const option of [...required(sourceChoice()).options]) {
      select(required(sourceChoice()), option.value); expectPrivateAbsent();
      const detail = required(host.querySelector('[aria-label="所选来源详情"]'));
      expect(detail.textContent).toContain("此处不可作答、施测、评分或用于 BKT");
      if (option.value === "question:SYN-Q150") {
        const reasons = required(detail.querySelector('[aria-label="诊断禁用理由"]')).textContent;
        expect(reasons).toContain("资料作者排除，禁用诊断；不从答后说明判断原因");
        expect(reasons).toContain("bktAdmission=false");
      }
    }
    expect(host.querySelectorAll("form, textarea, iframe, script, button[type=submit]")).toHaveLength(0);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not fetch, persist or turn forged purpose/eligibility flags into a first-answer proof during interactions", () => {
    const input = syntheticReviewInput(); const fetch = vi.fn(() => { throw new Error("Unexpected fetch"); }); vi.stubGlobal("fetch", fetch);
    const xhr = vi.spyOn(XMLHttpRequest.prototype, "open");
    const get = vi.spyOn(Storage.prototype, "getItem"), set = vi.spyOn(Storage.prototype, "setItem");
    const props = { input, providedSources: syntheticReviewBindings(input), purpose: "post-attempt", diagnosticEligible: true, exposureRecorded: true };
    act(() => root.render(createElement(MaterialAuthorReviewSurface, props)));
    const expectForgedFlagsRejected = () => {
      expect(host.textContent).toContain("当前用途：资料审阅（非无帮助首答）");
      expect(host.textContent).not.toContain("当前用途：答后核对");
      expect(host.textContent).toContain("尚未实现帮助或接触记录");
      expect(host.querySelectorAll("form, textarea, button[type=submit]")).toHaveLength(0);
    };
    showSources(); expectForgedFlagsRejected();
    showRoute(); search("beta"); showSources(); select(required(sourceChoice()), "question:SYN-Q150");
    expectForgedFlagsRejected();
    render(input); render(null); render(input);
    expect(host.textContent).toContain("当前用途：资料审阅（非无帮助首答）");
    expect(host.textContent).not.toContain("当前用途：答后核对");
    expect(host.textContent).toContain("尚未实现帮助或接触记录");
    expect(host.querySelectorAll("form, textarea, button[type=submit]")).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled(); expect(xhr).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled(); expect(set).not.toHaveBeenCalled();
  });
});

// Private acceptance is opt-in. Default CI still executes every synthetic test above.
// An explicitly supplied empty/bad path or wrong SHA executes and fails, never skips.
const realInputPath = process.env.MATERIAL_AUTHOR_REVIEW_REAL_INPUT;
describe.skipIf(realInputPath === undefined)("real 041fc acceptance — SKIPPED unless MATERIAL_AUTHOR_REVIEW_REAL_INPUT is explicitly supplied", () => {
  it("validates pinned private bytes then traverses actual route/source details without exposing private fields", () => {
    const input = loadExplicitRealReviewInput(realInputPath!);
    expect([input.questions.length, input.skills.length, input.sources.length]).toEqual([150, 77, 15]);
    const provided = syntheticReviewBindings(input, "real-metadata-only");
    const secrets = [...input.questions.map(q => q.postAttemptNotes), ...input.skills.flatMap(s => [...s.learningObjectives, ...s.commonErrors])];
    const check = (markup: string) => {
      const doc = document.createElement("div"); doc.innerHTML = markup;
      for (const text of secrets) { expect(markup).not.toContain(text); expect(doc.textContent).not.toContain(text); }
    };
    check(renderToStaticMarkup(createElement(MaterialAuthorReviewSurface, { input, providedSources: provided })));
    render(input, provided); showRoute(); expect(skills()).toHaveLength(77);
    for (const button of skills()) { click(button); check(host.innerHTML); }
    showSources(); expect(required(sourceChoice()).options).toHaveLength(227);
    let locations = 0;
    const choices = [
      ...input.questions.map(q => ({ key: `question:${q.id}`, locations: [{ file: q.sourceFile, page: q.physicalPage }] })),
      ...input.skills.map(s => ({ key: `skill:${s.id}`, locations: s.sourceRefs.flatMap(ref => ref.physicalPages.map(page => ({ file: ref.file, page }))) })),
    ];
    for (const choice of choices) {
      select(required(sourceChoice()), choice.key);
      const links = detailLinks(); expect(links).toHaveLength(choice.locations.length);
      expect(links.map(a => a.getAttribute("href"))).toEqual(choice.locations.map(location =>
        `${required(provided.find(source => source.file === location.file)).pdfUrl}#page=${location.page}`));
      for (const link of links) {
        expect(link.target).toBe("_blank"); expect(link.rel).toBe("noopener noreferrer");
        expect(link.getAttribute("referrerpolicy")).toBe("no-referrer");
      }
      check(host.innerHTML); locations += links.length;
    }
    expect(locations).toBe(385);
    expect(host.textContent).toContain("尚未实现帮助或接触记录");
    expect(host.querySelectorAll("form, textarea, iframe, script, button[type=submit]")).toHaveLength(0);
  }, 60_000);
});
