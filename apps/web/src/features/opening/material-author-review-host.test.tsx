// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MaterialAuthorReviewHost, type MaterialAuthorReviewHostProps } from "./material-author-review-host";

type Input = NonNullable<MaterialAuthorReviewHostProps["input"]>;
// Synthetic metadata only. No private course content or imported review/test fixture.
function fixture(): Input {
  return {
    schemaVersion: 1, status: "offline-candidate-not-imported", sourceManifestSha256: "a".repeat(64), questionIndexSha256: "b".repeat(64), mappingFiles: [],
    sources: [{ file: "synthetic.pdf", sha256: "c".repeat(64), physicalPages: 2 }],
    skills: [1, 2].map(i => ({ id: `skill-${i}`, title: `Synthetic skill ${i}`, topic: i,
      prerequisiteIds: i === 2 ? ["skill-1"] : [], learningObjectives: ["PRIVATE_OBJECTIVE"], commonErrors: ["PRIVATE_ERROR"],
      sourceRefs: [{ file: "synthetic.pdf", physicalPages: [i], verification: "text-reviewed" }] })),
    prerequisiteOrder: ["skill-1", "skill-2"],
    questions: Array.from({ length: 150 }, (_, i) => ({ id: `q-${i}`, topic: i % 2 + 1, kind: "Test", number: i + 1,
      sourceFile: "synthetic.pdf", physicalPage: i % 2 + 1, primarySkillId: `skill-${i % 2 + 1}`, secondarySkillIds: [],
      evidenceType: "objective-choice", mappingStatus: "text-reviewed", postAttemptNotes: "PRIVATE_NOTES",
      assessmentReadiness: "requires-answer-key-and-exposure-check", bktAdmission: "requires-runtime-evidence-qualification" })),
    diagnostic: { status: "candidate-not-administered", source: "Synthetic", questionIds: Array.from({ length: 20 }, (_, i) => `q-${i}`), constructedResponseCandidates: [], conditions: [] },
    bktBoundary: { model: "existing-classical-bkt", calibrated: false, learnerStateCreated: false, policy: "No admission", requiredRuntimeChecks: [], constructedResponsePolicy: "No scoring", familyPolicy: "No family identity", feedbackPolicy: "After answer only" },
    schedule: { productTarget: "Synthetic", latestProductUseDate: "Not an exam date", actualExamDate: null, dailyStudyMinutes: null, policy: "No inferred dates", unmeasuredPrerequisitePolicy: "teach-bridge-without-mastery-credit", unmeasuredSkillIds: [] },
    coverageGaps: [], coverageGapNotes: [],
    validation: { sourcePdfs: 1, questionCount: 150, skillCount: 2, textMappedCount: 150, visualCheckRequired: [], disputedDiagnosticExclusions: [], semanticMathVerification: "not-complete", runtimeCoursePublication: "not-verified" },
  };
}
const bindings = (input: Input) => input.sources.map((s, i) => ({ file: s.file, pdfSha256: s.sha256,
  sourceId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`, sourceVersion: 0,
  pdfUrl: `https://review.example.invalid/material-${i}.pdf` }));
let host: HTMLDivElement, root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const mount = (input: Input | null, providedSources?: unknown, extra = {}) =>
  act(() => root.render(createElement(MaterialAuthorReviewHost, { input, providedSources, ...extra })));
const click = (node: HTMLElement) => act(() => node.click());
const tabs = () => [...host.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="资料作者审阅视图"] > button')];
const source = () => host.querySelector<HTMLSelectElement>('select[aria-controls$="-detail"]')!;
const workbench = () => host.querySelector<HTMLElement>('[aria-label="资料工作台"]')!;
const route = () => workbench().querySelectorAll<HTMLButtonElement>('[role="tab"]')[1]!;
function select(node: HTMLSelectElement, value: string) {
  act(() => { node.value = value; node.dispatchEvent(new Event("change", { bubbles: true })); });
}
function search(value: string) {
  const node = workbench().querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function closed() {
  expect(host.textContent).toContain("MODULE_PENDING · not_ready");
  expect(host.textContent).toContain("诊断／评分／BKT 条件就绪题数：0／0／0");
  expect(host.textContent).toContain("未执行题目：0");
  expect(host.textContent).toContain("不是首答界面");
  expect(host.textContent).toContain("尚未实现帮助或接触记录");
  expect(host.innerHTML).not.toMatch(/PRIVATE_(NOTES|OBJECTIVE|ERROR|BODY|ANSWER)/);
  expect(host.querySelectorAll("form, textarea, iframe, script")).toHaveLength(0);
}
function unavailable() {
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).toContain("MODULE_PENDING");
  expect(host.querySelectorAll('select, input, a, details, [role="tab"]')).toHaveLength(0);
  expect(host.querySelector('[aria-label="作者资料就绪状态"]')).toBeNull();
  expect(host.innerHTML).not.toMatch(/PRIVATE_|SECRET|MODULE_READY/);
}
function dirty() { click(route()); search("no-match"); click(tabs()[1]!); select(source(), "skill:skill-2"); }
function reset() {
  expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
  expect(source().value).toBe("question:q-0");
  expect(workbench().querySelectorAll('[role="tab"]')[0]!.getAttribute("aria-selected")).toBe("true");
  click(route()); expect(workbench().querySelector("input")!.value).toBe("");
  expect(workbench().querySelectorAll("nav button")).toHaveLength(2);
}

it("mounts both frozen children from metadata, with actual model counts but no authority or effects", () => {
  const input = fixture(), before = structuredClone(input), fetch = vi.fn(() => { throw new Error("No network"); });
  vi.stubGlobal("fetch", fetch); const storage = vi.spyOn(Storage.prototype, "setItem");
  try {
    mount(input); closed();
    expect(source().options).toHaveLength(152);
    expect(host.querySelectorAll("a")).toHaveLength(0);
    const summary = host.querySelector('[aria-label="作者资料就绪状态"]')!;
    expect([...summary.querySelectorAll("dd")].map(n => n.textContent)).toEqual(["150", "2", "152", "0", "152"]);
    expect(host.textContent).toContain("资料审阅可用，正式作答未就绪");
    expect(input).toEqual(before); expect(fetch).not.toHaveBeenCalled(); expect(storage).not.toHaveBeenCalled();
  } finally { storage.mockRestore(); }
});

it("bindings locate but never authorize, preserve selections and can be removed", () => {
  const input = fixture(); mount(input); dirty();
  mount(input, bindings(input)); closed();
  expect(source().value).toBe("skill:skill-2");
  expect(tabs()[1]!.getAttribute("aria-selected")).toBe("true");
  expect(host.querySelector("a")!.getAttribute("href")).toBe("https://review.example.invalid/material-0.pdf#page=2");
  expect([...host.querySelectorAll('[aria-label="作者资料就绪状态"] dd')].map(n => n.textContent)).toEqual(["150", "2", "152", "152", "0"]);
  click(tabs()[0]!); expect(workbench().querySelector("input")!.value).toBe("no-match");
  mount(input); expect(source().value).toBe("skill:skill-2"); expect(host.querySelectorAll("a")).toHaveLength(0); closed();
});

it("resets A → B → same A, null, invalid, flags and remount; no stale model survives", () => {
  const a = fixture(), b = structuredClone(a); b.skills.pop(); b.prerequisiteOrder = ["skill-1"];
  b.questions.forEach(q => { q.primarySkillId = "skill-1"; q.topic = 1; }); b.validation.skillCount = 1;
  mount(a); dirty(); mount(b);
  expect(source().options).toHaveLength(151);
  expect([...host.querySelectorAll('[aria-label="作者资料就绪状态"] dd')].map(n => n.textContent)).toEqual(["150", "1", "151", "0", "151"]);
  expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
  mount(a); reset(); dirty();
  for (const invalid of [null, { ...a, status: "SECRET" } as unknown as Input]) {
    mount(invalid); unavailable(); mount(a); reset(); dirty();
  }
  mount(a, undefined, { moduleStatus: "MODULE_READY" }); unavailable(); mount(a); reset();
  act(() => root.unmount()); root = createRoot(host); mount(a); reset(); closed();
});

it("captures raw getters once and keeps the model and surface on the same input across binding updates", () => {
  const input = fixture(), original = input.questions;
  const getter = vi.fn(() => getter.mock.calls.length === 1 ? original : []);
  Object.defineProperty(input, "questions", { enumerable: true, get: getter });
  mount(input); expect(getter).toHaveBeenCalledTimes(1); closed();
  input.skills[0]!.title = "SECRET_MUTATED_TITLE";
  Object.assign(original[0]!, { prompt: "PRIVATE_BODY", answer: "PRIVATE_ANSWER" });
  mount(input, bindings(input)); expect(getter).toHaveBeenCalledTimes(1);
  expect(source().options).toHaveLength(152); closed(); expect(host.innerHTML).not.toContain("SECRET_MUTATED_TITLE");
  mount(structuredClone(input)); unavailable(); mount(fixture()); closed();
});

it("captures explicit source getters once, isolates in-place mutation and rejects a new invalid reference", () => {
  const input = fixture(), provided = bindings(input), url = provided[0]!.pdfUrl;
  const getter = vi.fn(() => getter.mock.calls.length === 1 ? url : "http://SECRET.invalid/a.pdf");
  Object.defineProperty(provided[0]!, "pdfUrl", { enumerable: true, get: getter });
  mount(input, provided); expect(getter).toHaveBeenCalledTimes(1); closed();
  mount(input, provided); expect(getter).toHaveBeenCalledTimes(1);
  expect(host.querySelector("a")!.getAttribute("href")).toBe(`${url}#page=1`);
  mount(input, structuredClone(provided)); unavailable(); mount(input, bindings(input)); closed();
});

it.each(["report", "candidate", "authority", "bindings", "verified", "ready", "moduleStatus", "purpose", "firstAnswerAuthorized"])("rejects caller flag %s, not merely ignoring a counterfeit model", flag => {
  const input = fixture(); mount(input); dirty();
  mount(input, undefined, { [flag]: { status: "MODULE_READY", secret: "SECRET" } }); unavailable();
  mount(input); reset(); closed();
});

it.each(["prompt", "answer", "legacyNotes", "badPage", "badDiagnostic", "readyFlag", "bktFlag", "rawBasename"])("closes invalid raw boundary %s before rendering any successful review", kind => {
  const input = fixture(); mount(input); dirty(); const bad = structuredClone(input);
  if (kind === "prompt" || kind === "answer") Object.assign(bad.questions[0]!, { [kind]: "PRIVATE_BODY" });
  else if (kind === "legacyNotes") Object.assign(bad.questions[0]!, { notes: "PRIVATE_NOTES" });
  else if (kind === "badPage") bad.questions[0]!.physicalPage = 999;
  else if (kind === "badDiagnostic") bad.diagnostic.questionIds[0] = "SECRET_UNKNOWN";
  else if (kind === "readyFlag") Object.assign(bad.questions[0]!, { assessmentReadiness: true });
  else if (kind === "bktFlag") Object.assign(bad.questions[0]!, { bktAdmission: true });
  else bad.sources[0]!.file = " synthetic.pdf";
  mount(bad); unavailable(); mount(input); reset(); closed();
});

it.each(["url", "hash", "unknownFile", "extraFlag"])("closes invalid binding %s without leaking or retaining prior locations", kind => {
  const input = fixture(), provided = bindings(input); mount(input, provided); dirty();
  if (kind === "url") provided[0]!.pdfUrl = "https://SECRET.invalid/a.pdf#page=2";
  else if (kind === "hash") provided[0]!.pdfSha256 = "d".repeat(64);
  else if (kind === "unknownFile") provided[0]!.file = "SECRET.pdf";
  else Object.assign(provided[0]!, { verified: true });
  mount(input, [...provided]); unavailable(); mount(input); reset(); closed();
});

it("closes clone failure without showing private thrown messages or an old successful report", () => {
  mount(fixture());
  const input = fixture(); Object.defineProperty(input, "questions", { enumerable: true, get: () => { throw new Error("SECRET_PRIVATE_FAILURE"); } });
  mount(input); unavailable(); mount(fixture()); closed();
});

it("SSR omits every synthetic private note/objective/error and keeps the non-first-answer warning", () => {
  const input = fixture(); const html = renderToStaticMarkup(createElement(MaterialAuthorReviewHost, { input, providedSources: bindings(input) }));
  expect(html).toContain("MODULE_PENDING"); expect(html).toContain("not_ready");
  expect(html).toContain("不是首答界面"); expect(html).not.toMatch(/PRIVATE_|<(form|textarea|iframe|script)\b/);
  expect(html).toContain("https://review.example.invalid/material-0.pdf#page=1");
});

const realPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
describe.skipIf(!realPath)("explicit pinned private input host replay", () => {
  it("binds the actual 150/77/385 same-input review, still zero executable counts, and excludes private fields in SSR", () => {
    const bytes = readFileSync(realPath!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
    const input = JSON.parse(bytes.toString()) as Input, before = structuredClone(input);
    mount(input); closed(); expect(source().options).toHaveLength(227);
    expect([...host.querySelectorAll('[aria-label="作者资料就绪状态"] dd')].map(n => n.textContent)).toEqual(["150", "77", "385", "0", "385"]);
    const provided = bindings(input); mount(input, provided); closed();
    expect([...host.querySelectorAll('[aria-label="作者资料就绪状态"] dd')].map(n => n.textContent)).toEqual(["150", "77", "385", "385", "0"]);
    click(tabs()[1]!); select(source(), `skill:${input.skills.at(-1)!.id}`);
    expect(host.querySelectorAll("a").length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(createElement(MaterialAuthorReviewHost, { input, providedSources: provided }));
    const doc = document.createElement("div"); doc.innerHTML = html;
    for (const value of [...input.questions.flatMap(q => q.postAttemptNotes ? [q.postAttemptNotes] : []),
      ...input.skills.flatMap(s => [...s.learningObjectives, ...s.commonErrors])]) expect(doc.textContent).not.toContain(value);
    expect(input.diagnostic.questionIds).toHaveLength(20); expect(input.diagnostic.constructedResponseCandidates).toHaveLength(5);
    expect(input).toEqual(before); closed();
  });
});
