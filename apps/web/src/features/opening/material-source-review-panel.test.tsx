// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { materialCourseFullPackageSchema } from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { MaterialSourceReviewPanel } from "./material-source-review-panel";

function load() {
  const bytes = readFileSync(process.env.MATERIAL_COURSE_REAL_FULL_INPUT!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  return materialCourseFullPackageSchema.parse(JSON.parse(bytes.toString("utf8")));
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const detail = () => host.querySelector<HTMLElement>('[aria-label="所选来源详情"]')!;
function choose(key: string) {
  const select = host.querySelector("select")!;
  act(() => { select.value = key; select.dispatchEvent(new Event("change", { bubbles: true })); });
}
it("renders only a generic safe error on invalid input", () => {
  const html = renderToStaticMarkup(<MaterialSourceReviewPanel input={null} />);
  expect(html).toContain('role="alert"'); expect(html).not.toContain("PRIVATE_BODY_ANSWER"); expect(html).not.toContain("href=");
});
describe.skipIf(!process.env.MATERIAL_COURSE_REAL_FULL_INPUT)("real metadata source panel", () => {
  it("selects all actual questions and skills; default bindings remain unbound without invented URLs", () => {
    const input = load(), before = JSON.stringify(input);
    act(() => root.render(<MaterialSourceReviewPanel input={input} />));
    expect(host.querySelectorAll("option")).toHaveLength(227);
    for (const q of input.questions) {
      choose(`question:${q.id}`);
      expect(detail().textContent).toContain(q.sourceFile); expect(detail().textContent).toContain(`物理页 ${q.physicalPage} /`);
      expect(detail().textContent).toContain("未绑定（unbound）");
    }
    for (const s of input.skills) {
      choose(`skill:${s.id}`);
      for (const ref of s.sourceRefs) for (const page of ref.physicalPages) {
        expect(detail().textContent).toContain(ref.file); expect(detail().textContent).toContain(`物理页 ${page} /`);
      }
    }
    expect(host.querySelectorAll("a, iframe, script, form")).toHaveLength(0);
    expect(host.textContent).toContain("无题干答案"); expect(JSON.stringify(input)).toBe(before);
  });
  it("opens only exact host URL plus physical page with safe new-window attributes, without eligibility upgrades", () => {
    const input = load(), source = input.sources.find(s => s.file === input.questions[0]!.sourceFile)!;
    const binding = { file: source.file, pdfSha256: source.sha256, sourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 3, pdfUrl: "https://synthetic.example/authorized.pdf?sig=A%2Bb&v=1" };
    const before = JSON.stringify(input);
    act(() => root.render(<MaterialSourceReviewPanel input={input} providedSources={[binding]} />));
    const q = input.questions.find(q => q.sourceFile === source.file)!; choose(`question:${q.id}`);
    const a = detail().querySelector("a")!;
    expect(a.getAttribute("href")).toBe(`${binding.pdfUrl}#page=${q.physicalPage}`);
    expect(a.target).toBe("_blank"); expect(a.rel).toBe("noopener noreferrer"); expect(a.getAttribute("referrerpolicy")).toBe("no-referrer");
    // Exercise the click without a navigation/network request. Viewing is not a measurement event.
    a.addEventListener("click", event => event.preventDefault()); act(() => a.click());
    expect(detail().textContent).toContain(binding.sourceId); expect(detail().textContent).toContain("version：3");
    expect(detail().textContent).toContain("sourceID 不等于 canonical family");
    expect(detail().textContent).toContain("此处不可作答、施测、评分或写入 BKT");
    expect(JSON.stringify(input)).toBe(before);
  });
  it("provides labeled keyboard-native selection, focus continuity, live status and safe input replacement", () => {
    const input = load(); act(() => root.render(<MaterialSourceReviewPanel input={input} />));
    const select = host.querySelector("select")!;
    expect(host.querySelector(`label[for="${select.id}"]`)!.textContent).toContain("选择题目或技能");
    expect(select.getAttribute("aria-controls")).toBe(detail().id);
    select.focus(); choose(`skill:${input.skills.at(-1)!.id}`);
    expect(document.activeElement).toBe(select);
    expect(host.querySelector('[role="status"]')!.textContent).toContain(input.skills.at(-1)!.id);
    // Native select supplies platform keyboard behavior; jsdom does not simulate a browser picker.
    expect(select.disabled).toBe(false); expect(select.tabIndex).toBe(0);
    const next = structuredClone(input); next.questions[0]!.id = "replacement-first";
    act(() => root.render(<MaterialSourceReviewPanel input={next} />));
    expect(host.querySelector("select")!.value).toBe("question:replacement-first");
    expect(detail().querySelector("h3")!.textContent).toBe("题目 replacement-first");
  });
  it.each(["replacement", "null"] as const)("resets saved selection through %s and back to the same input object", transition => {
    const input = load();
    act(() => root.render(<MaterialSourceReviewPanel input={input} />));
    choose(`skill:${input.skills.at(-1)!.id}`);
    expect(host.querySelector("select")!.value).toBe(`skill:${input.skills.at(-1)!.id}`);
    act(() => root.render(<MaterialSourceReviewPanel input={transition === "null" ? null : structuredClone(input)} />));
    act(() => root.render(<MaterialSourceReviewPanel input={input} />));
    expect(host.querySelector("select")!.value).toBe(`question:${input.questions[0]!.id}`);
  });
  it("removes all located targets for invalid bindings, unknown tail refs or same-object mutation", () => {
    const input = load(), source = input.sources.find(s => s.file === input.questions[0]!.sourceFile)!;
    const binding = { file: source.file, pdfSha256: source.sha256, sourceId: "11111111-1111-4111-8111-111111111111", sourceVersion: 0, pdfUrl: "https://synthetic.example/a.pdf" };
    const render = (providedSources: unknown = [binding]) => act(() => root.render(<MaterialSourceReviewPanel input={input} providedSources={providedSources} />));
    render(); expect(host.querySelector("a")).not.toBeNull();
    for (const pdfUrl of [" https://synthetic.example/a", "https:////synthetic.example/a", "https://synthetic.example/a#page=999"]) {
      render([{ ...binding, pdfUrl }]); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.querySelector("a")).toBeNull();
    }
    render([{ ...binding, pdfSha256: "0".repeat(64) }]); expect(host.querySelector("a")).toBeNull();
    render([]); expect(host.querySelector("a")).toBeNull(); expect(detail().textContent).toContain("未绑定（unbound）");
    render(); expect(host.querySelector("a")).not.toBeNull();
    input.skills.at(-1)!.sourceRefs.push({ file: "UNKNOWN_TAIL.pdf", physicalPages: [1], verification: "text-reviewed" });
    render(); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.querySelector("select, a")).toBeNull();
  });
  it("does not disclose answer bodies, post-attempt content, skill objectives/errors or raw validation errors", () => {
    const input = load();
    input.questions[0]!.postAttemptNotes = "PRIVATE_NOTES_SENTINEL";
    input.skills[0]!.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"];
    input.skills[0]!.commonErrors = ["PRIVATE_ERRORS_SENTINEL"];
    act(() => root.render(<MaterialSourceReviewPanel input={input} />));
    choose(`skill:${input.skills[0]!.id}`);
    expect(host.textContent).not.toContain("PRIVATE_");
    expect(host.textContent).toContain("不是首答界面"); expect(host.textContent).toContain("计为帮助（help）");
    expect(host.textContent).toContain("只读审阅／答后核对");
    const polluted = { ...input, questions: [{ ...input.questions[0]!, prompt: "PRIVATE_PROMPT_SENTINEL", answer: "PRIVATE_ANSWER_SENTINEL", postAttemptNotes: "PRIVATE_POST_ATTEMPT_SENTINEL" }] };
    act(() => root.render(<MaterialSourceReviewPanel input={polluted} />));
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.textContent).not.toContain("PRIVATE_");
  });
  it.each(["review", "post-attempt"] as const)("keeps help/no-leak/no-admission boundary in actual %s component context", purpose => {
    const input = load(), before = JSON.stringify(input);
    input.questions.forEach(q => { q.postAttemptNotes = "PRIVATE_FEEDBACK_SENTINEL"; });
    input.skills.forEach(s => { s.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"]; s.commonErrors = ["PRIVATE_ERRORS_SENTINEL"]; });
    act(() => root.render(<MaterialSourceReviewPanel input={input} purpose={purpose} />));
    choose(`skill:${input.skills.at(-1)!.id}`);
    expect(host.textContent).toContain(purpose === "review" ? "当前用途：资料审阅" : "当前用途：答后核对");
    expect(host.textContent).toContain("计为帮助（help）"); expect(host.textContent).toContain("不能作为无帮助首答证据");
    expect(host.textContent).not.toContain("PRIVATE_");
    expect(host.textContent).toContain("此处不可作答、施测、评分或写入 BKT");
    expect(host.querySelectorAll("iframe, form, script")).toHaveLength(0);
    // Only the deliberate test sentinel changes occurred; viewing generated no attempt fields.
    expect(Object.keys(input)).toEqual(Object.keys(JSON.parse(before)));
  });
  it("updates exact links on binding replacement, fails closed on identity/hash pollution and recovers without stale details", () => {
    const input = load();
    const provided = input.sources.map((s, i) => ({ file: s.file, pdfSha256: s.sha256, sourceId: `11111111-1111-4111-8111-${String(i + 1).padStart(12, "0")}`, sourceVersion: i, pdfUrl: `https://synthetic.example/${i}.pdf?sig=A%2Bb` }));
    const render = (bindings: unknown) => act(() => root.render(<MaterialSourceReviewPanel input={input} providedSources={bindings} purpose="post-attempt" />));
    render(provided); const q = input.questions.at(-1)!; choose(`question:${q.id}`);
    const idx = provided.findIndex(b => b.file === q.sourceFile);
    const updated = provided.map((b, i) => i === idx ? { ...b, sourceVersion: b.sourceVersion + 1, pdfUrl: "https://synthetic.example/replacement.pdf?sig=Z%2BY" } : b);
    render(updated);
    expect(host.querySelector("select")!.value).toBe(`question:${q.id}`);
    expect(detail().querySelector("a")!.getAttribute("href")).toBe(`${updated[idx]!.pdfUrl}#page=${q.physicalPage}`);
    for (const bad of [
      updated.map((b, i) => i === updated.length - 1 ? { ...b, sourceId: updated[0]!.sourceId } : b),
      updated.map((b, i) => i === updated.length - 1 ? { ...b, pdfSha256: "0".repeat(64) } : b),
    ]) {
      render(bad); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.querySelector("select, a")).toBeNull();
      render(updated); expect(detail().querySelector("a")).not.toBeNull();
    }
    const fresh = structuredClone(input);
    act(() => root.render(<MaterialSourceReviewPanel input={fresh} providedSources={updated} />));
    expect(host.querySelector("select")!.value).toBe(`question:${fresh.questions[0]!.id}`);
  });
  it("handles null and questionless input variants without fabricated content; native select does not trap Tab or Enter", () => {
    const input = load(); input.questions = [];
    act(() => root.render(<MaterialSourceReviewPanel input={input} />));
    expect(host.querySelectorAll("option")).toHaveLength(77);
    expect(detail().textContent).toContain("没有关联题目");
    const select = host.querySelector("select")!; select.focus();
    for (const key of ["Tab", "Enter", "ArrowDown", "Home", "End"]) {
      const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
      act(() => select.dispatchEvent(event)); expect(event.defaultPrevented).toBe(false);
    }
    // Unit verifies no custom trap; native picker/navigation/AT behavior remains user browser acceptance.
    act(() => root.render(<MaterialSourceReviewPanel input={null} />));
    expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.querySelector("select, a")).toBeNull();
    const fresh = load(); act(() => root.render(<MaterialSourceReviewPanel input={fresh} />));
    expect(host.querySelector("select")!.value).toBe(`question:${fresh.questions[0]!.id}`);
  });
  it("renders every real entry/supplemental readiness variant in both question and related skill details, without enabling assessment", () => {
    const input = load();
    for (const id of [...input.diagnostic.questionIds, ...input.diagnostic.constructedResponseCandidates]) {
      const q = input.questions.find(q => q.id === id)!; q.assessmentReadiness = false; q.bktAdmission = false;
      act(() => root.render(<MaterialSourceReviewPanel input={input} />));
      choose(`question:${id}`);
      expect(detail().textContent).toContain("assessmentReadiness=false"); expect(detail().textContent).toContain("bktAdmission=false");
      choose(`skill:${q.primarySkillId}`); expect(detail().textContent).toContain(`${id}：`);
      expect(host.querySelectorAll("form, input, button")).toHaveLength(0);
    }
  });
  it("retains the real six visual exclusions and disputed Q9 reasons when selecting questions and related skills", () => {
    const input = load(); act(() => root.render(<MaterialSourceReviewPanel input={input} />));
    expect(input.validation.visualCheckRequired).toHaveLength(6);
    expect(input.validation.disputedDiagnosticExclusions).toEqual(["T5-Q9"]);
    for (const id of [...input.validation.visualCheckRequired, "T5-Q9"]) {
      const q = input.questions.find(q => q.id === id)!;
      choose(`question:${id}`);
      const expected = id === "T5-Q9" ? "资料作者排除，禁用诊断" : "待视觉核验，排除诊断";
      expect(detail().textContent).toContain(expected);
      choose(`skill:${q.primarySkillId}`); expect(detail().textContent).toContain(`${id}：`); expect(detail().textContent).toContain(expected);
    }
    expect(host.querySelectorAll('form, button[type="submit"]')).toHaveLength(0);
  });
});
