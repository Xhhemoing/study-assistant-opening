import { describe, expect, it } from "vitest";
import type { CourseRequirement } from "@aistudy/contracts";
import { courseRequirementProgress, type CourseRouteObservation } from "@aistudy/domain";
import { projectExamCourseEvidence, type ExamCourseEvidenceLink } from "./opening-course-exam-evidence-projection";

const requirement: CourseRequirement = { id: "r", courseId: "c", stableSkillId: "skill", knowledgeNodeId: "node", requirementKey: "knowledge:node", title: "same", position: 0, mandatory: true, goalIds: [], prerequisiteIds: [], sourceRefs: [], verification: { kind: "exact", status: "ready", exerciseKeys: [], rubric: null, missingReasons: [] }, revision: 2, lifecycle: "active", origin: "confirmed", approvedAt: "2026-11-06T12:00:00Z" };
const observation: CourseRouteObservation = { id: "head", skillLabel: "same", requirementKey: "exam-skill:node", attemptedAt: "2026-11-06T12:01:00Z", assistance: "independent", verifiedCorrect: "yes", independentAttempt: "yes", usableForCurrentVersion: "yes", problemId: "p", itemVersionId: "i" };
const link: ExamCourseEvidenceLink = { observationId: "root", nodeId: "node", requirementKey: "exam-skill:node", capturedAt: "2026-11-06T12:01:00Z", identityCurrent: true };
const roots = new Map([["head", "root"]]);
const project = (r: CourseRequirement[] = [requirement], l: ExamCourseEvidenceLink[] = [link], o: CourseRouteObservation = observation) => projectExamCourseEvidence([o], roots, r, l)[0]!;

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
