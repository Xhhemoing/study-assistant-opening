import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ExamBindInput, ExamPack, ExamSprintCommand, ExamSprintOverview, ObservationInput } from "@aistudy/contracts";
import { evaluateEvidenceEligibility } from "@aistudy/domain";
import { createOpeningExamIntegrationRepository } from "../../packages/database/src/repositories/opening-exam-integration";
import { createOpeningExamSprintRepository } from "../../packages/database/src/repositories/opening-exam-sprint";
import { createOpeningLearningAttemptRepository } from "../../packages/database/src/repositories/opening-learning-attempts";
import { insertOpeningLearningObservation, insertOpeningLearningObservationInTx } from "../../packages/database/src/repositories/opening-learning-observations";
import { mapLearningObservation } from "../../packages/database/src/repositories/opening-learning-facts";
import { readOpeningLearningEvidenceContext } from "../../packages/database/src/repositories/opening-learning-evidence-context";
import { reviseOpeningLearningObservation } from "../../packages/database/src/repositories/opening-observation-revisions";
import { createOpeningPrivacyRepository } from "../../packages/database/src/repositories/opening-privacy";
import { createOpeningKnowledgeRepository } from "../../packages/database/src/repositories/opening-knowledge";
import { readOpeningCourseLearningSummary } from "../../packages/database/src/repositories/opening-learning-summary-read";
import { createOpeningSkillEvidenceRepository, linkOpeningSkillEvidenceInTx } from "../../packages/database/src/repositories/opening-skill-evidence";
import { createBuildCourseKnowledgeHandler } from "../../apps/worker/src/jobs/build-course-knowledge";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { closeRace, openRaceSession, track, waitUntilBlocked } from "./opening-race-helpers";

const pack: ExamPack = {
  id: "canonical-exam-fixture", version: "1", title: "Limits sprint", description: "Public review",
  topics: [{ id: "limits", title: "Limits" }],
  lessons: [{ id: "lesson", topicId: "limits", title: "Limit laws", summary: "Public summary", steps: ["Check conditions"],
    workedExample: "Public example", pitfalls: ["Check the domain"] }],
  questions: ["training-1", "training-2", "mock-a-1", "mock-b-1"].map((id, index) => ({
    id, topicId: "limits", skillId: "limit-laws", lessonId: "lesson", familyId: index < 2 ? "shared-training-family" : `family-${index}`,
    pool: index < 2 ? "training" : index === 2 ? "mock-a" : "mock-b", difficulty: "foundation", prompt: `Question ${index}`,
    options: [{ id: "a", label: "First" }, { id: "b", label: "Second" }], answer: "a",
    explanation: `SEALED-EXPLANATION-${index}`, hint: `DELIVERED-HINT-${index}`, estimatedMinutes: 5,
  })),
  sourceItems: [{ id: "paper-1", topicId: "limits", label: "Paper exercise", sourceTitle: "Worksheet.pdf", sourcePage: 3,
    kind: "exercise", suggestedDay: 1, skills: ["limit-laws"] }], weekPlan: [], limitations: ["Fixture only"],
};
let f: OpeningFixture;
let courseId: string;
let sprint: ReturnType<typeof createOpeningExamSprintRepository>;
let integration: ReturnType<typeof createOpeningExamIntegrationRepository>;
const key = () => `integration:${randomUUID()}`;
const iso = (value: unknown) => new Date(value as string | Date).toISOString();

