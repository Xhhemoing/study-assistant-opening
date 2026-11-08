import { describe, expect, it } from "vitest";
import type { CourseRequirement } from "@aistudy/contracts";
import { courseRequirementProgress, type CourseRouteObservation } from "@aistudy/domain";
import { parseExamSprintSnapshot } from "./opening-exam-sprint-snapshot";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import { createExamSprintState } from "@aistudy/domain";
import { projectExamCourseEvidence, type ExamCourseEvidenceLink } from "./opening-course-exam-evidence-projection";

const requirement: CourseRequirement = { id: "r", courseId: "c", stableSkillId: "skill", knowledgeNodeId: "node", requirementKey: "knowledge:node", title: "same", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [], verification: { kind: "exact", status: "ready", exerciseKeys: [], rubric: null, missingReasons: [] }, revision: 2, lifecycle: "active", origin: "confirmed", approvedAt: "2026-11-06T12:00:00Z" };
const observation: CourseRouteObservation = { id: "head", skillLabel: "same", requirementKey: "exam-skill:node", attemptedAt: "2026-11-06T12:01:00Z", assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes", problemId: "p", itemVersionId: "i" };
const link: ExamCourseEvidenceLink = { observationId: "root", nodeId: "node", requirementKey: "exam-skill:node", capturedAt: "2026-11-06T12:01:00Z", identityCurrent: true };
const roots = new Map([["head", "root"]]);
const project = (r: CourseRequirement[] = [requirement], l: ExamCourseEvidenceLink[] = [link], o: CourseRouteObservation = observation) => projectExamCourseEvidence([o], roots, r, l)[0]!;

describe("private per-part projection and snapshot boundary", () => {
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const second = { ...requirement, id: "r2", stableSkillId: "skill2", knowledgeNodeId: "node2", requirementKey: "key2" };
  const parts = [requirement, second].map((r, i) => ({ partId: `part-${i}`, identityRefId: uuid(i + 1), requirementKey: r.requirementKey,
    id: r.id, revision: r.revision, stableSkillId: r.stableSkillId, nodeId: r.knowledgeNodeId,
    outcome: i === 0 ? "incorrect" as const : "correct" as const, assistance: "independent" as const, identityCurrent: true }));
  const projectParts = (overrides: Partial<ExamCourseEvidenceLink> = {}, reqs = [requirement, second]) =>
    projectExamCourseEvidence([observation], roots, reqs, [{ ...link, parts, ...overrides }]);
  it("replaces rather than double counts whole-question evidence, preserving original facts", () => {
    const projected = projectParts();
    expect(projected.map(p => [p.courseRequirement?.id, p.verifiedCorrect])).toEqual([["r", "no"], ["r2", "yes"]]);
    expect(projected.every(p => p.id === observation.id)).toBe(true);
    expect(observation.verifiedCorrect).toBe("yes");
    expect(projectParts({ parts: [...parts].reverse() }).map(p => p.courseRequirement?.id)).toEqual(["r2", "r"]);
  });
  it("keeps missing/assisted results orthogonal to sibling correctness", () => {
    const projected = projectParts({ parts: [{ ...parts[0]!, outcome: "unknown", assistance: "unknown" }, { ...parts[1]!, assistance: "revealed" }] });
    expect(projected[0]).toMatchObject({ verifiedCorrect: "unknown", independentAttempt: "no" });
    expect(projected[1]).toMatchObject({ verifiedCorrect: "yes", assistance: "revealed", independentAttempt: "no" });
  });
  it("does not project a changed key/revision/node, unavailable root, or absent part results", () => {
    expect(projectParts({ parts: [] })).toEqual([]);
    expect(projectParts({ identityCurrent: false })).toEqual([]);
    expect(projectParts({}, [{ ...requirement, requirementKey: "changed" }, { ...second, revision: 3 }])).toEqual([]);
    expect(projectParts({ parts: parts.map(p => ({ ...p, identityCurrent: false })) })).toEqual([]);
  });
  it("persists declared refs losslessly, leaves legacy shape untouched and rejects foreign/duplicate refs", () => {
    const pack = structuredClone(EXAM_SPRINT_PACK), state = createExamSprintState("2026-11-08T12:00:00.000Z");
    expect(parseExamSprintSnapshot(pack, state)).toEqual({ pack, state });
    const q = pack.questions[0]!;
    q.partSnapshot = { packId: pack.id, packVersion: pack.version, questionId: q.id, familyId: q.familyId,
      questionIdentityRefId: uuid(10), parts: parts.map(p => ({ partId: p.partId, identityRefId: p.identityRefId, requirementKey: p.requirementKey })) };
    expect(parseExamSprintSnapshot(JSON.parse(JSON.stringify(pack)), state).pack).toEqual(pack);
    for (const invalid of [
      { ...q.partSnapshot, packVersion: "foreign" }, { ...q.partSnapshot, questionId: "foreign" },
      { ...q.partSnapshot, parts: [q.partSnapshot.parts[0]!, q.partSnapshot.parts[0]!] },
      { ...q.partSnapshot, parts: [q.partSnapshot.parts[0]!, { ...q.partSnapshot.parts[1]!, identityRefId: q.partSnapshot.parts[0]!.identityRefId }] },
    ]) {
      const bad = structuredClone(pack); bad.questions[0]!.partSnapshot = invalid;
      expect(() => parseExamSprintSnapshot(bad, state)).toThrow("无法校验");
    }
  });
});

describe("course exam evidence projection", () => {
  it("binds current requirement identity and key without changing the source", () => {
    expect(project()).toEqual({ ...observation, requirementKey: requirement.requirementKey, courseRequirement: { id: "r", revision: 2, stableSkillId: "skill", requirementKey: "knowledge:node" } });
    expect(observation.requirementKey).toBe("exam-skill:node");
  });
  it("does not match by title or skill name", () => expect(project([{ ...requirement, knowledgeNodeId: "other" }])).toBe(observation));
  it.each(["2026-11-06T11:59:59Z", "2026-11-06T12:00:00Z", null])("rejects capture time %s at or before approval or absent", time => expect(project([requirement], [{ ...link, capturedAt: time }])).toBe(observation));
  it("rejects missing approval", () => expect(project([{ ...requirement, approvedAt: null }])).toBe(observation));
  it("rejects a binding or current node that is no longer valid", () => expect(project([requirement], [{ ...link, identityCurrent: false }])).toBe(observation));
  it("rejects ambiguous active requirements", () => expect(project([requirement, { ...requirement, id: "other" }])).toBe(observation));
  it("preserves an existing course binding or shared evidence", () => {
    const bound = { ...observation, courseRequirement: { id: "old", revision: 1, stableSkillId: "old", requirementKey: "old" } };
    const shared = { ...observation, sharedFor: [] };
    expect(project([requirement], [link], bound)).toBe(bound);
    expect(project([requirement], [link], shared)).toBe(shared);
  });
  it("does not project unmatched roots or invalid timestamps", () => {
    expect(project([requirement], [{ ...link, observationId: "other" }])).toBe(observation);
    expect(project([requirement], [{ ...link, capturedAt: "invalid" }])).toBe(observation);
    expect(project([{ ...requirement, approvedAt: "invalid" }])).toBe(observation);
  });
  it("leaves empty inputs, absent links and archived requirements unbound", () => {
    expect(projectExamCourseEvidence([], roots, [requirement], [link])).toEqual([]);
    expect(project([])).toBe(observation);
    expect(project([requirement], [])).toBe(observation);
    expect(project([{ ...requirement, lifecycle: "archived" }])).toBe(observation);
  });
  it("uses the current revision only for captures after that revision's approval", () => {
    const revised = { ...requirement, revision: 3, approvedAt: "2026-11-06T12:02:00Z" };
    expect(project([revised])).toBe(observation);
    expect(project([revised], [{ ...link, capturedAt: "2026-11-06T12:03:00Z" }]).courseRequirement?.revision).toBe(3);
  });
  it("supports an original observation without a revision-root entry", () => {
    const original = { ...observation, id: link.observationId };
    expect(projectExamCourseEvidence([original], new Map(), [requirement], [link])[0]?.courseRequirement?.id).toBe(requirement.id);
  });
  it.each([
    { verifiedCorrect: "unknown" as const }, // Includes AI feedback and learner self-grading: not strong proof.
    { verifiedCorrect: "no" as const },
    { independentAttempt: "no" as const },
    { assistance: "hinted" as const },
    { usableForCurrentVersion: "no" as const },
    { firstQuestionExposure: false },
  ])("does not upgrade weak or ineligible evidence: %j", changes => {
    const withSources = { ...requirement, sourceRefs: [{ sourceId: "source", sourceVersion: 1 }] };
    const inputs = ["one", "two"].map(id => ({ ...observation, id, questionIdentity: id, firstQuestionExposure: true, ...changes }));
    const projected = projectExamCourseEvidence(inputs, new Map(), [withSources], inputs.map(row => ({ ...link, observationId: row.id })));
    expect(projected).toEqual(inputs.map(row => ({ ...row, requirementKey: requirement.requirementKey, courseRequirement: {
      id: requirement.id, revision: requirement.revision, stableSkillId: requirement.stableSkillId, requirementKey: requirement.requirementKey,
    } })));
    expect(courseRequirementProgress([withSources], projected, new Map([["source", 1]]))[0]?.status).not.toBe("verified");
  });
});
