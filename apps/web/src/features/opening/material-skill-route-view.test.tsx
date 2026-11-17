// @vitest-environment jsdom
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adaptMaterialCourseFullPackage, adaptMaterialCourseMappingPackage, materialCourseFullPackageSchema } from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { MaterialSkillRouteView, type MaterialSkillRouteData } from "./material-skill-route-view";

// Synthetic UI fixture only; real replay below never substitutes this for private input.
function fixture(): MaterialSkillRouteData {
  const skills = [
    { id: "foundation", title: "Foundation", topic: 1, prerequisiteIds: [] },
    { id: "advanced", title: "Advanced", topic: 2, prerequisiteIds: ["foundation"] },
    { id: "unmeasured", title: "Unmeasured", topic: 2, prerequisiteIds: ["advanced"] },
  ].map(skill => ({ ...skill, learningObjectives: [], commonErrors: [], sourceRefs: [{ file: "synthetic.pdf", physicalPages: [1], verification: "text-reviewed" as const }] }));
  const mapped = adaptMaterialCourseMappingPackage({
    schemaVersion: 1, topics: [1, 2], skills,
    questions: [
      { id: "entry", diagnosticEligible: true, mappingStatus: "text-reviewed" },
      { id: "visual", diagnosticEligible: true, mappingStatus: "needs-visual-check" },
      { id: "disputed", diagnosticEligible: false, mappingStatus: "text-reviewed" },
      { id: "supplement", diagnosticEligible: true, mappingStatus: "text-reviewed" },
      { id: "readiness-false", diagnosticEligible: false, mappingStatus: "text-reviewed" },
      { id: "bkt-false", diagnosticEligible: false, mappingStatus: "text-reviewed" },
    ].map(question => ({ ...question, topic: 2, kind: "Test", number: 1, sourceFile: "synthetic.pdf", physicalPage: 1, primarySkillId: "advanced", secondarySkillIds: [], evidenceType: "objective-choice", notes: "Synthetic metadata" })),
    verificationScope: "Synthetic", sourceResolution: "Synthetic", coverageGaps: [{ skillId: "unmeasured", scope: "No direct questions", candidateSource: "Synthetic source pending" }],
  }, { deadlineAt: null, validationScope: "complete", expectedQuestionCount: 6 });
  return { skillTopics: skills.map(({ id, topic }) => ({ id, topic })), candidate: {
    topics: mapped.topics, routeInput: { ...mapped.routeInput, requirements: mapped.routeInput.requirements.map(skill => ({ ...skill,
      diagnosticQuestionIds: skill.diagnosticQuestionIds.filter(id => id === "entry"),
      prerequisitePolicy: "concept_bridge_without_mastery_gate" as const,
      conceptBridges: skill.prerequisiteSkillIds.map(prerequisiteSkillId => ({ targetSkillId: skill.externalSkillId, prerequisiteSkillId,
        action: "concept_bridge" as const, reason: "no_learner_measurement" as const, measurementStatus: "untested" as const,
        skippable: true as const, requiredPass: false as const, masteryCredit: false as const })),
    })) }, coverageGaps: mapped.coverageGaps, prerequisiteOrder: skills.map(skill => skill.id),
    questionMappings: mapped.questionMappings.map(question => ({ ...question,
      assessmentReadiness: question.id === "disputed" ? "blocked-author-exclusion" as const : question.id === "visual" ? "blocked-visual-check" as const : question.id === "readiness-false" ? false as const : "requires-answer-key-and-exposure-check" as const,
      bktAdmission: question.id === "bkt-false" ? false as const : "requires-runtime-evidence-qualification" as const,
      diagnosticEntryCandidate: question.id === "entry", supplementalDiagnosticCandidate: question.id === "supplement", canonicalFamilyId: null, bktEligible: false as const, reliablePartScoring: "unverified" as const,
    })),
  } };
}
let host: HTMLDivElement;
let root: Root;
beforeEach(() => { vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
const render = (data: MaterialSkillRouteData | null, error?: string) => act(() => root.render(<MaterialSkillRouteView data={data} error={error} />));
const options = () => [...host.querySelectorAll<HTMLButtonElement>("nav button")];
const detail = () => host.querySelector<HTMLElement>('[aria-label="所选技能详情"]')!;
function choose(title: string) { const button = options().find(node => node.firstChild?.textContent === title)!; expect(button).toBeTruthy(); act(() => button.click()); }
function filter(topic: string) { const select = host.querySelector("select")!; act(() => { select.value = topic; select.dispatchEvent(new Event("change", { bubbles: true })); }); }
function reset() { act(() => [...host.querySelectorAll("button")].find(button => button.textContent === "重置筛选")!.click()); }
function search(query: string) { const input = host.querySelector("input")!; act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query); input.dispatchEvent(new Event("input", { bubbles: true })); }); }

