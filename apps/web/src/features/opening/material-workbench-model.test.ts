import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import * as adapter from "../../../../../packages/domain/src/opening/material-course-package-adapter";
import { readMaterialWorkbench } from "./material-workbench-model";
import { readMaterialPackagePreview } from "./material-package-preview-model";

const inputPath = process.env.MATERIAL_COURSE_REAL_FULL_INPUT;
const load = (): adapter.MaterialCourseFullPackage => {
  const bytes = readFileSync(inputPath!);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe("041fc627da988c794309d116b4d2f85a4796ed497e33e99155b59f4dcd5c2a5b");
  return JSON.parse(bytes.toString());
};

describe("current workbench external input boundary", () => {
  it.each([null, undefined, {}, [], "private payload", { status: "published" }])("closes malformed input %j", input => {
    expect(readMaterialWorkbench(input)).toBeNull();
  });
});

describe.skipIf(!inputPath)("current same-capture metadata composition", () => {
  it("runs R3 once and derives both real children from that capture without mutation", () => {
    const input = load(), before = JSON.stringify(input);
    const spy = vi.spyOn(adapter, "adaptMaterialCourseFullPackage");
    try {
      const data = readMaterialWorkbench(input)!;
      expect(spy).toHaveBeenCalledTimes(1);
      expect(data.route.candidate.routeInput).toBe(data.candidate.routeInput);
      expect(data.route.candidate.questionMappings).toBe(data.candidate.questionMappings);
      expect(data.route.skillTopics).toEqual(input.skills.map(({ id, topic }) => ({ id, topic })));
      expect(data.candidate).toEqual(adapter.adaptMaterialCourseFullPackage(input, { deadlineAt: null }));
      expect(JSON.stringify(input)).toBe(before);
      input.skills[0]!.topic = 999;
      expect(data.route.skillTopics[0]!.topic).not.toBe(999);
    } finally { spy.mockRestore(); }
  });

  it("keeps every skill's actual topic including questionless skills", () => {
    const input = load(), data = readMaterialWorkbench(input)!;
    for (const skill of input.skills) expect(data.route.skillTopics.find(s => s.id === skill.id)?.topic).toBe(skill.topic);
    expect(input.skills.filter(s => !input.questions.some(q => [q.primarySkillId, ...q.secondarySkillIds].includes(s.id))).length).toBeGreaterThan(0);
  });

  it("rejects externally paired candidate/topics and legacy notes instead of self-signing them", () => {
    const input = load(), candidate = adapter.adaptMaterialCourseFullPackage(input, { deadlineAt: null });
    const skillTopics = input.skills.map(({ id }) => ({ id, topic: 1 }));
    expect(readMaterialWorkbench({ candidate, skillTopics })).toBeNull();
    expect(readMaterialWorkbench({ ...input, candidate, skillTopics })).toBeNull();
    Object.assign(input.questions[0]!, { notes: "LEGACY_PRIVATE" });
    expect(readMaterialWorkbench(input)).toBeNull();
  });

  it("separates post-attempt feedback from both display projections and first-answer planning", () => {
    const input = load();
    input.questions.forEach(q => { q.postAttemptNotes = "PRIVATE_FEEDBACK_SENTINEL"; });
    input.skills.forEach(s => { s.learningObjectives = ["PRIVATE_OBJECTIVE_SENTINEL"]; s.commonErrors = ["PRIVATE_ERROR_SENTINEL"]; });
    const data = readMaterialWorkbench(input)!;
    expect(data.candidate.postAttemptMetadata.role).toBe("feedback_only");
    expect(data.candidate.postAttemptMetadata.independentIfExposedBeforeAnswer).toBe(false);
    expect(data.candidate.postAttemptMetadata.scoringEvidence).toBe(false);
    expect(data.candidate.postAttemptMetadata.questions).toHaveLength(150);
    const view = readMaterialPackagePreview(data.candidate)!;
    for (const projection of [view, data.route, data.candidate.safeFirstAnswerInput]) {
      expect(JSON.stringify(projection)).not.toMatch(/PRIVATE_(FEEDBACK|OBJECTIVE|ERROR)_SENTINEL/);
      expect(projection).not.toHaveProperty("postAttemptMetadata");
    }
    expect(data.candidate.safeFirstAnswerInput.bodyStatus).toBe("missing");
    expect(data.candidate.safeFirstAnswerInput.questions.map(q => q.questionId)).toEqual(input.questions.map(q => q.id));
  });

  it("keeps real main20/supp5 and every bridge optional with no mastery or permanent gate", () => {
    const input = load(), { candidate: c } = readMaterialWorkbench(input)!;
    expect(c.diagnostic.questionIds).toEqual(input.diagnostic.questionIds);
    expect(c.diagnostic.questionIds).toHaveLength(20);
    expect(c.diagnostic.constructedResponseCandidates).toEqual(input.diagnostic.constructedResponseCandidates);
    expect(c.diagnostic.constructedResponseCandidates).toHaveLength(5);
    expect(c.diagnostic.blockedEntryQuestionIds).toEqual([]); expect(c.diagnostic.blockedConstructedResponseCandidates).toEqual([]);
    for (const id of [...c.validation.visualCheckRequired, "T5-Q9"]) {
      const q = c.questionMappings.find(q => q.id === id)!;
      expect(q.diagnosticEligible).toBe(false); expect(q.diagnosticEntryCandidate).toBe(false); expect(q.supplementalDiagnosticCandidate).toBe(false);
      expect([...c.diagnostic.questionIds, ...c.diagnostic.constructedResponseCandidates]).not.toContain(id);
    }
    expect(c.prerequisiteGuidance.masteryCredit).toBe(false); expect(c.prerequisiteGuidance.permanentPassGate).toBe(false);
    expect(c.prerequisiteGuidance.learnerMeasurement).toBe("not_supplied");
    expect(c.prerequisiteGuidance.conceptBridges).toHaveLength(input.skills.reduce((n, s) => n + s.prerequisiteIds.length, 0));
    expect(c.prerequisiteGuidance.conceptBridges.every(b => b.skippable && !b.requiredPass && !b.masteryCredit && b.measurementStatus === "untested")).toBe(true);
  });

  it.each(["main", "supplement"] as const)("closes the entire composition on %s pollution: visual, false readiness, false BKT, dispute", list => {
    for (const kind of ["visual", "false-readiness", "false-bkt", "dispute"] as const) {
      const input = load();
      const id = kind === "visual" ? "T1-P3" : kind === "dispute" ? "T5-Q9" : input.diagnostic.constructedResponseCandidates[0]!;
      const q = input.questions.find(q => q.id === id)!;
      if (kind === "false-readiness") q.assessmentReadiness = false;
      if (kind === "false-bkt") q.bktAdmission = false;
      if (list === "main") input.diagnostic.questionIds[0] = id;
      else if (!input.diagnostic.constructedResponseCandidates.includes(id)) input.diagnostic.constructedResponseCandidates[0] = id;
      expect(readMaterialWorkbench(input), `${list}/${kind}`).toBeNull();
    }
  });

  it("keeps actual counts and all unknown/read-only learning boundaries", () => {
    const c = readMaterialWorkbench(load())!.candidate;
    expect(c.questionMappings).toHaveLength(150); expect(c.routeInput.requirements).toHaveLength(77); expect(c.sources).toHaveLength(15);
    expect(c.validation.visualCheckRequired).toHaveLength(6); expect(c.validation.disputedDiagnosticExclusions).toEqual(["T5-Q9"]);
    expect(c.coverageGaps).toHaveLength(4); expect(c.coverageExhaustive).toBe(false);
    expect([c.ownerUserId, c.courseId, c.routeVersion, c.teachingVersion, c.deadlineAt, c.schedule.actualExamDate, c.schedule.dailyStudyMinutes]).toEqual(Array(7).fill(null));
    expect(c.questionMappings.every(q => q.prompt === null && q.answer === null && !q.scoringEligible && !q.bktEligible)).toBe(true);
    expect(c.coverage.every(s => s.measurementStatus === "untested" && s.independentEligibility === "unknown")).toBe(true);
    expect(c.learnerPrompts).toEqual([]); expect(c.privateAnswerKeys).toEqual([]);
    expect(c.published).toBe(false); expect(c.diagnostic.administered).toBe(false);
    expect(c.bktBoundary.calibrated).toBe(false); expect(c.bktBoundary.learnerStateCreated).toBe(false);
  });

  it.each([
    ["empty questions", (p: adapter.MaterialCourseFullPackage) => { p.questions = []; }],
    ["empty skills", (p: adapter.MaterialCourseFullPackage) => { p.skills = []; }],
    ["empty sources", (p: adapter.MaterialCourseFullPackage) => { p.sources = []; }],
    ["duplicate question", (p: adapter.MaterialCourseFullPackage) => { p.questions[0] = p.questions[1]!; }],
    ["duplicate skill", (p: adapter.MaterialCourseFullPackage) => { p.skills[0] = p.skills[1]!; }],
    ["missing parent", (p: adapter.MaterialCourseFullPackage) => { p.skills[0]!.prerequisiteIds = ["missing"]; }],
    ["mismatched order", (p: adapter.MaterialCourseFullPackage) => { p.prerequisiteOrder.reverse(); }],
    ["unknown topic", (p: adapter.MaterialCourseFullPackage) => { p.questions[0]!.topic = 999; }],
    ["wrong denominator", (p: adapter.MaterialCourseFullPackage) => { p.validation.skillCount++; }],
    ["missing source", (p: adapter.MaterialCourseFullPackage) => { p.questions[0]!.sourceFile = "missing"; }],
    ["out of bounds page", (p: adapter.MaterialCourseFullPackage) => { p.questions[0]!.physicalPage = 999999; }],
    ["visual mismatch", (p: adapter.MaterialCourseFullPackage) => { p.validation.visualCheckRequired = []; }],
    ["published", (p: adapter.MaterialCourseFullPackage) => { p.status = "published" as never; }],
    ["scoring", (p: adapter.MaterialCourseFullPackage) => { Object.assign(p.questions[0]!, { scoringEligible: true }); }],
    ["prompt leak", (p: adapter.MaterialCourseFullPackage) => { Object.assign(p.questions[0]!, { prompt: "PRIVATE_BODY" }); }],
    ["answer leak", (p: adapter.MaterialCourseFullPackage) => { Object.assign(p.questions[0]!, { answer: "PRIVATE_ANSWER" }); }],
    ["calibrated BKT", (p: adapter.MaterialCourseFullPackage) => { p.bktBoundary.calibrated = true as false; }],
    ["legacy readiness", (p: adapter.MaterialCourseFullPackage) => { p.questions[0]!.assessmentReadiness = "blocked-material-dispute" as never; }],
  ] as const)("closes %s without partial children", (_label, mutate) => {
    const input = load(); mutate(input); expect(readMaterialWorkbench(input)).toBeNull();
  });

  it("rejects mismatched adapter snapshots at the composition boundary", () => {
    const input = load();
    const original = adapter.adaptMaterialCourseFullPackage(input, { deadlineAt: null });
    for (const mutate of [
      (c: typeof original) => { c.safeFirstAnswerInput.questions[0]!.sourceRef.page++; },
      (c: typeof original) => { c.postAttemptMetadata.questions.pop(); },
      (c: typeof original) => { c.postAttemptMetadata.skills[0]!.skillId = "other-snapshot"; },
      (c: typeof original) => { Object.assign(c.questionMappings[0]!, { postAttemptNotes: "PRIVATE_FEEDBACK" }); },
    ]) {
      const candidate = structuredClone(original); mutate(candidate);
      const spy = vi.spyOn(adapter, "adaptMaterialCourseFullPackage").mockReturnValue(candidate);
      try { expect(readMaterialWorkbench(input)).toBeNull(); } finally { spy.mockRestore(); }
    }
  });

  it("keeps R3's corrected mappings and normalized skill keys", () => {
    const input = load(); input.skills = input.skills.map(s => ({ ...s, id: ` ${s.id} ` }));
    const data = readMaterialWorkbench(input)!;
    expect(data.route.skillTopics.map(s => s.id)).toEqual(data.candidate.routeInput.requirements.map(s => s.externalSkillId));
    expect(data.candidate.questionMappings.find(q => q.id === "T3-Q17")!.primarySkillId).toBe("t3-taylor");
    expect(data.candidate.questionMappings.find(q => q.id === "T3-Q17")!.secondarySkillIds).not.toContain("t3-taylor-error");
    expect(data.candidate.questionMappings.find(q => q.id === "T5-P10")!.secondarySkillIds).toContain("t1-algebra-functions");
  });
});
