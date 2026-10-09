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
  createOpeningLearningRepository,
  createOpeningSkillEvidenceRepository,
  type OpeningLearningRepository,
  type OpeningSkillEvidenceRepository,
} from "@aistudy/database";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";
import { backupRows } from "./opening-backup-records-fixture";

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
  await f.sql`DELETE FROM workspaces WHERE id IN (${f.scope.workspaceId},${f.otherScope.workspaceId})`;
  await f.close();
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
    const { courseId, sourceId } = await seedCourseWithKnowledge();
    const session = await learning.createSession(f.scope, {
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
    });
    const obs = await learning.insertObservation(f.scope, {
      sessionId: session.id,
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
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

  it("marks checked independent when eligibility says yes (Data flag helper)", async () => {
    const { courseId, sourceId } = await seedCourseWithKnowledge();
    const session = await learning.createSession(f.scope, {
      courseId,
      skillLabel: "functions",
      sourceIds: [sourceId],
    });
    const obs = await learning.insertObservation(
      f.scope,
      {
        sessionId: session.id,
        courseId,
        skillLabel: "functions",
        sourceIds: [sourceId],
        answer: "transfer ok",
        outcome: "correct",
        assistance: "independent",
        clientKey: "adaptive-independent-1",
        problemId: randomUUID(),
        nodeId: nodeA,
        dimension: "transfer",
      },
      { verdictSource: "reference_checked", referenceSourceId: sourceId },
    );

    // Seed eligibility head so Data flag helper can see checked-independent evidence.
    // (Full attempt/help pipeline remains L01/DL6; L02 worker append is AI-owned.)
    await f.sql`
      INSERT INTO opening_learning_eligibility (
        workspace_id, owner_user_id, root_observation_id, head_observation_id,
        head_revision, input_revision, policy_version, help_revision, item_matches,
        source_states, privacy_source_ids,
        independent_attempt, verified_correct, usable_for_current_version, usable_for_delayed_check,
        reason_codes, version_applicability
      ) VALUES (
        ${f.scope.workspaceId}, ${f.scope.ownerUserId}, ${obs.id}, ${obs.id},
        1, 1, 'test', 0, true,
        ${f.sql.json([])}, ${[]},
        'yes', 'yes', 'yes', 'unknown',
        ${[]}, 'exact'
      )
      ON CONFLICT (workspace_id, owner_user_id, root_observation_id) DO UPDATE SET
        independent_attempt = 'yes',
        verified_correct = 'yes',
        usable_for_current_version = 'yes',
        head_observation_id = EXCLUDED.head_observation_id`;

    const flags = await evidence.flagsForNode(f.scope, nodeA);
    expect(flags.hasCheckedIndependent).toBe(true);
    expect(flags.hasAssistance).toBe(false);
    const byNode = await evidence.listByNode(f.scope, nodeA);
    expect(byNode).toHaveLength(1);
    expect(byNode[0]!.dimension).toBe("transfer");
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
