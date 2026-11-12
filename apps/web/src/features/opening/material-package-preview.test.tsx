import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { adaptMaterialCourseFullPackage, type MaterialCourseFullPackage } from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { MaterialPackagePreview } from "./material-package-preview";
import { readMaterialPackagePreview, type MaterialPackagePreviewCandidate } from "./material-package-preview-model";

const render = (candidate: unknown) => renderToStaticMarkup(createElement(MaterialPackagePreview, { candidate: candidate as MaterialPackagePreviewCandidate }));
const project = (candidate: unknown) => readMaterialPackagePreview(candidate as MaterialPackagePreviewCandidate);
const inputPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
const loadInput = (): MaterialCourseFullPackage => {
  const bytes = readFileSync(inputPath!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  return JSON.parse(bytes.toString("utf8"));
};
const load = () => adaptMaterialCourseFullPackage(loadInput(), { deadlineAt: null });

describe("preview closed boundary", () => {
  it.each([null, undefined, {}, { status: "published" }, { questionMappings: [] }])("closes on empty/invalid data %j", value => {
    expect(project(value)).toBeNull();
    expect(render(value)).toContain("暂不可预览");
    expect(render(value)).not.toContain("<details");
  });
});

describe.skipIf(!inputPath)("current real 041fc input → frozen R3 adapter → review-only preview", () => {
  it("renders current 150/77/15/20 with null bindings and no execution controls", () => {
    const c = load(), before = JSON.stringify(c), html = render(c);
    expect(project(c)).not.toBeNull();
    for (const count of [150, 77, 15, 20]) expect(html).toContain(`>${count}</dd>`);
    for (const q of c.questionMappings) expect(html).toContain(`（${q.id}）`);
    for (const skill of c.routeInput.requirements) expect(html).toContain(skill.title);
    for (const source of c.sources) expect(html).toContain(source.file);
    expect(html.match(/<dd>待绑定<\/dd>/g)).toHaveLength(7);
    expect(html).toContain("全部考点：未测");
    expect(html).toContain("待可信评分");
    expect(html).toContain("不是现行导入格式");
    expect(html).not.toMatch(/<(button|input|form|script)\b/);
    expect(JSON.stringify(c)).toBe(before);
  });

  it("projects current readiness including false without accepting legacy readiness", () => {
    const input = loadInput();
    input.questions.find(q => q.kind === "Problems" && !input.diagnostic.constructedResponseCandidates.includes(q.id)
      && q.mappingStatus === "text-reviewed" && q.assessmentReadiness === "requires-answer-key-and-exposure-check")!.assessmentReadiness = false;
    const c = adaptMaterialCourseFullPackage(input, { deadlineAt: null });
    expect(c.questionMappings.find(q => q.id === "T5-Q9")!.assessmentReadiness).toBe("blocked-author-exclusion");
    expect(project(c)).not.toBeNull();
    expect(render(c)).toContain("尚不可首答");
    expect(render(c)).toContain("不可进入诊断");
    expect(project({ ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, assessmentReadiness: "blocked-material-dispute" }) })).toBeNull();
  });

  it("strictly validates feedback-only metadata and removes its content from the view projection", () => {
    const c = load();
    c.postAttemptMetadata.questions[0]!.postAttemptNotes = "PRIVATE_POSTATTEMPT_SENTINEL";
    c.postAttemptMetadata.skills[0]!.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"];
    c.postAttemptMetadata.skills[0]!.commonErrors = ["PRIVATE_ERROR_SENTINEL"];
    const projection = project(c);
    expect(projection).not.toBeNull();
    expect(JSON.stringify(projection)).not.toContain("PRIVATE_");
    expect(render(c)).not.toContain("PRIVATE_");
    expect(render(c)).toContain("仅供审阅，不是首答界面");
    expect(render(c)).toContain("无题干，尚不可首答");
    for (const bad of [
      { ...c, postAttemptMetadata: undefined },
      { ...c, postAttemptMetadata: { ...c.postAttemptMetadata, role: "prompt" } },
      { ...c, postAttemptMetadata: { ...c.postAttemptMetadata, scoringEvidence: true } },
      { ...c, postAttemptMetadata: { ...c.postAttemptMetadata, independentIfExposedBeforeAnswer: true } },
      { ...c, postAttemptMetadata: { ...c.postAttemptMetadata, questions: [] } },
      { ...c, safeFirstAnswerInput: { ...c.safeFirstAnswerInput, bodyStatus: "ready" } },
      { ...c, safeFirstAnswerInput: { ...c.safeFirstAnswerInput, prompt: "PRIVATE_PROMPT" } },
    ]) expect(project(bad)).toBeNull();
  });

  it("rejects declared main and supplemental pollution instead of silently accepting adapter filtering", () => {
    const original = loadInput();
    for (const id of [...original.validation.visualCheckRequired, ...original.validation.disputedDiagnosticExclusions]) {
      for (const entry of ["main", "supplement"] as const) {
        const input = loadInput();
        if (entry === "main") input.diagnostic.questionIds[0] = id;
        else input.diagnostic.constructedResponseCandidates.push(id);
        const c = adaptMaterialCourseFullPackage(input, { deadlineAt: null });
        expect(c.questionMappings.find(q => q.id === id)!.diagnosticEligible).toBe(false);
        expect(project(c), `${entry} ${id}`).toBeNull();
        expect(render(c)).toContain("暂不可预览");
        expect(render(c)).not.toContain("<details");
      }
    }
  });

  it.each(["main", "supplement"] as const)("rejects %s false readiness or admission through real adapter", entry => {
    for (const field of ["assessmentReadiness", "bktAdmission"] as const) {
      const input = loadInput();
      const id = entry === "main" ? input.diagnostic.questionIds[0]! : input.diagnostic.constructedResponseCandidates[0]!;
      input.questions.find(q => q.id === id)![field] = false;
      const c = adaptMaterialCourseFullPackage(input, { deadlineAt: null });
      expect(project(c)).toBeNull();
      expect(render(c)).toContain("暂不可预览");
    }
  });

  it("preserves legal main20/supplement5 and offers skippable untested concept bridges without mastery gates", () => {
    const c = load(), before = JSON.stringify(c), html = render(c);
    expect(project(c)?.diagnostic.questionIds).toEqual(c.diagnostic.questionIds);
    expect(project(c)?.diagnostic.constructedResponseCandidates).toEqual(c.diagnostic.constructedResponseCandidates);
    expect(c.diagnostic.questionIds).toHaveLength(20);
    expect(c.diagnostic.constructedResponseCandidates).toHaveLength(5);
    for (const id of [...c.diagnostic.questionIds, ...c.diagnostic.constructedResponseCandidates]) expect(html).toContain(`（${id}）`);
    expect(html).toContain("概念桥接建议");
    expect(html).toContain("可跳过，不计掌握，不永久挡课");
    for (const b of c.prerequisiteGuidance.conceptBridges) {
      expect(b.skippable).toBe(true); expect(b.masteryCredit).toBe(false); expect(b.requiredPass).toBe(false);
    }
    expect(project({ ...c, prerequisiteGuidance: { ...c.prerequisiteGuidance, permanentPassGate: true } })).toBeNull();
    expect(project({ ...c, prerequisiteGuidance: { ...c.prerequisiteGuidance, conceptBridges: [] } })).toBeNull();
    expect(JSON.stringify(c)).toBe(before);
  });

  it("rejects superseded b54 input and its old adapter candidate rather than inheriting R2 approval", () => {
    const oldInput = process.env.MATERIAL_COURSE_SUPERSEDED_INPUT;
    const oldCandidate = process.env.MATERIAL_COURSE_SUPERSEDED_CANDIDATE;
    expect(oldInput).toBeTruthy(); expect(oldCandidate).toBeTruthy();
    const bytes = readFileSync(oldInput!);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("b54edd3e1192b0e91b0e2b5f661327a2a15a46b6460a4f96872bbd2498b26d5d");
    expect(() => adaptMaterialCourseFullPackage(JSON.parse(bytes.toString()), { deadlineAt: null })).toThrow();
    expect(project(JSON.parse(readFileSync(oldCandidate!, "utf8")))).toBeNull();
  });

  it("closes accessibly without leaking payloads for inconsistent first-answer identity or legacy notes", () => {
    const c = load();
    const badCases = [
      { ...c, safeFirstAnswerInput: { ...c.safeFirstAnswerInput, questions: c.safeFirstAnswerInput.questions.map((q, i) => i ? q : { ...q, sourceRef: { ...q.sourceRef, file: "unknown.pdf" } }) } },
      { ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, notes: "PRIVATE_LEGACY_SENTINEL" }) },
      { ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, postAttemptNotes: "PRIVATE_LEGACY_SENTINEL" }) },
      { ...c, postAttemptMetadata: { ...c.postAttemptMetadata, skills: c.postAttemptMetadata.skills.map((s, i) => i ? s : { ...s, skillId: "unknown" }) } },
      { ...c, sources: [] }, { ...c, published: true }, { ...c, prerequisiteOrder: [] },
      { ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, prompt: "PRIVATE_BODY_SENTINEL" }) },
      { ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, answer: "PRIVATE_ANSWER_SENTINEL" }) },
      { ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, scoringEligible: true }) },
      { ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, bktEligible: true }) },
    ];
    for (const bad of badCases) {
      expect(project(bad)).toBeNull();
      const html = render(bad);
      expect(html).toContain('aria-label="课程包预览"');
      expect(html).toContain("暂不可预览");
      expect(html).not.toContain("PRIVATE_");
      expect(html).not.toMatch(/<(details|button|form|input)\b/);
    }
  });

  it("derives the question denominator from props and closes on duplicate, missing, measured or unsafe data", () => {
    const c = load();
    const removable = c.questionMappings.find(q => !q.diagnosticEntryCandidate && !q.supplementalDiagnosticCandidate
      && q.mappingStatus === "text-reviewed" && q.assessmentReadiness === "requires-answer-key-and-exposure-check")!;
    const smaller = { ...c, questionMappings: c.questionMappings.filter(q => q.id !== removable.id),
      validation: { ...c.validation, questionCount: c.questionMappings.length - 1 },
      safeFirstAnswerInput: { ...c.safeFirstAnswerInput, questions: c.safeFirstAnswerInput.questions.filter(q => q.questionId !== removable.id) },
      postAttemptMetadata: { ...c.postAttemptMetadata, questions: c.postAttemptMetadata.questions.filter(q => q.questionId !== removable.id) } };
    expect(render(smaller)).toContain(">149</dd>");
    for (const bad of [
      { ...c, questionMappings: [c.questionMappings[1], ...c.questionMappings.slice(1)] },
      { ...c, validation: { ...c.validation, questionCount: 149 } },
      { ...c, routeInput: { ...c.routeInput, requirements: [] } },
      { ...c, coverage: c.coverage.map((s, i) => i ? s : { ...s, measurementStatus: "mastered" }) },
      { ...c, bktBoundary: { ...c.bktBoundary, learnerStateCreated: true } },
      { ...c, privateAnswerKeys: ["PRIVATE_KEY_SENTINEL"] },
      { ...c, learnerPrompts: ["PRIVATE_PROMPT_SENTINEL"] },
      { ...c, questionMappings: c.questionMappings.map((q, i) => i ? q : { ...q, physicalPage: 999999 }) },
    ]) {
      expect(project(bad)).toBeNull(); expect(render(bad)).toContain("暂不可预览");
    }
  });

  it("retains native keyboard disclosure semantics and current corrected mappings", () => {
    const c = load(), html = render(c);
    expect(html.match(/<details\b/g)?.length).toBeGreaterThan(5);
    expect(html.match(/<summary\b/g)?.length).toBe(html.match(/<details\b/g)?.length);
    expect(html).toContain("focus-visible:outline");
    expect(c.questionMappings.find(q => q.id === "T3-Q17")!.primarySkillId).toBe("t3-taylor");
    expect(c.questionMappings.find(q => q.id === "T3-Q17")!.secondarySkillIds).not.toContain("t3-taylor-error");
    expect(c.questionMappings.find(q => q.id === "T5-P10")!.secondarySkillIds).toContain("t1-algebra-functions");
  });

  it("preserves current coverage and prerequisite ordering without mastery or scoring", () => {
    const c = load(), html = render(c);
    expect(c.coverageGaps).toHaveLength(4);
    for (const gap of c.coverageGaps) expect(html).toContain(gap.scope);
    expect(html).toContain("清单不穷尽");
    const route = html.split("考点、先修与建议路线")[1]!.split("</details>")[0]!;
    let at = -1;
    for (const id of c.prerequisiteOrder) {
      const next = route.indexOf(`${c.routeInput.requirements.find(s => s.externalSkillId === id)!.title} · 未测`);
      expect(next).toBeGreaterThan(at); at = next;
    }
    expect(c.coverage.every(s => s.measurementStatus === "untested")).toBe(true);
    expect(c.questionMappings.every(q => q.prompt === null && q.answer === null && !q.scoringEligible && !q.bktEligible)).toBe(true);
  });
});