beforeAll(async () => {
  f = await createOpeningFixture();
  sprint = createOpeningExamSprintRepository(f.sql, pack);
  integration = createOpeningExamIntegrationRepository(f.sql, pack);
});
beforeEach(async () => {
  await f.sql`TRUNCATE opening_exam_sprints CASCADE`;
  courseId = randomUUID();
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'Canonical exam',${courseId})`;
});
afterAll(async () => { await f?.close(); });

function bindInput(overrides: Partial<ExamBindInput> = {}): ExamBindInput {
  return { clientKey: key(), courseId, milestoneId: null, expectedPackVersion: pack.version,
    createKnowledgeNodes: true, skills: [], materials: [], ...overrides };
}
const bind = () => integration.bind(f.scope, bindInput());
const start = (mode: "diagnostic" | "practice" | "mock-a" | "mock-b" = "diagnostic") => sprint.act(f.scope, { action: "start", mode, clientKey: key() });
function answer(view: ExamSprintOverview, clientKey = key()) {
  return sprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id, answer: "a", confidence: 4, clientKey });
}
const finish = (view: ExamSprintOverview) => sprint.act(f.scope, { action: "finish", runId: view.activeRun!.id, clientKey: key() });
async function factsCount() {
  const [row] = await f.sql`SELECT
    (SELECT count(*)::int FROM opening_learning_sessions WHERE course_id=${courseId}) AS sessions,
    (SELECT count(*)::int FROM opening_learning_attempts WHERE course_id=${courseId}) AS attempts,
    (SELECT count(*)::int FROM opening_learning_observations WHERE course_id=${courseId}) AS observations,
    (SELECT count(*)::int FROM opening_skill_evidence WHERE course_id=${courseId}) AS evidence`;
  return row;
}
async function linkFor(examAttemptId: string) {
  const [row] = await f.sql`SELECT l.*,a.session_id,a.course_id,a.activity_id,a.skill_label,a.problem_id,a.source_ids,a.source_versions
    FROM opening_exam_attempt_links l JOIN opening_learning_attempts a ON a.id=l.learning_attempt_id
    WHERE l.exam_attempt_id=${examAttemptId} AND a.workspace_id=${f.scope.workspaceId} AND a.course_id=${courseId}`;
  if (!row) throw new Error("Expected a captured canonical attempt");
  return row;
}
async function observation(id: string) {
  const [row] = await f.sql`SELECT * FROM opening_learning_observations WHERE id=${id} AND workspace_id=${f.scope.workspaceId}`;
  if (!row) throw new Error("Expected a canonical observation");
  return row;
}
async function eligibility(id: string) {
  const record = mapLearningObservation(await observation(id));
  const facts = await readOpeningLearningEvidenceContext(f.sql, f.scope, record);
  return evaluateEvidenceEligibility(facts.observation, facts.context);
}
const summary = () => readOpeningCourseLearningSummary(f.sql, f.scope, { courseId, limit: 10 });
function ordinaryObservation(link: Awaited<ReturnType<typeof linkFor>>): ObservationInput {
  return { sessionId: String(link.session_id), courseId, skillLabel: String(link.skill_label), sourceIds: link.source_ids as string[],
    attemptId: String(link.learning_attempt_id), problemId: String(link.problem_id), answer: "a", outcome: "correct",
    assistance: "independent", clientKey: key() };
}
async function source(options: { image?: boolean; version?: number; history?: boolean } = {}) {
  const id = randomUUID(), version = options.version ?? 1;
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${id},${f.scope.workspaceId},${options.image ? "My-work.png" : "Worksheet.pdf"},${options.image ? "image/png" : "application/pdf"},12,
      ${"a".repeat(64)},${version},'uploaded','ready')`;
  for (const v of options.history ? [version - 1, version] : [version]) {
    await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      VALUES(${id},${v},${f.scope.workspaceId},12,${"a".repeat(64)},'available')`;
    await f.sql`INSERT INTO opening_source_chunks(source_id,source_version,page,text,image_object_key)
      VALUES(${id},${v},3,${options.image ? "" : `Reference body version ${v}`},${options.image ? `opening/sources/${id}/v${v}/work.png` : null})`;
  }
  return { sourceTitle: "Worksheet.pdf", sourceId: id, sourceVersion: version };
}

describe("course-bound exam sprint canonical bridge", () => {
  it("serializes concurrent bind replay into one source and graph, and rejects conflicting same-key intent", async () => {
    const originals: Array<{ sourceId: string; body: Uint8Array }> = [];
    const withStorage = createOpeningExamIntegrationRepository(f.sql, pack, {
      writePublicSource: async source => { originals.push(source); },
    });
    expect((await withStorage.read(f.scope)).binding).toBeNull();
    const input = bindInput();
    const [first, second] = await Promise.all([withStorage.bind(f.scope, input), withStorage.bind(f.scope, input)]);
    expect(first.binding).toEqual(second.binding);
    expect(originals).toHaveLength(1);
    expect(originals[0]?.sourceId).toBe(first.binding?.packSourceId);
    expect(Buffer.from(originals[0]!.body).toString("utf8")).not.toContain("SEALED-EXPLANATION");
    expect(first.binding?.skills).toHaveLength(1);
    expect(await factsCount()).toEqual({ sessions: 0, attempts: 0, observations: 0, evidence: 0 });
    const [graph] = await f.sql`SELECT version,snapshot FROM opening_course_knowledge WHERE course_id=${courseId}`;
    expect(graph?.version).toBe(1);
    expect((graph?.snapshot as { nodes: unknown[] }).nodes).toHaveLength(1);
    expect(await f.sql`SELECT asset_id FROM course_asset_memberships WHERE course_id=${courseId} AND asset_type='source'`).toHaveLength(1);
    expect(await f.sql`SELECT id FROM opening_exam_integration_commands`).toHaveLength(1);
    await expect(withStorage.bind(f.scope, { ...input, createKnowledgeNodes: false })).rejects.toMatchObject({ code: "CONFLICT" });
    const refreshed = await withStorage.bind(f.scope, bindInput());
    expect(refreshed.binding).toEqual(first.binding);
    expect(originals).toHaveLength(1);
  });

  it("rolls back the binding transaction when writing the public original fails", async () => {
    const before = await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`;
    const unavailable = createOpeningExamIntegrationRepository(f.sql, pack, {
      writePublicSource: async () => { throw new Error("Object write failed"); },
    });
    await expect(unavailable.bind(f.scope, bindInput())).rejects.toThrow("Object write failed");
    expect(await f.sql`SELECT id FROM opening_sources WHERE workspace_id=${f.scope.workspaceId}`).toEqual(before);
    expect(await f.sql`SELECT id FROM opening_exam_sprints WHERE workspace_id=${f.scope.workspaceId}`).toHaveLength(0);
    expect(await f.sql`SELECT id FROM course_asset_memberships WHERE course_id=${courseId}`).toHaveLength(0);
    expect(await f.sql`SELECT course_id FROM opening_course_knowledge WHERE course_id=${courseId}`).toHaveLength(0);
    expect(await f.sql`SELECT id FROM opening_exam_integration_commands`).toHaveLength(0);
  });

  it("captures exactly one session and attempt on presentation, then one root observation and skill evidence under concurrent answer replay", async () => {
    const bound = await bind(), view = await start();
    const before = await linkFor(view.currentAttempt!.id);
    expect(before).toMatchObject({ publication: "pending_answer", observation_id: null, submitted_answer: null, captured_at: null });
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 0, evidence: 0 });
    const created = await createOpeningLearningAttemptRepository(f.sql).get(f.scope, String(before.learning_attempt_id));
    expect(created).toMatchObject({ startedAt: view.currentAttempt!.presentedAt, submittedAt: null, observationId: null,
      sourceVersions: { [bound.binding!.packSourceId]: 0 } });
    const clientKey = key();
    const [left, right] = await Promise.all([answer(view, clientKey), answer(view, clientKey)]);
    expect(left.attempts).toEqual(right.attempts);
    await expect(answer(view)).rejects.toMatchObject({ code: "CONFLICT" });
    const link = await linkFor(view.currentAttempt!.id), saved = await observation(String(link.observation_id));
    expect(link.publication).toBe("published");
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 1, evidence: 1 });
    expect(saved).toMatchObject({ revision_kind: "original", root_observation_id: saved.id, effective_head_id: saved.id,
      verdict_source: "deterministic", outcome: "correct", requirement_key: bound.binding!.skills[0]!.requirementKey });
    expect(iso(saved.submitted_at)).toBe(left.attempts[0]!.answeredAt);
    expect(await eligibility(String(saved.id))).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "yes", usableForCurrentVersion: "yes" });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
  });

  it("preserves the captured answer as unavailable after explicit deletion of its skill identity", async () => {
    await bind();
    const view = await start(), link = await linkFor(view.currentAttempt!.id);
    const receiptsBefore = await f.sql`SELECT c.id FROM opening_exam_sprint_commands c JOIN opening_exam_sprints s ON s.id=c.sprint_id
      WHERE s.workspace_id=${f.scope.workspaceId} ORDER BY c.id`;
    // A deliberate graph edit may retire a node, unlike a model rebuild omission.
    await f.sql`UPDATE opening_course_knowledge SET snapshot=jsonb_set(snapshot,'{nodes}','[]'::jsonb)
      WHERE workspace_id=${f.scope.workspaceId} AND course_id=${courseId}`;
    await answer(view);
    expect(await linkFor(view.currentAttempt!.id)).toMatchObject({ publication: "pending_answer",
      submitted_answer: "a", observation_id: null });
    expect((await linkFor(view.currentAttempt!.id)).captured_at).not.toBeNull();
    expect(await createOpeningLearningAttemptRepository(f.sql).get(f.scope, String(link.learning_attempt_id)))
      .toMatchObject({ submittedAt: null, observationId: null });
    expect((await sprint.read(f.scope)).currentAttempt).toMatchObject({ answer: "a", correct: true, independent: false });
    expect((await integration.read(f.scope)).links[0]?.publication).toBe("unavailable");
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 0, evidence: 0 });
    expect(await f.sql`SELECT c.id FROM opening_exam_sprint_commands c JOIN opening_exam_sprints s ON s.id=c.sprint_id
      WHERE s.workspace_id=${f.scope.workspaceId} ORDER BY c.id`).toHaveLength(receiptsBefore.length + 1);
  });

  it("continues a captured course-bound attempt after a rebuild that omits its original node", async () => {
    const bound = await bind(), view = await start(), skill = bound.binding!.skills[0]!;
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    const before = await knowledge.get(f.scope, courseId);
    const rebuild = createBuildCourseKnowledgeHandler({
      get: (scope, id) => knowledge.get(scope, id),
      listAuthorizedChunks: (scope, id) => knowledge.listAuthorizedChunks(scope, id),
      listReferencedNodeIds: (scope, id) => knowledge.listReferencedNodeIds(scope, id),
      replace: (scope, id, input) => knowledge.replace(scope, id, input),
      extractGraph: async () => ({ nodes: [], edges: [] }),
    });
    await rebuild({ id: randomUUID(), ...f.scope, key: key(), kind: "build-course-knowledge", payload: { courseId },
      result: null, state: "running", privacyEpoch: 0 }, { courseId });
    const after = await knowledge.get(f.scope, courseId);
    expect(after!.version).toBe(before!.version + 1);
    expect(after!.snapshot.nodes.find(node => node.id === skill.nodeId)).toEqual(before!.snapshot.nodes.find(node => node.id === skill.nodeId));
    await answer(view);
    const link = await linkFor(view.currentAttempt!.id);
    expect(link).toMatchObject({ node_id: skill.nodeId, requirement_key: skill.requirementKey, publication: "published" });
    expect(await observation(String(link.observation_id))).toMatchObject({ requirement_key: skill.requirementKey });
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 1, evidence: 1 });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
  });

  it("explicitly remaps a deleted/split skill to a new requirement without moving old evidence or BKT history", async () => {
    const bound = await bind(), view = await start(), oldSkill = bound.binding!.skills[0]!;
    await answer(view); await finish(view);
    const oldLink = await linkFor(view.currentAttempt!.id);
    expect((await summary()).groups[0]).toMatchObject({ independentVerifiedCurrentCount: 1 });
    const knowledge = createOpeningKnowledgeRepository(f.sql), graph = (await knowledge.get(f.scope, courseId))!;
    const replacementId = randomUUID();
    await knowledge.replace(f.scope, courseId, { expectedVersion: graph.version, sourceVersions: graph.sourceVersions,
      snapshot: { ...graph.snapshot, nodes: graph.snapshot.nodes.map(node => ({ ...node, id: replacementId })), edges: [] } });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
    expect((await sprint.read(f.scope)).skills[0]?.status).toBe("untested");
    expect(await eligibility(String(oldLink.observation_id))).toMatchObject({ usableForCurrentVersion: "no" });
    const retired = await summary();
    expect(retired.status).toBe("ready");
    expect(retired.groups[0]).toMatchObject({ identity: { requirementKey: oldSkill.requirementKey }, sampleCount: 1,
      independentVerifiedCurrentCount: 0, applicabilityCounts: { unavailable: 1 } });
    // Removing a referenced UUID does not free it for a different definition.
    // Otherwise its old requirement and BKT history could silently revive.
    await expect(knowledge.replace(f.scope, courseId, { expectedVersion: graph.version + 1, sourceVersions: graph.sourceVersions,
      snapshot: { ...graph.snapshot, nodes: graph.snapshot.nodes.map(node => ({ ...node, label: "A different meaning under the retired UUID" })), edges: [] } }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const updated = await integration.bind(f.scope, bindInput({ skills: [{ skillId: oldSkill.skillId, nodeId: replacementId }] }));
    expect(updated.binding!.skills[0]).toEqual({ skillId: oldSkill.skillId, nodeId: replacementId, requirementKey: `exam-skill:${replacementId}` });
    expect(await observation(String(oldLink.observation_id))).toMatchObject({ requirement_key: oldSkill.requirementKey });
    expect(await linkFor(view.currentAttempt!.id)).toMatchObject({ node_id: oldSkill.nodeId, requirement_key: oldSkill.requirementKey });
    const next = await start("mock-a"); await answer(next); await finish(next);
    expect(await linkFor(next.currentAttempt!.id)).toMatchObject({ node_id: replacementId, requirement_key: `exam-skill:${replacementId}`, publication: "published" });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
    const current = await summary();
    expect(current.groups.find(group => group.identity.requirementKey === oldSkill.requirementKey))
      .toMatchObject({ sampleCount: 1, independentVerifiedCurrentCount: 0 });
    expect(current.groups.find(group => group.identity.requirementKey === `exam-skill:${replacementId}`))
      .toMatchObject({ sampleCount: 1, independentVerifiedCurrentCount: 1 });
  });

  it.each(["privacy", "version", "delete", "membership", "suggested"])("invalidates an external skill basis without rebuilding the graph: %s", async change => {
    const material = await source(), nodeId = randomUUID();
    const [chunk] = await f.sql`SELECT id FROM opening_source_chunks WHERE source_id=${material.sourceId}`;
    await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
      VALUES(${f.scope.workspaceId},${courseId},'source',${material.sourceId},'reference','private')`;
    const knowledge = createOpeningKnowledgeRepository(f.sql);
    await knowledge.replace(f.scope, courseId, { expectedVersion: 0, sourceVersions: { [material.sourceId]: 1 },
      snapshot: { courseId, version: 1, nodes: [{ id: nodeId, courseId, label: "Limit laws", kind: "problem_type",
        status: "supported", evidenceChunkIds: [String(chunk!.id)] }], edges: [] } });
    await integration.bind(f.scope, bindInput({ createKnowledgeNodes: false, skills: [{ skillId: "limit-laws", nodeId }] }));
    const view = await start(); await answer(view); await finish(view);
    const oldLink = await linkFor(view.currentAttempt!.id);
    expect((await summary()).groups[0]?.independentVerifiedCurrentCount).toBe(1);
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
    const skillEvidence = createOpeningSkillEvidenceRepository(f.sql);
    expect((await skillEvidence.flagsForNode(f.scope, nodeId)).hasCheckedIndependent).toBe(true);
    // The captured exam question uses the public pack source, not this external material.
    expect((await observation(String(oldLink.observation_id))).source_ids).not.toContain(material.sourceId);
    if (change === "privacy") await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id)
      VALUES(${f.scope.workspaceId},${material.sourceId})`;
    if (change === "version") await f.sql`UPDATE opening_sources SET version=2 WHERE id=${material.sourceId}`;
    if (change === "delete") await f.sql`DELETE FROM opening_sources WHERE id=${material.sourceId}`;
    if (change === "membership") await f.sql`DELETE FROM course_asset_memberships WHERE course_id=${courseId} AND asset_id=${material.sourceId}`;
    if (change === "suggested") await f.sql`UPDATE opening_course_knowledge SET snapshot=jsonb_set(snapshot,'{nodes,0,status}','"suggested"'::jsonb)
      WHERE workspace_id=${f.scope.workspaceId} AND course_id=${courseId}`;
    // No summary repair/invalidation has touched the cached yes projection yet.
    expect((await f.sql`SELECT usable_for_current_version FROM opening_learning_eligibility WHERE root_observation_id=${String(oldLink.observation_id)}`)[0])
      .toMatchObject({ usable_for_current_version: "yes" });
    expect(await skillEvidence.flagsForNode(f.scope, nodeId)).toEqual({ nodeId, hasCheckedIndependent: false, hasAssistance: false, evidenceIds: [] });
    expect((await knowledge.get(f.scope, courseId))!.snapshot.nodes[0]!.id).toBe(nodeId);
    expect(await eligibility(String(oldLink.observation_id))).toMatchObject({ usableForCurrentVersion: "no",
      reasonCodes: expect.arrayContaining(["version_unavailable"]) });
    const page = await summary();
    expect(page.status).toBe("ready");
    expect(page.groups[0]).toMatchObject({ sampleCount: 1, independentVerifiedCurrentCount: 0,
      representatives: [expect.objectContaining({ versionApplicability: "unavailable", eligibility: expect.objectContaining({ usableForCurrentVersion: "no" }) })] });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
    const next = await start("mock-a"); await answer(next); await finish(next);
    expect(await linkFor(next.currentAttempt!.id)).toMatchObject({ submitted_answer: "a", observation_id: null });
    expect((await integration.read(f.scope)).links.find(link => link.examAttemptId === next.currentAttempt!.id)?.publication).toBe("unavailable");
    expect((await factsCount())?.observations).toBe(1);
    if (change === "suggested") {
      const graph = (await knowledge.get(f.scope, courseId))!, replacementId = randomUUID();
      await knowledge.replace(f.scope, courseId, { expectedVersion: graph.version, sourceVersions: graph.sourceVersions,
        snapshot: { ...graph.snapshot, nodes: [...graph.snapshot.nodes, { ...graph.snapshot.nodes[0]!, id: replacementId, status: "supported" }] } });
      const remapped = await integration.bind(f.scope, bindInput({ skills: [{ skillId: "limit-laws", nodeId: replacementId }] }));
      expect(remapped.binding!.skills[0]!.requirementKey).toBe(`exam-skill:${replacementId}`);
      expect((await knowledge.get(f.scope, courseId))!.snapshot.nodes.some(node => node.id === nodeId)).toBe(true);
      const recovered = await start("mock-b"); await answer(recovered); await finish(recovered);
      expect(await linkFor(recovered.currentAttempt!.id)).toMatchObject({ node_id: replacementId, publication: "published" });
      expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
      expect(await eligibility(String(oldLink.observation_id))).toMatchObject({ usableForCurrentVersion: "no" });
    }
  });

  it("rejects an automatic rebuild after a competing locked writer adds a reference to an omitted node", async () => {
    await bind(); const view = await start(); await answer(view);
    const link = await linkFor(view.currentAttempt!.id), knowledge = createOpeningKnowledgeRepository(f.sql);
    const graph = (await knowledge.get(f.scope, courseId))!, extraId = randomUUID();
    const withExtra = await knowledge.replace(f.scope, courseId, { expectedVersion: graph.version, sourceVersions: graph.sourceVersions,
      snapshot: { ...graph.snapshot, nodes: [...graph.snapshot.nodes, { ...graph.snapshot.nodes[0]!, id: extraId, label: "Another explicit skill" }] } });
    const captured = await knowledge.listReferencedNodeIds(f.scope, courseId);
    expect(captured).not.toContain(extraId);
    const holder = await openRaceSession().ready, rebuilding = await openRaceSession().ready;
    let release = () => undefined as void, opened = () => undefined as void;
    const gate = new Promise<void>(resolve => { opened = resolve; });
    const unlocked = new Promise<void>(resolve => { release = resolve; });
    const writer = track(holder.sql.begin(async tx => {
      await linkOpeningSkillEvidenceInTx(tx, f.scope, { courseId, nodeId: extraId, observationId: String(link.observation_id), dimension: "procedure" });
      opened(); await unlocked;
    }));
    let pending: ReturnType<typeof knowledge.replace> | undefined;
    try {
      await Promise.race([gate, writer]);
      pending = track(createOpeningKnowledgeRepository(rebuilding.sql).replace(f.scope, courseId, {
        expectedVersion: withExtra.version, expectedReferencedNodeIds: captured, sourceVersions: withExtra.sourceVersions,
        snapshot: { ...withExtra.snapshot, nodes: withExtra.snapshot.nodes.filter(node => node.id !== extraId) },
      }));
      await waitUntilBlocked(f.sql, rebuilding.pid, holder.pid, "knowledge rebuild after new reference", /FROM workspaces[\s\S]*FOR UPDATE/);
      release(); await writer;
      await expect(pending).rejects.toMatchObject({ code: "CONFLICT" });
      expect((await knowledge.get(f.scope, courseId))!.snapshot.nodes.some(node => node.id === extraId)).toBe(true);
    } finally {
      release(); await Promise.allSettled([writer, ...(pending ? [pending] : [])]);
      await closeRace(rebuilding.sql); await closeRace(holder.sql);
    }
  }, 15_000);

  it("rejects independent sprint configuration after binding and presents the next question after completing the prior activity", async () => {
    await bind();
    const before = await sprint.read(f.scope);
    await expect(sprint.act(f.scope, { action: "configure", clientKey: key(), examDate: "2026-11-01", dailyMinutes: 60 }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await sprint.read(f.scope)).state).toEqual(before.state);
    const first = await start("practice"), firstLink = await linkFor(first.currentAttempt!.id);
    await answer(first);
    expect((await f.sql`SELECT status FROM opening_teaching_activities WHERE id=${String(firstLink.activity_id)}`)[0]?.status).toBe("completed");
    const next = await sprint.act(f.scope, { action: "next", clientKey: key(), runId: first.activeRun!.id });
    expect(next.currentAttempt!.id).not.toBe(first.currentAttempt!.id);
    const nextLink = await linkFor(next.currentAttempt!.id);
    expect(nextLink.activity_id).not.toBe(firstLink.activity_id);
    expect(nextLink.session_id).not.toBe(firstLink.session_id);
    expect((await f.sql`SELECT status FROM opening_teaching_activities WHERE id=${String(nextLink.activity_id)}`)[0]?.status).toBe("active");
    expect(await factsCount()).toEqual({ sessions: 2, attempts: 2, observations: 1, evidence: 1 });
    await answer(next);
    expect(await factsCount()).toEqual({ sessions: 2, attempts: 2, observations: 2, evidence: 2 });
  });

  it("seals captured mock answers from course facts and generic submit paths until hand-in, preserving captured submission time", async () => {
    await bind();
    const view = await start("mock-a"), submitted = await answer(view), link = await linkFor(view.currentAttempt!.id);
    expect(link).toMatchObject({ publication: "pending_mock", observation_id: null, submitted_answer: "a" });
    expect(iso(link.captured_at)).toBe(submitted.attempts[0]!.answeredAt);
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 0, evidence: 0 });
    for (const result of [submitted, await sprint.read(f.scope), await sprint.export(f.scope)]) {
      expect(result.attempts[0]).toMatchObject({ correct: null, feedback: null, hint: null, independent: false });
      expect(result.attempts[0]).not.toHaveProperty("prediction");
      expect(JSON.stringify(result)).not.toContain("SEALED-EXPLANATION");
    }
    const generic = createOpeningLearningAttemptRepository(f.sql);
    expect(await generic.get(f.scope, String(link.learning_attempt_id))).toMatchObject({ submittedAt: null, observationId: null });
    expect((await generic.listByActivity(f.scope, String(link.activity_id)))[0]).toMatchObject({ outcome: null, assistance: null });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
    await expect(insertOpeningLearningObservation(f.sql, f.scope, ordinaryObservation(link))).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(f.sql.begin(tx => insertOpeningLearningObservationInTx(tx, f.scope, ordinaryObservation(link))))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await expect(insertOpeningLearningObservation(f.sql, f.scope, ordinaryObservation(link), { examSprintPublication: true }))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await factsCount())?.observations).toBe(0);
    const finished = await finish(submitted), published = await linkFor(view.currentAttempt!.id), saved = await observation(String(published.observation_id));
    expect(published.publication).toBe("published");
    expect(iso(saved.submitted_at)).toBe(iso(link.captured_at));
    expect(Date.parse(iso(saved.recorded_at))).toBeGreaterThanOrEqual(Date.parse(finished.state.runs[0]!.completedAt!));
    expect(finished.attempts[0]).toMatchObject({ correct: true, feedback: { answer: "a" } });
    expect(await f.sql`SELECT dimension FROM opening_skill_evidence WHERE observation_id=${String(saved.id)}`).toEqual([{ dimension: "timed" }]);
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
  });

  it.each(["privacy", "version", "deleted"] as const)("completes mock hand-in with unavailable evidence after source %s", async reason => {
    const bound = await bind(), view = await start("mock-a"), submitted = await answer(view);
    const original = await linkFor(view.currentAttempt!.id), sourceId = bound.binding!.packSourceId;
    expect(original).toMatchObject({ publication: "pending_mock", observation_id: null, submitted_answer: "a" });
    const capturedAt = iso(original.captured_at);
    if (reason === "privacy") {
      await createOpeningPrivacyRepository(f.sql).recordExclusions(f.sql, f.scope, {
        sourceIds: [sourceId], memoryId: randomUUID(), deletedAt: new Date(),
      });
    } else if (reason === "version") {
      await f.sql`UPDATE opening_sources SET version=version+1 WHERE id=${sourceId} AND workspace_id=${f.scope.workspaceId}`;
    } else {
      // Chunks cascade; captured item versions and binding identities retain the deleted source id.
      await f.sql`DELETE FROM opening_sources WHERE id=${sourceId} AND workspace_id=${f.scope.workspaceId}`;
    }
    const command = { action: "finish" as const, clientKey: key(), runId: submitted.activeRun!.id };
    const finished = await sprint.act(f.scope, command);
    expect(finished.activeRun).toBeNull();
    expect(finished.state.runs[0]!.completedAt).not.toBeNull();
    expect(finished.attempts[0]).toMatchObject({ answer: "a", answeredAt: capturedAt });
    expect(finished.skills[0]?.status).toBe("untested");
    const retained = await linkFor(view.currentAttempt!.id);
    expect(retained).toMatchObject({ publication: "pending_mock", observation_id: null, submitted_answer: "a" });
    expect(iso(retained.captured_at)).toBe(capturedAt);
    expect(await createOpeningLearningAttemptRepository(f.sql).get(f.scope, String(retained.learning_attempt_id)))
      .toMatchObject({ submittedAt: null, observationId: null });
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 0, evidence: 0 });
    const integrated = await integration.read(f.scope);
    expect(integrated.links[0]).toMatchObject({ publication: "unavailable", observationId: null });
    expect(integrated.bkt.eligible).toBe(0);
    const receipts = await f.sql`SELECT id FROM opening_exam_sprint_commands ORDER BY id`;
    const replay = await sprint.act(f.scope, command);
    expect(replay.activeRun).toBeNull();
    expect(replay.state.runs[0]!.completedAt).toBe(finished.state.runs[0]!.completedAt);
    expect(await f.sql`SELECT id FROM opening_exam_sprint_commands ORDER BY id`).toEqual(receipts);
    const exported = await sprint.export(f.scope);
    expect(exported.integration.links[0]).toMatchObject({ publication: "unavailable", observationId: null });
    expect(exported.integration.bkt.eligible).toBe(0);
    expect(exported.attempts[0]).toMatchObject({ answer: "a", answeredAt: capturedAt });
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 0, evidence: 0 });
  });

  it("rejects reusing an exam problem identity through the ordinary attempt creation API", async () => {
    await bind();
    const view = await start(), link = await linkFor(view.currentAttempt!.id), before = await factsCount();
    await expect(createOpeningLearningAttemptRepository(f.sql).create(f.scope, {
      sessionId: String(link.session_id), problemId: String(link.problem_id), requirementKey: String(link.requirement_key), clientKey: key(),
    })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await factsCount()).toEqual(before);
    expect((await integration.read(f.scope)).links).toHaveLength(1);
  });

  it("records all delivered help without AI turns and prevents reference-check revisions from laundering independence", async () => {
    const bound = await bind(), view = await start();
    const [turnsBefore] = await f.sql`SELECT count(*)::int AS count FROM opening_turns WHERE workspace_id=${f.scope.workspaceId}`;
    for (const kind of ["hint", "solution", "external"] as const) {
      const command = { action: "help" as const, attemptId: view.currentAttempt!.id, kind, clientKey: key() };
      await sprint.act(f.scope, command);
      await sprint.act(f.scope, command);
    }
    await answer(view);
    const link = await linkFor(view.currentAttempt!.id), saved = await observation(String(link.observation_id));
    const receipts = await f.sql`SELECT kind,content_snapshot,delivered_at FROM opening_exam_help_receipts WHERE attempt_link_id=${String(link.id)} ORDER BY kind`;
    expect(receipts.map(row => row.kind)).toEqual(["external", "hint", "solution"]);
    expect(receipts.every(row => typeof row.content_snapshot === "string" && row.content_snapshot.length > 0)).toBe(true);
    expect(receipts.every(row => Date.parse(iso(row.delivered_at)) <= Date.parse(iso(saved.submitted_at)))).toBe(true);
    expect((await f.sql`SELECT count(*)::int AS count FROM opening_turns WHERE workspace_id=${f.scope.workspaceId}`)[0]).toEqual(turnsBefore);
    expect(saved.assistance).toBe("revealed");
    expect(await eligibility(String(saved.id))).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes" });
    const revised = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: String(saved.id), revisesObservationId: String(saved.id), expectedHead: String(saved.id),
      clientKey: key(), reason: "Check the reference", revisionKind: "replace",
      replacement: { answer: "a", outcome: "correct", assistance: "independent", verdictSource: "reference_checked",
        referenceSourceId: bound.binding!.packSourceId, referenceCheck: { referenceSourceId: bound.binding!.packSourceId,
          method: "Checked the complete response", scope: "whole_answer" } },
    });
    expect(await eligibility(revised.headObservationId)).toMatchObject({ independentAttempt: "no", verifiedCorrect: "unknown" });
    expect(revised.observation).toMatchObject({ verdictSource: "self_report", referenceCheck: { referenceId: bound.binding!.packSourceId } });
    expect(revised.observation?.eligibility?.independentAttempt).toBe("no");
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
  });

  it("does not turn a changed exam answer into independent course evidence through a later reference check or restoration", async () => {
    const bound = await bind(), view = await start();
    await sprint.act(f.scope, { action: "answer", attemptId: view.currentAttempt!.id, answer: "b", confidence: 4, clientKey: key() });
    const link = await linkFor(view.currentAttempt!.id), saved = await observation(String(link.observation_id));
    expect(saved).toMatchObject({ answer: "b", outcome: "incorrect" });
    expect((await eligibility(String(saved.id))).independentAttempt).toBe("yes");
    const edited = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: String(saved.id), revisesObservationId: String(saved.id), expectedHead: String(saved.id),
      clientKey: key(), reason: "Replace my answer after seeing the result", revisionKind: "replace",
      replacement: { answer: "a", outcome: "correct", assistance: "independent", verdictSource: "self_report" },
    });
    expect((await eligibility(edited.headObservationId)).independentAttempt).toBe("no");
    const checked = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: String(saved.id), revisesObservationId: edited.headObservationId, expectedHead: edited.headObservationId,
      clientKey: key(), reason: "Check the replacement answer", revisionKind: "replace",
      replacement: { answer: "a", outcome: "correct", assistance: "independent", verdictSource: "reference_checked",
        referenceSourceId: bound.binding!.packSourceId, referenceCheck: { referenceSourceId: bound.binding!.packSourceId,
          method: "Checked the complete replacement answer", scope: "whole_answer" } },
    });
    expect(await eligibility(checked.headObservationId)).toMatchObject({ independentAttempt: "no", verifiedCorrect: "unknown" });
    expect(checked.observation?.eligibility?.independentAttempt).toBe("no");
    const restored = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: String(saved.id), revisesObservationId: checked.headObservationId, expectedHead: checked.headObservationId,
      clientKey: key(), reason: "Restore the captured answer", revisionKind: "replace",
      replacement: { answer: "b", outcome: "incorrect", assistance: "independent", verdictSource: "self_report" },
    });
    expect((await eligibility(restored.headObservationId)).independentAttempt).toBe("no");
    expect(restored.observation?.eligibility?.independentAttempt).toBe("no");
    expect(await observation(String(saved.id))).toMatchObject({ answer: "b", outcome: "incorrect", effective_head_id: restored.headObservationId });
    expect(await linkFor(view.currentAttempt!.id)).toMatchObject({ submitted_answer: "b", observation_id: saved.id });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
  });

  it("preserves the unchanged captured attempt while keeping learner grading corrections out of verified counts and BKT", async () => {
    const bound = await bind(), view = await start();
    await answer(view);
    const link = await linkFor(view.currentAttempt!.id), saved = await observation(String(link.observation_id));
    const marked = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: String(saved.id), revisesObservationId: String(saved.id), expectedHead: String(saved.id),
      clientKey: key(), reason: "Reconsider the grading without editing my answer", revisionKind: "replace",
      replacement: { answer: "a", outcome: "incorrect", assistance: "independent", verdictSource: "self_report" },
    });
    const corrected = await reviseOpeningLearningObservation(f.sql, f.scope, {
      rootObservationId: String(saved.id), revisesObservationId: marked.headObservationId, expectedHead: marked.headObservationId,
      clientKey: key(), reason: "Correct the grade after checking the unchanged answer", revisionKind: "replace",
      replacement: { answer: "a", outcome: "correct", assistance: "independent", verdictSource: "reference_checked",
        referenceSourceId: bound.binding!.packSourceId, referenceCheck: { referenceSourceId: bound.binding!.packSourceId,
          method: "Checked the complete original answer", scope: "whole_answer" } },
    });
    expect(await eligibility(corrected.headObservationId)).toMatchObject({ independentAttempt: "yes", verifiedCorrect: "unknown",
      reasonCodes: expect.arrayContaining(["learner_reference_compare"]) });
    expect(corrected.observation?.eligibility?.independentAttempt).toBe("yes");
    expect(corrected.observation).toMatchObject({ verdictSource: "self_report", referenceCheck: { referenceId: bound.binding!.packSourceId } });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
    expect((await summary()).groups[0]).toMatchObject({ sampleCount: 1, independentVerifiedCurrentCount: 0, unverifiedCount: 1 });
    expect(await linkFor(view.currentAttempt!.id)).toMatchObject({ submitted_answer: "a", observation_id: saved.id });
  });

  it("does not backfill attempts or observations when isolated historical practice is later bound", async () => {
    const historical = await start();
    await answer(historical);
    await finish(historical);
    expect(await factsCount()).toEqual({ sessions: 0, attempts: 0, observations: 0, evidence: 0 });
    const bound = await bind();
    expect(bound.links).toEqual([]);
    expect(bound.bkt.eligible).toBe(0);
    expect(await factsCount()).toEqual({ sessions: 0, attempts: 0, observations: 0, evidence: 0 });
    const newView = await start("practice");
    expect((await integration.read(f.scope)).links.map(link => link.examAttemptId)).toEqual([newView.currentAttempt!.id]);
    expect(newView.currentAttempt!.id).not.toBe(historical.currentAttempt!.id);
    expect((await factsCount())?.attempts).toBe(1);
  });

  it("treats a new question in an already exposed family as practice rather than fresh independent evidence", async () => {
    await bind();
    const first = await start();
    await answer(first);
    await finish(first);
    const repeat = await start("practice");
    expect(repeat.currentAttempt!.questionId).not.toBe(first.currentAttempt!.questionId);
    await answer(repeat);
    const link = await linkFor(repeat.currentAttempt!.id);
    expect(link.first_family_exposure).toBe(false);
    expect(await eligibility(String(link.observation_id))).toMatchObject({ independentAttempt: "no", verifiedCorrect: "yes" });
    expect((await integration.read(f.scope)).bkt).toMatchObject({ eligible: 1, excluded: 1 });
  });

  it("keeps unmapped paper reports isolated and preserves photo/reference versions in mapped self-reports without inventing attempts", async () => {
    const reference = await source(), work = await source({ image: true, version: 2, history: true });
    const bound = await integration.bind(f.scope, bindInput({ materials: [reference] }));
    expect(bound.sourceMappings[0]).toMatchObject({ skillIds: [], nodeIds: [], sourceId: reference.sourceId, sourceVersion: 1, physicalPage: 3 });
    const command: Extract<ExamSprintCommand, { action: "source" }> = { action: "source", clientKey: key(), sourceId: "paper-1", phase: "first",
      outcome: "correct", assistance: "none", durationMinutes: 7, errorCause: null, note: "Paper work", answerText: "My written method",
      workSourceId: work.sourceId, workSourceVersion: 1 };
    await sprint.act(f.scope, command);
    expect((await factsCount())?.observations).toBe(0);
    const mapping = { clientKey: key(), sourceItemId: "paper-1", skillIds: ["limit-laws"] };
    const mapped = await integration.mapSource(f.scope, mapping);
    await integration.mapSource(f.scope, mapping);
    expect(mapped.sourceMappings[0]).toMatchObject({ skillIds: ["limit-laws"], nodeIds: [bound.binding!.skills[0]!.nodeId] });
    const reported = await sprint.act(f.scope, { ...command, clientKey: key(), phase: "blind" });
    const record = reported.state.sourceRecords.at(-1)!;
    const [projected] = await f.sql`SELECT o.* FROM opening_exam_source_observations p JOIN opening_learning_observations o ON o.id=p.observation_id
      WHERE p.source_record_id=${record.id} AND o.course_id=${courseId}`;
    expect(projected).toMatchObject({ attempt_id: null, started_at: null, submitted_at: null, assistance: "unknown", verdict_source: "self_report",
      source_versions: { [reference.sourceId]: 1, [work.sourceId]: 1, [bound.binding!.packSourceId]: 0 } });
    expect(record).toMatchObject({ workSourceId: work.sourceId, workSourceVersion: 1, answerText: "My written method" });
    expect(await eligibility(String(projected!.id))).toMatchObject({ independentAttempt: "unknown", verifiedCorrect: "unknown" });
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 0, observations: 1, evidence: 1 });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
  });

  it("removes privacy-excluded evidence from live BKT and current rule eligibility without deleting the original fact", async () => {
    const bound = await bind(), view = await start();
    await answer(view);
    const link = await linkFor(view.currentAttempt!.id);
    expect((await integration.read(f.scope)).bkt.eligible).toBe(1);
    expect(await eligibility(String(link.observation_id))).toMatchObject({ usableForCurrentVersion: "yes" });
    await createOpeningPrivacyRepository(f.sql).recordExclusions(f.sql, f.scope, {
      sourceIds: [bound.binding!.packSourceId], memoryId: randomUUID(), deletedAt: new Date(),
    });
    expect(await eligibility(String(link.observation_id))).toMatchObject({ usableForCurrentVersion: "no" });
    expect((await integration.read(f.scope)).bkt).toMatchObject({ eligible: 0, excluded: 1, bktBrier: null, baselineBrier: null });
    expect((await sprint.read(f.scope)).skills[0]?.status).toBe("untested");
    expect((await observation(String(link.observation_id))).outcome).toBe("correct");
    expect((await factsCount())?.observations).toBe(1);
  });

  it("keeps a learner's reference comparison as self-report metadata without objective correctness or BKT promotion", async () => {
    const reference = await source(), work = await source({ image: true });
    await integration.bind(f.scope, bindInput({ materials: [reference] }));
    await integration.mapSource(f.scope, { clientKey: key(), sourceItemId: "paper-1", skillIds: ["limit-laws"] });
    const result = await sprint.act(f.scope, { action: "source", clientKey: key(), sourceId: "paper-1", phase: "first",
      outcome: "correct", assistance: "none", durationMinutes: 5, errorCause: null, note: "Compared with reference",
      answerText: "My method", workSourceId: work.sourceId, workSourceVersion: work.sourceVersion, referenceChecked: true });
    const [row] = await f.sql`SELECT o.* FROM opening_exam_source_observations l
      JOIN opening_learning_observations o ON o.id=l.observation_id
      WHERE o.course_id=${courseId} AND l.source_record_id=${result.state.sourceRecords.at(-1)!.id}`;
    expect(row).toMatchObject({ verdict_source: "self_report", outcome: "correct", attempt_id: null,
      reference_source_id: reference.sourceId, reference_check: { referenceId: reference.sourceId, scope: "whole_answer" } });
    expect(await eligibility(String(row!.id))).toMatchObject({ independentAttempt: "unknown", verifiedCorrect: "unknown" });
    expect((await integration.read(f.scope)).bkt.eligible).toBe(0);
  });

  it("preserves coverage for old and newly unmapped paper work while excluding a projected report whose source becomes private", async () => {
    const coveragePack: ExamPack = { ...pack, sourceItems: ["paper-1", "paper-unmapped", "paper-projected"].map(id => ({ ...pack.sourceItems[0]!, id })) };
    const paperSprint = createOpeningExamSprintRepository(f.sql, coveragePack);
    const paperIntegration = createOpeningExamIntegrationRepository(f.sql, coveragePack);
    const report = (sourceId: string) => paperSprint.act(f.scope, { action: "source", clientKey: key(), sourceId,
      phase: "first", outcome: "correct", assistance: "none", durationMinutes: 5, errorCause: null, note: "Completed paper work" });
    expect((await report("paper-1")).summary.sourceCovered).toBe(1);
    const reference = await source();
    await paperIntegration.bind(f.scope, bindInput({ materials: [reference] }));
    expect((await paperSprint.read(f.scope)).summary.sourceCovered).toBe(1);
    expect((await factsCount())?.observations).toBe(0);
    expect((await report("paper-unmapped")).summary.sourceCovered).toBe(2);
    expect((await factsCount())?.observations).toBe(0);
    await paperIntegration.mapSource(f.scope, { clientKey: key(), sourceItemId: "paper-projected", skillIds: ["limit-laws"] });
    expect((await report("paper-projected")).summary.sourceCovered).toBe(3);
    expect((await factsCount())?.observations).toBe(1);
    await createOpeningPrivacyRepository(f.sql).recordExclusions(f.sql, f.scope, {
      sourceIds: [reference.sourceId], memoryId: randomUUID(), deletedAt: new Date(),
    });
    const afterExclusion = await paperSprint.read(f.scope);
    expect(afterExclusion.summary.sourceCovered).toBe(2);
    expect(afterExclusion.state.sourceRecords).toHaveLength(3);
    expect((await factsCount())?.observations).toBe(1);
  });

  it("isolates owner scopes across binding, canonical attempts, mapping and private integration reads", async () => {
    await bind();
    const view = await start(), link = await linkFor(view.currentAttempt!.id);
    const forged = { workspaceId: f.scope.workspaceId, ownerUserId: f.otherScope.ownerUserId };
    await expect(integration.read(forged)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(integration.bind(forged, bindInput())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(integration.mapSource(forged, { clientKey: key(), sourceItemId: "paper-1", skillIds: ["limit-laws"] }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(sprint.act(forged, { action: "answer", clientKey: key(), attemptId: view.currentAttempt!.id, answer: "a", confidence: 4 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await createOpeningLearningAttemptRepository(f.sql).get(f.otherScope, String(link.learning_attempt_id))).toBeNull();
    expect(await integration.read(f.otherScope)).toMatchObject({ binding: null, links: [], bkt: { eligible: 0 } });
    expect(await factsCount()).toEqual({ sessions: 1, attempts: 1, observations: 0, evidence: 0 });
  });
});
