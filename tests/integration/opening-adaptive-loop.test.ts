/**
 * K02 Data half — SkillEvidence + L01 observation association.
 * Experience/AI pieces (tutor-actions UI, L02 worker close-due append) are left as hooks;
 * this file asserts Data-owned projections that those layers can call.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { KnowledgeSnapshot } from "@aistudy/contracts";
import {
  createOpeningKnowledgeRepository,
  createOpeningLearningAttemptRepository,
  createOpeningLearningRepository,
  createOpeningSkillEvidenceRepository,
  type OpeningLearningRepository,
  type OpeningSkillEvidenceRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";
import { matrixAttemptFixture } from "./opening-matrix-attempt-fixture";

let f: OpeningFixture;
let learning: OpeningLearningRepository;
let evidence: OpeningSkillEvidenceRepository;

const nodeA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const nodeB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";

beforeAll(async () => {
  f = await createOpeningFixture();
  learning = createOpeningLearningRepository(f.sql);
  evidence = createOpeningSkillEvidenceRepository(f.sql);
});
afterAll(async () => {
  if (!f) return;
  try {
    const workspaces = [f.scope.workspaceId, f.otherScope.workspaceId];
    await f.sql.begin(async tx => {
      await tx`DELETE FROM opening_turns WHERE workspace_id=ANY(${workspaces}::uuid[])`;
      // Sessions remove attempts/observations first; item versions must go before activity cascade.
      await tx`DELETE FROM opening_learning_sessions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
      await tx`DELETE FROM opening_learning_item_versions WHERE workspace_id=ANY(${workspaces}::uuid[])`;
      await tx`DELETE FROM workspaces WHERE id=ANY(${workspaces}::uuid[])`;
    });
  } finally { await f.close(); }
});
beforeEach(async () => {
  await f.sql`TRUNCATE opening_skill_evidence, opening_learning_eligibility, opening_learning_observations,
    opening_help_exposures, opening_problem_refs, opening_learning_sessions, opening_course_knowledge,
    opening_outbox, opening_jobs, opening_source_chunks, opening_sources, course_asset_memberships
    RESTART IDENTITY CASCADE`;
  await f.sql`DELETE FROM courses WHERE workspace_id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
});

async function seedCourseWithKnowledge() {
  const rows = backupRows(f.sql, f.scope);
  const sourceId = await rows.source();
  const chunkId = await rows.chunk(sourceId);
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${sourceId}`;
  const courseId = randomUUID();
  await f.sql`INSERT INTO courses (id, workspace_id, title, slug)
    VALUES (${courseId}, ${f.scope.workspaceId}, 'Adaptive loop', ${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships
    (id, workspace_id, course_id, asset_type, asset_id, role, sort_order, visibility)
    VALUES (${randomUUID()}, ${f.scope.workspaceId}, ${courseId}, 'source', ${sourceId}, 'core', 0, 'course')`;

  const snapshot: KnowledgeSnapshot = {
    courseId,
    version: 1,
    nodes: [
      {
        id: nodeA,
        courseId,
        label: "函数",
        kind: "concept",
        evidenceChunkIds: [chunkId],
        status: "supported",
      },
      {
        id: nodeB,
        courseId,
        label: "映射",
        kind: "concept",
        evidenceChunkIds: [chunkId],
        status: "supported",
      },
    ],
    edges: [
      {
        from: nodeA,
        to: nodeB,
        kind: "prerequisite",
        evidenceChunkIds: [chunkId],
        status: "supported",
      },
    ],
  };
  await createOpeningKnowledgeRepository(f.sql).replace(f.scope, courseId, {
    expectedVersion: 0,
    snapshot,
    sourceVersions: { [sourceId]: 1 },
  });
  return { courseId, sourceId, chunkId };
}

describe("opening adaptive loop (K02 Data)", () => {
  it("links SkillEvidence on L01 observation when nodeId+dimension are provided", async () => {
    const { courseId, sourceId, chunkId } = await seedCourseWithKnowledge();
    const session = await learning.createSession(f.scope, {
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
    });
    const attempt = await createOpeningLearningAttemptRepository(f.sql).create(f.scope, { sessionId: session.id, clientKey: randomUUID(),
      problem: { sourceId, chunkId, physicalPage: 1, stemSnapshot: "What is f(x)?", artifactKind: "reference_item" } });
    const obs = await learning.insertObservation(f.scope, {
      sessionId: session.id,
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
      attemptId: attempt.id, problemId: attempt.problemId,
      answer: "f(x)=x",
      outcome: "correct",
      assistance: "hinted",
      clientKey: "adaptive-assisted-1",
      nodeId: nodeA,
      dimension: "procedure",
    });

    const links = await evidence.listByObservation(f.scope, obs.id);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      nodeId: nodeA,
      observationId: obs.id,
      dimension: "procedure",
      courseId,
    });

    // Assisted success must not count as checked independent mastery evidence.
    const flags = await evidence.flagsForNode(f.scope, nodeA);
    expect(flags.hasAssistance).toBe(true);
    expect(flags.hasCheckedIndependent).toBe(false);
    expect(flags.evidenceIds).toEqual([links[0]!.id]);
  });

  it("idempotently relinks on observation clientKey replay", async () => {
    const { courseId, sourceId } = await seedCourseWithKnowledge();
    const session = await learning.createSession(f.scope, {
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
    });
    const payload = {
      sessionId: session.id,
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
      answer: "1",
      outcome: "correct" as const,
      assistance: "independent" as const,
      clientKey: "adaptive-replay-1x",
      nodeId: nodeA,
      dimension: "transfer" as const,
    };
    const first = await learning.insertObservation(f.scope, payload);
    const second = await learning.insertObservation(f.scope, payload);
    expect(second.id).toBe(first.id);
    const links = await evidence.listByObservation(f.scope, first.id);
    expect(links).toHaveLength(1);
    const again = await evidence.link(f.scope, {
      nodeId: nodeA,
      observationId: first.id,
      dimension: "transfer",
      courseId,
    });
    expect(again.id).toBe(links[0]!.id);
  });

  it("marks checked independent only from a real current server-scored attempt", async () => {
    const matrix = await matrixAttemptFixture(f);
    await f.sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility)
      VALUES(${f.scope.workspaceId},${matrix.courseId},'source',${matrix.sourceId},'core','private')`;
    await createOpeningKnowledgeRepository(f.sql).replace(f.scope, matrix.courseId, { expectedVersion: 0,
      sourceVersions: { [matrix.sourceId]: 1 }, snapshot: { courseId: matrix.courseId, version: 1, edges: [],
        nodes: [{ id: nodeA, courseId: matrix.courseId, label: "矩阵维数", kind: "concept", status: "supported", evidenceChunkIds: [matrix.chunkId] }] } });
    const obs = await matrix.submit(await matrix.start());
    await evidence.link(f.scope, { nodeId: nodeA, observationId: obs.id, courseId: matrix.courseId, dimension: "transfer" });
    const flags = await evidence.flagsForNode(f.scope, nodeA);
    expect(flags.hasCheckedIndependent).toBe(true);
    expect(flags.hasAssistance).toBe(false);
    const byNode = await evidence.listByNode(f.scope, nodeA);
    expect(byNode).toHaveLength(1);
    expect(byNode[0]!.dimension).toBe("transfer");
    const revised = await matrix.learning.reviseObservation(f.scope, { rootObservationId: obs.id, revisesObservationId: obs.id,
      expectedHead: obs.id, revisionKind: "replace", reason: "Learner review", clientKey: randomUUID(),
      replacement: { answer: "[2,3]", outcome: "correct", assistance: "hinted", verdictSource: "self_report" } });
    expect((await evidence.flagsForNode(f.scope, nodeA))).toMatchObject({ hasCheckedIndependent: false, hasAssistance: true });
    await matrix.learning.reviseObservation(f.scope, { rootObservationId: obs.id, revisesObservationId: revised.headObservationId,
      expectedHead: revised.headObservationId, revisionKind: "retract", reason: "Withdraw record", clientKey: randomUUID() });
    expect(await evidence.flagsForNode(f.scope, nodeA)).toEqual({ nodeId: nodeA, hasCheckedIndependent: false, hasAssistance: false, evidenceIds: [] });
    expect(await evidence.listByNode(f.scope, nodeA)).toHaveLength(1);
  });

  it("does not pollute a sibling knowledge node (cross-skill isolation)", async () => {
    const { courseId, sourceId } = await seedCourseWithKnowledge();
    const session = await learning.createSession(f.scope, {
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
    });
    await learning.insertObservation(f.scope, {
      sessionId: session.id,
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
      answer: "A only",
      outcome: "correct",
      assistance: "hinted",
      clientKey: "adaptive-cross-a",
      nodeId: nodeA,
      dimension: "recall",
    });

    expect(await evidence.listByNode(f.scope, nodeA)).toHaveLength(1);
    expect(await evidence.listByNode(f.scope, nodeB)).toHaveLength(0);
    const flagsB = await evidence.flagsForNode(f.scope, nodeB);
    expect(flagsB).toEqual({
      nodeId: nodeB,
      hasCheckedIndependent: false,
      hasAssistance: false,
      evidenceIds: [],
    });
  });

  it("rejects unknown nodeId when a knowledge snapshot exists", async () => {
    const { courseId, sourceId } = await seedCourseWithKnowledge();
    const session = await learning.createSession(f.scope, {
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
    });
    await expect(
      learning.insertObservation(f.scope, {
        sessionId: session.id,
        courseId,
        skillLabel: "functions",
        sourceIds: [sourceId],
        answer: "x",
        outcome: "correct",
        assistance: "independent",
        clientKey: "adaptive-bad-node",
        nodeId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
        dimension: "timed",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("rejects partial skill-link fields on observation input", async () => {
    const { courseId, sourceId } = await seedCourseWithKnowledge();
    const session = await learning.createSession(f.scope, {
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
    });
    await expect(
      learning.insertObservation(f.scope, {
        sessionId: session.id,
        courseId,
        skillLabel: "functions",
        sourceIds: [sourceId],
        answer: "x",
        outcome: "correct",
        assistance: "independent",
        clientKey: "adaptive-partial-1",
        nodeId: nodeA,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("leaves retest/delay worker path to AI — Data only asserts link-on-observation hook", async () => {
    // Documented skip boundary: L02 close-due + append evidence on worker complete is AI-owned.
    // Data exports evidence.link / flagsForNode for that worker to call.
    expect(typeof evidence.link).toBe("function");
    expect(typeof evidence.flagsForNode).toBe("function");
  });
});