describe("material skill route view", () => {
  it("filters using actual topic membership, including questionless skills; retains cross-topic prerequisites", () => {
    render(fixture()); filter("2");
    expect(options()).toHaveLength(2); choose("Advanced");
    const parents = detail().querySelector('[aria-label="直接先修"]')!;
    expect(parents.textContent).toContain("Foundation"); expect(parents.textContent).toContain("Topic 1");
    act(() => parents.querySelector("button")!.click());
    expect(host.querySelector("select")!.value).toBe("all");
    expect(detail().querySelector("h3")!.textContent).toBe("Foundation · 未测");
    expect(detail().querySelector("details")!.textContent).toContain("Advanced");
    choose("Unmeasured"); expect(detail().textContent).toContain("No direct questions");
    expect(detail().textContent).toContain("暂无入口诊断候选");
  });
  it("supports roving keyboard selection and focus without making a learning event", () => {
    const data = fixture(), before = JSON.stringify(data);
    render(data); const first = options()[0]!; first.focus();
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(options()[1]); expect(options()[1]!.getAttribute("aria-pressed")).toBe("true");
    act(() => options()[1]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(document.activeElement).toBe(options()[2]);
    act(() => options()[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(document.activeElement).toBe(options()[0]);
    choose("Advanced"); expect(detail().textContent).toContain("未测"); expect(JSON.stringify(data)).toBe(before);
    expect(host.textContent).toContain("不记录学习、不提升掌握状态或评分条件");
    expect(host.querySelectorAll('a, form, button[type="submit"]')).toHaveLength(0);
  });
  it("wraps keyboard focus within filtered results and ignores modified/composing keys", () => {
    render(fixture()); filter("2"); const first = options()[0]!; first.focus();
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })));
    expect(document.activeElement).toBe(options().at(-1));
    act(() => options().at(-1)!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(document.activeElement).toBe(options()[0]);
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { isComposing: true }]) {
      act(() => options()[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, ...init })));
      expect(document.activeElement).toBe(options()[0]);
    }
    search(" UNMEASURED "); expect(options()).toHaveLength(1);
    expect(options()[0]!.tabIndex).toBe(0);
    reset(); expect(options()).toHaveLength(3); expect(host.querySelector("input")!.value).toBe("");
    expect(host.querySelector("select")!.value).toBe("all"); expect(detail().textContent).toContain("Foundation");
  });
  it("shows entry candidates only as non-executable metadata, excludes visual/disputed items", () => {
    render(fixture()); choose("Advanced");
    expect(detail().textContent).toContain("entry · 主诊断入口候选，尚未施测，不可执行诊断");
    expect(detail().textContent).toContain("visual · 待视觉检查 · 排除诊断，不可评分");
    expect(detail().textContent).toContain("disputed · 作者排除（资料争议） · 排除诊断，不可评分");
    expect(detail().textContent).toContain("supplement · 补充构造题候选，尚未施测，不可执行诊断");
    for (const id of ["readiness-false", "bkt-false"]) expect(detail().textContent).toContain(`${id} · 条件未开放 · 排除诊断，不可评分`);
    expect(detail().querySelector('[aria-label="诊断候选与缺口"]')!.querySelectorAll("button")).toHaveLength(0);
    expect(detail().textContent).toContain("独立证据条件未知");
  });
  it("keeps concept bridges optional and review-only, without exposing feedback or objectives", () => {
    const data = { ...fixture(), postAttemptMetadata: { role: "feedback_only", questions: [{ postAttemptNotes: "PRIVATE_FEEDBACK_SENTINEL" }],
      skills: [{ learningObjectives: ["PRIVATE_OBJECTIVE_SENTINEL"], commonErrors: ["PRIVATE_ERROR_SENTINEL"] }] } };
    const before = JSON.stringify(data);
    render(data); choose("Advanced");
    const bridge = detail().querySelector('[aria-label="可选概念桥接"]')!;
    expect(bridge.textContent).toContain("Foundation · 未测");
    expect(bridge.textContent).toContain("也可跳过；不计掌握，不要求先通过，不是永久门槛");
    expect(bridge.querySelectorAll("button, a")).toHaveLength(0);
    expect(host.textContent).toContain("只读审阅模式"); expect(host.textContent).toContain("不是首答或作答页面");
    expect(host.textContent).not.toMatch(/PRIVATE_(FEEDBACK|OBJECTIVE|ERROR)_SENTINEL/);
    expect(JSON.stringify(data)).toBe(before);
  });
  it("handles no results and recovery without stale selected detail", () => {
    render(fixture()); choose("Advanced"); search("absent");
    expect(options()).toHaveLength(0); expect(detail().textContent).toBe("暂无所选技能。");
    expect(host.querySelector('[role="status"]')!.textContent).toContain("没有匹配技能");
    search(""); expect(options()).toHaveLength(3); expect(detail().textContent).toContain("Foundation");
    render({ ...fixture(), candidate: { ...fixture().candidate, prerequisiteOrder: [], routeInput: { status: "proposed", requirements: [] } }, skillTopics: [] });
    expect(options()).toHaveLength(0);
  });
  it("renders safe errors for failed upstream validation and missing/conflicting topic joins", () => {
    const invalid = materialCourseFullPackageSchema.safeParse({ skills: [{ id: "broken" }] });
    expect(invalid.success).toBe(false);
    render(null, invalid.success ? undefined : invalid.error.message); expect(host.querySelector('[role="alert"]')).not.toBeNull(); expect(host.textContent).not.toContain("broken");
    render(null, "PRIVATE RAW INPUT"); expect(host.textContent).not.toContain("PRIVATE RAW INPUT");
    const data = fixture(); render({ ...data, skillTopics: data.skillTopics.slice(1) });
    expect(host.querySelector('[role="alert"]')!.textContent).toContain("不完整或冲突");
    const invalidJoins: MaterialSkillRouteData[] = [
      { ...data, skillTopics: [...data.skillTopics, data.skillTopics[0]!] },
      { ...data, skillTopics: data.skillTopics.map((skill, i) => i === 0 ? { ...skill, id: "unknown" } : skill) },
      { ...data, skillTopics: data.skillTopics.map((skill, i) => i === 0 ? { ...skill, topic: 999 } : skill) },
      { ...data, candidate: { ...data.candidate, prerequisiteOrder: ["foundation", "advanced", "unknown"] } },
      { ...data, candidate: { ...data.candidate, prerequisiteOrder: ["foundation", "advanced", "advanced"] } },
      { ...data, candidate: { ...data.candidate, prerequisiteOrder: ["foundation"] } },
      { ...data, candidate: { ...data.candidate, routeInput: { ...data.candidate.routeInput, requirements: [data.candidate.routeInput.requirements[0]!, data.candidate.routeInput.requirements[0]!, data.candidate.routeInput.requirements[2]!] } } },
      { ...data, candidate: { ...data.candidate, routeInput: { ...data.candidate.routeInput, requirements: data.candidate.routeInput.requirements.map((skill, i) => i === 1 ? { ...skill, prerequisiteSkillIds: ["unknown"] } : skill) } } },
      { ...data, candidate: { ...data.candidate, routeInput: { ...data.candidate.routeInput, requirements: data.candidate.routeInput.requirements.map((skill, i) => i === 1 ? { ...skill, conceptBridges: skill.conceptBridges.map(bridge => ({ ...bridge, targetSkillId: "unknown" })) } : skill) } } },
    ];
    for (const invalidJoin of invalidJoins) {
      render(invalidJoin); expect(host.querySelector('[role="alert"]')).not.toBeNull();
      expect(host.querySelector("nav")).toBeNull(); expect(host.querySelector('[aria-label="所选技能详情"]')).toBeNull();
    }
    render(data); choose("Advanced");
    const replaced = fixture(); replaced.candidate.routeInput.requirements[1]!.title = "Replacement title";
    render(replaced); expect(detail().querySelector("h3")!.textContent).toBe("Replacement title · 未测");
    render(null); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
});

const realInputPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
it.skipIf(!realInputPath)("renders the pinned real adapter output and checks every topic, skill and direct edge without upgrading eligibility", () => {
  const bytes = readFileSync(realInputPath!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  const pack = materialCourseFullPackageSchema.parse(JSON.parse(bytes.toString("utf8")));
  const candidate = adaptMaterialCourseFullPackage(pack, { deadlineAt: null });
  const frozenOutputPath = process.env.MATERIAL_COURSE_FROZEN_OUTPUT;
  if (frozenOutputPath) expect(candidate).toEqual(JSON.parse(readFileSync(frozenOutputPath, "utf8")));
  expect(pack.skills).toHaveLength(77);
  expect(pack.skills.reduce((count, skill) => count + skill.prerequisiteIds.length, 0)).toBe(123);
  expect(candidate.diagnostic.eligibleEntryQuestionIds).toHaveLength(20);
  expect(candidate.diagnostic.constructedResponseCandidates).toHaveLength(5);
  const q17 = candidate.questionMappings.find(q => q.id === "T3-Q17")!;
  expect(q17.primarySkillId).toBe("t3-taylor"); expect(q17.secondarySkillIds).not.toContain("t3-taylor-error");
  expect(candidate.questionMappings.find(q => q.id === "T5-P10")!.secondarySkillIds).toContain("t1-algebra-functions");
  const ftc = pack.skills.find(skill => skill.id === "t4-fundamental-theorem")!;
  expect(candidate.routeInput.requirements.find(skill => skill.externalSkillId === ftc.id)!.prerequisiteSkillIds).toEqual(ftc.prerequisiteIds);
  expect(ftc.prerequisiteIds).toContain("t4-antiderivatives");
  expect(pack.skills.find(skill => skill.id === "t5-power-operations")!.prerequisiteIds).not.toContain("t5-termwise-operations");
  const before = JSON.stringify(candidate);
  // Both values come from this adapter invocation's validated input; no ID/topic inference.
  const data: MaterialSkillRouteData = { candidate, skillTopics: pack.skills.map(({ id, topic }) => ({ id, topic })) };
  const html = renderToStaticMarkup(<MaterialSkillRouteView data={data} />);
  expect(html).toContain(`${pack.skills.length} 项技能`); expect(html).not.toContain("PRIVATE");
  render(data);
  for (const topic of candidate.topics) {
    filter(String(topic));
    const members = pack.skills.filter(skill => skill.topic === topic);
    expect(options()).toHaveLength(members.length);
    for (const skill of members) {
      choose(skill.title);
      expect(detail().querySelector("h3")!.textContent).toBe(`${skill.title} · 未测`);
      const parentButtons = [...detail().querySelectorAll<HTMLButtonElement>('[aria-label="直接先修"] button')];
      expect(parentButtons.map(button => button.textContent?.split(" · Topic")[0]?.trim())).toEqual(skill.prerequisiteIds.map(parent => pack.skills.find(item => item.id === parent)!.title));
      const children = pack.skills.filter(row => row.prerequisiteIds.includes(skill.id));
      const childButtons = [...detail().querySelectorAll<HTMLButtonElement>("details button")];
      expect(childButtons.map(button => button.textContent?.split(" · Topic")[0]?.trim())).toEqual(candidate.prerequisiteOrder.filter(id => children.some(child => child.id === id)).map(id => pack.skills.find(row => row.id === id)!.title));
      const bridges = candidate.routeInput.requirements.find(row => row.externalSkillId === skill.id)!.conceptBridges;
      expect(bridges.map(bridge => bridge.prerequisiteSkillId)).toEqual(skill.prerequisiteIds);
      if (bridges.length) {
        const bridgeArea = detail().querySelector('[aria-label="可选概念桥接"]')!;
        for (const bridge of bridges) {
          expect(bridge.skippable).toBe(true); expect(bridge.requiredPass).toBe(false); expect(bridge.masteryCredit).toBe(false);
          expect(bridgeArea.textContent).toContain(`${pack.skills.find(row => row.id === bridge.prerequisiteSkillId)!.title} · 未测`);
        }
        expect(bridgeArea.textContent).toContain("不是永久门槛");
      }
      const diagnosticArea = detail().querySelector('[aria-label="诊断候选与缺口"]')!;
      for (const q of candidate.questionMappings.filter(q => q.primarySkillId === skill.id || q.secondarySkillIds.includes(skill.id))) {
        if (q.diagnosticEntryCandidate) expect(diagnosticArea.textContent).toContain(`${q.id} · 主诊断入口候选`);
        if (q.supplementalDiagnosticCandidate) expect(diagnosticArea.textContent).toContain(`${q.id} · 补充构造题候选`);
      }
      for (const q of candidate.questionMappings.filter(q => !q.diagnosticEligible && (q.primarySkillId === skill.id || q.secondarySkillIds.includes(skill.id)))) {
        expect(diagnosticArea.textContent).toContain(`${q.id} · ${q.assessmentReadiness === "blocked-author-exclusion" ? "作者排除（资料争议）" : q.assessmentReadiness === "blocked-visual-check" ? "待视觉检查" : "条件未开放"} · 排除诊断，不可评分`);
      }
      expect(diagnosticArea.querySelectorAll("button, a")).toHaveLength(0);
    }
  }
  const crossChapter = pack.skills.find(skill => skill.prerequisiteIds.some(parent => pack.skills.find(item => item.id === parent)!.topic !== skill.topic))!;
  filter(String(crossChapter.topic)); choose(crossChapter.title);
  const crossParent = crossChapter.prerequisiteIds.find(parent => pack.skills.find(item => item.id === parent)!.topic !== crossChapter.topic)!;
  const crossTitle = pack.skills.find(skill => skill.id === crossParent)!.title;
  act(() => [...detail().querySelectorAll<HTMLButtonElement>('[aria-label="直接先修"] button')].find(button => button.textContent?.startsWith(crossTitle))!.click());
  expect(detail().querySelector("h3")!.textContent).toBe(`${crossTitle} · 未测`);
  const selectedButton = options().find(button => button.getAttribute("aria-pressed") === "true")!;
  selectedButton.focus();
  act(() => selectedButton.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
  expect(document.activeElement).toBe(options().at(-1));
  search("no-real-skill-matches-this"); expect(options()).toHaveLength(0); expect(detail().textContent).toBe("暂无所选技能。");
  reset(); expect(options()).toHaveLength(pack.skills.length);
  const realSkill = pack.skills.find(skill => skill.id === "t5-pointwise-convergence")!;
  filter(String(realSkill.topic)); search(realSkill.id); expect(options()).toHaveLength(1);
  expect(detail().querySelector("h3")!.textContent).toBe(`${realSkill.title} · 未测`);
  reset(); expect(options()).toHaveLength(77);
  filter(String(ftc.topic)); choose(ftc.title);
  expect(detail().querySelector('[aria-label="直接先修"]')!.textContent).toContain(pack.skills.find(skill => skill.id === "t4-antiderivatives")!.title);
  const taylor = pack.skills.find(skill => skill.id === "t3-taylor")!; filter(String(taylor.topic)); choose(taylor.title);
  expect(detail().textContent).not.toContain("T3-Q17 · 主诊断入口候选");
  const expansions = pack.skills.find(skill => skill.id === "t5-power-expansions")!; filter(String(expansions.topic)); choose(expansions.title);
  expect(detail().querySelector('[aria-label="直接先修"]')!.textContent).toContain(pack.skills.find(skill => skill.id === "t1-algebra-functions")!.title);
  reset();
  expect(candidate.validation.visualCheckRequired).toHaveLength(6);
  expect(candidate.questionMappings.find(q => q.id === "T5-Q9")!.diagnosticEligible).toBe(false);
  for (const privateText of [...candidate.postAttemptMetadata.questions.map(q => q.postAttemptNotes),
    ...candidate.postAttemptMetadata.skills.flatMap(skill => [...skill.learningObjectives, ...skill.commonErrors])]) {
    expect(host.textContent).not.toContain(privateText);
  }
  expect(candidate.questionMappings.every(question => !question.scoringEligible && !question.bktEligible)).toBe(true);
  expect(candidate.coverage.every(row => row.measurementStatus === "untested" && row.independentEligibility === "unknown")).toBe(true);
  expect(candidate.published).toBe(false); expect(candidate.diagnostic.administered).toBe(false);
  expect(JSON.stringify(candidate)).toBe(before);
});
