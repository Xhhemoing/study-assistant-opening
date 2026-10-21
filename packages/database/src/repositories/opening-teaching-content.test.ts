import { describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import {
  createOpeningTeachingContentRepository,
  redactBlocksForClientInit,
  sameActivitySpecGraph,
  sanitizeCheckpointForRestore,
} from "./opening-teaching-content";
import { OPENING_BACKUP_TABLES } from "./opening-backup-records";

vi.mock("./opening-study-exposure", () => ({
  generateOpeningStudyExposure: vi.fn(async () => ({ id: "released-answer" })),
  releaseOpeningStudyExposure: vi.fn(async () => ({ id: "released-answer" })),
}));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const ownerUserId = "00000000-0000-4000-8000-000000000002";
const activityId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const unitId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1";
const documentId = "cccccccc-cccc-4ccc-8ccc-ccccccccccc1";
const blockTeach = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const blockKey = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const scope = { workspaceId, ownerUserId };
const now = "2026-10-11T03:00:00.000Z";

function db(handler: (query: string, values: unknown[]) => unknown[]) {
  const writes: Array<{ query: string; values: unknown[] }> = [];
  const sql = ((strings: TemplateStringsArray | unknown[], ...values: unknown[]) => {
    if (!Object.hasOwn(strings as object, "raw")) return strings;
    const query = (strings as TemplateStringsArray).join("?");
    if (/INSERT|UPDATE|DELETE/.test(query)) writes.push({ query, values });
    return Promise.resolve(handler(query, values));
  }) as unknown as Sql;
  sql.begin = ((callback: (tx: Sql) => unknown) => callback(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, writes };
}

const blockOrder = [
  { blockId: blockTeach, position: 0, blockType: "text", role: "teach" as const },
  { blockId: blockKey, position: 1, blockType: "answer_key", role: "answer_key" as const },
];

describe("teaching content helpers (T1/T6/T7 unit)", () => {
  it("T6 redactBlocksForClientInit strips answer_key plaintext", () => {
    const blocks = redactBlocksForClientInit(blockOrder, [
      { id: blockTeach, type: "text", position: 0, content: { text: "intro" } },
      { id: blockKey, type: "answer_key", position: 1, content: { solutionZh: "SECRET" } },
    ]);
    expect(blocks[0]?.content).toEqual({ text: "intro" });
    expect(blocks[1]?.content).toBeNull();
    expect(blocks[1]?.answerRef).toEqual({ refId: blockKey, revealState: "hidden" });
    expect(JSON.stringify(blocks)).not.toContain("SECRET");
  });

  it("T7 sanitizeCheckpointForRestore does not dump unrevealed answers", () => {
    const cleaned = sanitizeCheckpointForRestore({
      drafts: [{ blockId: blockTeach, contentVersion: 1, draftText: "mine" }],
      answerKeys: [{ solutionZh: "SECRET" }],
      blocks: [
        { blockId: blockKey, role: "answer_key", content: { solutionZh: "SECRET" } },
      ],
    });
    expect(cleaned.answerKeys).toBeUndefined();
    expect(JSON.stringify(cleaned)).not.toContain("SECRET");
    expect((cleaned.blocks as Array<{ content: unknown }>)[0]?.content).toBeNull();
  });

  it("sameActivitySpecGraph matches knowledge soft-idempotent equality set", () => {
    const graph = {
      teachingUnitId: unitId,
      documentId,
      revisionNumber: 1,
      blockOrder,
      sourceRefs: [] as [],
      goals: [] as [],
      verificationStatus: "unchecked" as const,
      generationConfig: {},
    };
    expect(sameActivitySpecGraph(graph, { ...graph })).toBe(true);
    expect(sameActivitySpecGraph(graph, { ...graph, revisionNumber: 2 })).toBe(false);
  });
});

describe("opening teaching content repository (unit)", () => {
  it.each([
    { citations: [], live: true }, { citations: ["a-different-chunk"], live: true },
    { citations: ["answer-chunk"], live: true }, { citations: ["answer-chunk"], live: false },
  ])("attributes an answer only to its own current citations ($citations, live=$live)", async ({ citations, live }) => {
    const sourceId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
    const { sql } = db(query => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities")) return [{ content_version: 1, source_ids: [sourceId] }];
      if (query.includes("FROM opening_sources")) return [{ id: sourceId, version: 1 }];
      if (query.includes("FROM opening_source_chunks")) return live ? [{ id: "answer-chunk", source_id: sourceId, source_version: 1 }] : [];
      if (query.includes("FROM opening_learning_attempts")) return [{ submitted_at: now, activity_id: activityId, course_id: workspaceId, session_id: workspaceId,
        create_intent: { teachingBlock: { blockId: blockTeach, contentVersion: 1 } }, source_versions: { [sourceId]: 1 } }];
      if (query.includes("FROM opening_teaching_activity_specs")) return [{ document_id: documentId, revision_number: 1, version: 1,
        block_order: [{ ...blockOrder[0], blockType: "prompt", role: "prompt" }, blockOrder[1]],
        source_refs: [{ sourceId, chunkId: "answer-chunk", version: 1 }] }];
      if (query.includes("FROM library_revisions")) return [{ blocks: [
        { id: blockTeach, content: { text: "A cited lesson", citedChunkIds: ["answer-chunk"] } },
        { id: blockKey, content: { answer: "A generated answer", citedChunkIds: citations } },
      ] }];
      return [];
    });
    const answer = await createOpeningTeachingContentRepository(sql).getSubmittedAnswerKey(scope, activityId, blockTeach, "attempt");
    expect(answer).toEqual({ answer: "A generated answer", referenceSourceId: live && citations.includes("answer-chunk") ? sourceId : null });
  });

  it("T2 publishActivitySpec CAS: stale expectedVersion → CONFLICT", async () => {
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("JOIN workspaces")) {
        return [{
          id: activityId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          course_id: null, status: "active", generate_status: "ready",
          intent_kind: "topic", intent_summary: "x", source_ids: [],
          path_version: 1, content_version: 2, checkpoint_json: {},
          client_key: "k-min-8chars", create_intent: {}, created_at: now, updated_at: now,
        }];
      }
      if (query.includes("FROM opening_teaching_units")) {
        return [{
          id: unitId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          title: "U", document_id: documentId, current_revision_number: 1,
          goals_json: [], verification_status: "unchecked", generation_config: {},
          version: 0, created_at: now, updated_at: now,
        }];
      }
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [{
          id: activityId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          content_version: 2, checkpoint_json: {},
        }];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [];
      return [];
    });
    await expect(
      createOpeningTeachingContentRepository(sql).publishActivitySpec(scope, {
        activityId,
        teachingUnitId: unitId,
        expectedVersion: 0,
        revisionNumber: 1,
        blockOrder,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("T2 soft-idempotent: already at +1 with same graph succeeds", async () => {
    const specRow = {
      id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      activity_id: activityId,
      teaching_unit_id: unitId,
      document_id: documentId,
      revision_number: 1,
      block_order: blockOrder,
      source_refs: [],
      goals_json: [],
      verification_status: "unchecked",
      generation_config: {},
      version: 1,
      created_at: now,
      updated_at: now,
    };
    const { sql, writes } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("JOIN workspaces")) {
        return [{
          id: activityId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          course_id: null, status: "active", generate_status: "ready",
          intent_kind: "topic", intent_summary: "x", source_ids: [],
          path_version: 1, content_version: 1, checkpoint_json: {},
          client_key: "k-min-8chars", create_intent: {}, created_at: now, updated_at: now,
        }];
      }
      if (query.includes("FROM opening_teaching_units")) {
        return [{
          id: unitId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          title: "U", document_id: documentId, current_revision_number: 1,
          goals_json: [], verification_status: "unchecked", generation_config: {},
          version: 0, created_at: now, updated_at: now,
        }];
      }
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [{ id: activityId, content_version: 1, checkpoint_json: {} }];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow];
      return [];
    });
    const result = await createOpeningTeachingContentRepository(sql).publishActivitySpec(scope, {
      activityId,
      teachingUnitId: unitId,
      expectedVersion: 0,
      revisionNumber: 1,
      blockOrder,
    });
    expect(result.version).toBe(1);
    expect(writes.some((w) => w.query.includes("INSERT INTO opening_teaching_activity_specs"))).toBe(false);
  });

  it("T5 draft_anchor_lost when block removed", async () => {
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [{
          id: activityId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          content_version: 1, checkpoint_json: {},
        }];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) {
        return [{ block_order: [blockOrder[0]] }];
      }
      return [];
    });
    const result = await createOpeningTeachingContentRepository(sql).saveDraftAnchors(
      scope,
      activityId,
      {
        expectedVersion: 1,
        drafts: [{ blockId: blockKey, contentVersion: 1, draftText: "x" }],
      },
    );
    expect(result).toEqual({
      ok: false,
      mismatch: "draft_anchor_lost",
      lostBlockIds: [blockKey],
    });
  });

  it("T5 preserves drafts when blockIds still present", async () => {
    const { sql } = db((query) => {
      if (query.includes("FROM workspaces")) return [{ id: workspaceId }];
      if (query.includes("FROM opening_teaching_activities") && query.includes("FOR UPDATE")) {
        return [{
          id: activityId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          content_version: 1, checkpoint_json: { drafts: [] },
        }];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) {
        return [{ block_order: blockOrder }];
      }
      if (query.includes("UPDATE opening_teaching_activities")) {
        return [{
          content_version: 1,
          checkpoint_json: {
            drafts: [{ blockId: blockTeach, contentVersion: 1, draftText: "keep" }],
          },
        }];
      }
      return [];
    });
    const result = await createOpeningTeachingContentRepository(sql).saveDraftAnchors(
      scope,
      activityId,
      {
        expectedVersion: 1,
        drafts: [{ blockId: blockTeach, contentVersion: 1, draftText: "keep" }],
      },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.checkpointJson.drafts).toEqual([
        { blockId: blockTeach, contentVersion: 1, draftText: "keep" },
      ]);
    }
  });

  it("T9 backup registration includes teaching content tables", () => {
    expect(OPENING_BACKUP_TABLES).toContain("opening_teaching_units");
    expect(OPENING_BACKUP_TABLES).toContain("opening_teaching_activity_specs");
  });

  it("T8 does not introduce a parallel teaching answer ledger table name", () => {
    expect(OPENING_BACKUP_TABLES).not.toContain("opening_teaching_answers");
    expect(OPENING_BACKUP_TABLES).not.toContain("opening_teaching_answer_refs");
  });

  it("M1 getActivitySpecAtVersion returns only when version matches current", async () => {
    const specRow = {
      id: "ffffffff-ffff-4fff-8fff-fffffffffff1",
      workspace_id: workspaceId,
      owner_user_id: ownerUserId,
      activity_id: activityId,
      teaching_unit_id: unitId,
      document_id: documentId,
      revision_number: 2,
      block_order: blockOrder,
      source_refs: [],
      goals_json: [],
      verification_status: "unchecked",
      generation_config: {},
      version: 2,
      created_at: now,
      updated_at: now,
    };
    const { sql } = db((query) => {
      if (query.includes("FROM opening_teaching_activities") && query.includes("JOIN workspaces")) {
        return [{
          id: activityId, workspace_id: workspaceId, owner_user_id: ownerUserId,
          course_id: null, status: "active", generate_status: "ready",
          intent_kind: "topic", intent_summary: "x", source_ids: [],
          path_version: 1, content_version: 2, checkpoint_json: {},
          client_key: "k-min-8chars", create_intent: {}, created_at: now, updated_at: now,
        }];
      }
      if (query.includes("FROM opening_teaching_activity_specs")) return [specRow];
      return [];
    });
    const repo = createOpeningTeachingContentRepository(sql);
    expect(await repo.getActivitySpecAtVersion(scope, activityId, 2)).toMatchObject({ version: 2 });
    expect(await repo.getActivitySpecAtVersion(scope, activityId, 1)).toBeNull();
  });
});

