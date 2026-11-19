import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  WRITING_META_PROPERTY_KEY,
  WRITING_WORKSPACE_PROTOCOL,
} from "@aistudy/contracts";
import { createOpeningTeachingActivitiesRepository } from "./opening-teaching-activities";
import {
  OpeningWritingError,
  createOpeningWritingWorkspaceRepository,
} from "./opening-writing-workspace";

const SCOPE = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};

type QueryRecord = { sql: string; values: unknown[] };
type Responder = (sql: string, values: unknown[], index: number) => unknown[];

function createMockSql(responder: Responder) {
  const queries: QueryRecord[] = [];
  const run = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const sqlText = strings.join("?").replace(/\s+/g, " ").trim();
    const index = queries.length;
    queries.push({ sql: sqlText, values });
    return Promise.resolve(responder(sqlText, values, index));
  }) as unknown as Sql & {
    begin: <T>(fn: (tx: Sql) => Promise<T>) => Promise<T>;
    json: (val: unknown) => unknown;
  };
  run.json = (value: unknown) => value;
  run.begin = async <T>(fn: (tx: Sql) => Promise<T>) => fn(run);
  return { sql: run, queries };
}

describe("createOpeningWritingWorkspaceRepository", () => {
  it("locks workspace history before workspace share lock and creates course-less workspace on start", async () => {
    const now = "2026-11-18T10:00:00.000Z";
    let capturedDocId = "";
    let capturedBlockId = "";
    let capturedMeta: unknown = null;

    const { sql, queries } = createMockSql((text, values) => {
      if (text.startsWith("SELECT id FROM workspaces WHERE id =") && !text.includes("FOR SHARE")) {
        return [{ id: SCOPE.workspaceId }];
      }
      if (text.startsWith("SELECT id FROM workspaces") && !text.includes("FOR SHARE")) {
        return [{ id: SCOPE.workspaceId }];
      }
      if (text.includes("FOR SHARE")) {
        return [{ id: SCOPE.workspaceId }];
      }
      if (text.includes("FROM opening_teaching_activities") && text.includes("FOR UPDATE")) {
        return [];
      }
      if (text.includes("SELECT now()")) {
        return [{ now_ts: now }];
      }
      if (text.startsWith("INSERT INTO library_documents")) {
        capturedDocId = String(values[0]);
        expect(text).toContain("'scratch'");
        return [];
      }
      if (text.startsWith("INSERT INTO library_blocks")) {
        capturedBlockId = String(values[0]);
        expect(values[3]).toEqual({ blockNoteContent: "第一段内容", props: null, children: [] });
        return [];
      }
      if (text.startsWith("INSERT INTO library_properties")) {
        capturedMeta = values[3];
        return [];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [
          {
            id: capturedDocId,
            title: "论证练习",
            current_revision_number: 1,
            created_at: now,
            updated_at: now,
            meta: capturedMeta,
          },
        ];
      }
      if (text.includes("FROM library_blocks") && text.includes("id::text =")) {
        return [{ id: capturedBlockId }];
      }
      if (text.includes("FROM opening_teaching_activities")) {
        return [{
          id: "33333333-3333-4333-8333-333333333333",
          course_id: null,
          create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: capturedDocId },
          checkpoint_json: {
            writingWorkspace: {
              protocol: WRITING_WORKSPACE_PROTOCOL,
              workGroupId: capturedDocId,
              activeDocumentId: capturedDocId,
              activeVariantLabel: "初稿",
              savedRevisionNumber: 1,
              focusBlockId: capturedBlockId,
              updatedAt: now,
            },
          },
        }];
      }
      return [];
    });

    const repo = createOpeningWritingWorkspaceRepository(sql);
    const view = await repo.start(SCOPE, {
      clientKey: "writing-start-test-key",
      title: "论证练习",
      initialText: "第一段内容",
    });

    expect(view.courseId).toBeNull();
    expect(view.workGroupId).toBe(capturedDocId);
    expect(view.currentDocumentId).toBe(capturedDocId);
    expect(view.currentVariant.variantLabel).toBe("初稿");
    expect(view.focusRestore).toEqual({ status: "exact", blockId: capturedBlockId });

    const historyLockIndex = queries.findIndex((q) => q.sql.includes("opening_workspace_history_revisions") && q.sql.includes("FOR UPDATE"));
    const workspaceShareIndex = queries.findIndex((q) => q.sql.includes("FROM workspaces") && q.sql.includes("FOR SHARE"));
    expect(historyLockIndex).toBeGreaterThanOrEqual(0);
    expect(workspaceShareIndex).toBeGreaterThan(historyLockIndex);
    expect(queries.some((q) => q.sql.includes("opening_learning_observations"))).toBe(false);
  });

  it("replays idempotent start and throws CONFLICT on payload mismatch", async () => {
    const docId = "44444444-4444-4444-8444-444444444444";
    const blockId = "55555555-5555-4555-8555-555555555555";
    const activityId = "66666666-6666-4666-8666-666666666666";
    const now = "2026-11-18T10:00:00.000Z";
    const meta = {
      workGroupId: docId,
      variantLabel: "初稿",
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: false,
      focusBlockId: blockId,
      assistanceRecords: [],
    };
    const existingActivity = {
      id: activityId,
      course_id: null,
      create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docId },
      checkpoint_json: {
        writingWorkspace: {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId: docId,
          activeDocumentId: docId,
          activeVariantLabel: "初稿",
          savedRevisionNumber: 1,
          focusBlockId: blockId,
          updatedAt: now,
        },
      },
    };

    const { sql } = createMockSql((text) => {
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("FROM opening_teaching_activities") && text.includes("FOR UPDATE")) {
        return [existingActivity];
      }
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        return [{ id: docId, title: "同题重放", current_revision_number: 2, has_meta: true, meta, focus_exists: true }];
      }
      if (text.includes("FROM library_revisions")) {
        return [{ title: "同题重放", blocks: [{ content: { blockNoteContent: "原初文本", props: null, children: [] } }] }];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [{ id: docId, title: "同题重放", current_revision_number: 2, created_at: now, updated_at: now, meta }];
      }
      if (text.includes("FROM library_blocks")) return [{ id: blockId }];
      if (text.includes("FROM opening_teaching_activities")) return [existingActivity];
      return [];
    });

    const repo = createOpeningWritingWorkspaceRepository(sql);
    const replayed = await repo.start(SCOPE, {
      clientKey: "writing-replay-key-1",
      title: "同题重放",
      initialText: "原初文本",
    });
    expect(replayed.currentDocumentId).toBe(docId);
    expect(replayed.activityId).toBe(activityId);

    await expect(
      repo.start(SCOPE, {
        clientKey: "writing-replay-key-1",
        title: "改了标题",
        initialText: "原初文本",
      }),
    ).rejects.toMatchObject({ name: "OpeningWritingError", code: "CONFLICT" });
  });

  it("returns null from getView for ordinary notes without writing metadata and surfaces block_missing when focus block is gone", async () => {
    const docId = "44444444-4444-4444-8444-444444444444";
    const missingBlock = "77777777-7777-4777-8777-777777777777";
    const now = "2026-11-18T10:00:00.000Z";

    const uninitSql = createMockSql((text) => {
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        return [{ id: docId, title: "普通笔记", current_revision_number: 1, has_meta: false, meta: null, focus_exists: false }];
      }
      return [];
    }).sql;
    expect(await createOpeningWritingWorkspaceRepository(uninitSql).getView(SCOPE, docId)).toBeNull();

    const meta = {
      workGroupId: docId,
      variantLabel: "B 稿",
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: true,
      focusBlockId: missingBlock,
      assistanceRecords: [],
    };
    const missingSql = createMockSql((text) => {
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [{ id: docId, title: "普通笔记", current_revision_number: 2, created_at: now, updated_at: now, meta }];
      }
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        return [{ id: docId, title: "普通笔记", current_revision_number: 2, has_meta: true, meta, focus_exists: false }];
      }
      if (text.includes("FROM library_blocks")) return [];
      if (text.includes("FROM opening_teaching_activities")) return [];
      return [];
    }).sql;

    const view = await createOpeningWritingWorkspaceRepository(missingSql).getView(SCOPE, docId);
    expect(view?.focusRestore).toEqual({
      status: "block_missing",
      requestedBlockId: missingBlock,
      message: "上次定位的段落已删除或合并，已打开当前服务器保存的内容。",
    });
  });

  it("bootstraps an ordinary note on command, derives variant with cloned block ids, records feedback, and adopts polish with MASTERY_NOT_ESTABLISHED", async () => {
    const docId = "44444444-4444-4444-8444-444444444444";
    const blockId = "55555555-5555-4555-8555-555555555555";
    const activityId = "66666666-6666-4666-8666-666666666666";
    const assistanceId = "88888888-8888-4888-8888-888888888888";
    const now = "2026-11-18T10:00:00.000Z";

    let storedMeta: Record<string, unknown> | null = null;
    let derivedDocId = "";
    let derivedMeta: Record<string, unknown> | null = null;
    let derivedBlockId = "";
    let relationInserted = false;
    let observationQuerySeen = false;

    const { sql } = createMockSql((text, values) => {
      if (text.includes("opening_learning_observations")) observationQuerySeen = true;
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("SELECT * FROM library_documents")) {
        return [{ id: docId, workspace_id: SCOPE.workspaceId, title: "既有笔记", lifecycle: "scratch", current_revision_number: 1 }];
      }
      if (text.includes("SELECT now()")) return [{ now_ts: now }];
      if (text.includes("FROM library_blocks") && text.includes("ORDER BY position ASC")) {
        return [{ id: blockId, type: "paragraph", position: 0, content: { blockNoteContent: "原句。", props: null, children: [] } }];
      }
      if (text.includes("FROM library_properties") && text.includes("FOR UPDATE")) {
        return storedMeta ? [{ value: storedMeta }] : [];
      }
      if (text.startsWith("INSERT INTO library_properties")) {
        if (values[1] === docId) storedMeta = values[3] as Record<string, unknown>;
        else derivedMeta = values[3] as Record<string, unknown>;
        return [];
      }
      if (text.includes("FROM opening_teaching_activities") && text.includes("FOR UPDATE")) {
        if (text.includes("client_key =")) return [];
        return [{
          id: activityId,
          course_id: null,
          create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docId },
          checkpoint_json: {
            writingWorkspace: {
              protocol: WRITING_WORKSPACE_PROTOCOL,
              workGroupId: docId,
              activeDocumentId: docId,
              activeVariantLabel: "初稿",
              savedRevisionNumber: 1,
              focusBlockId: blockId,
              updatedAt: now,
            },
          },
        }];
      }
      if (text.startsWith("INSERT INTO library_documents")) {
        derivedDocId = String(values[0]);
        return [];
      }
      if (text.startsWith("INSERT INTO library_blocks")) {
        if (values[2] === derivedDocId) derivedBlockId = String(values[0]);
        return [];
      }
      if (text.startsWith("INSERT INTO library_relations")) {
        relationInserted = text.includes("'derived_from'") && values[1] === derivedDocId && values[2] === docId;
        return [];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [
          { id: docId, title: "既有笔记", current_revision_number: 1, created_at: now, updated_at: now, meta: storedMeta },
          ...(derivedMeta ? [{ id: derivedDocId, title: "既有笔记", current_revision_number: 1, created_at: now, updated_at: now, meta: derivedMeta }] : []),
        ];
      }
      if (text.includes("FROM library_blocks") && text.includes("id::text =")) {
        return [{ id: derivedBlockId || blockId }];
      }
      if (text.includes("FROM opening_teaching_activities")) {
        return [{
          id: activityId,
          course_id: null,
          create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docId },
          checkpoint_json: {
            writingWorkspace: {
              protocol: WRITING_WORKSPACE_PROTOCOL,
              workGroupId: docId,
              activeDocumentId: derivedDocId || docId,
              activeVariantLabel: "A 稿",
              savedRevisionNumber: 1,
              focusBlockId: derivedBlockId || blockId,
              updatedAt: now,
            },
          },
        }];
      }
      return [];
    });

    const repo = createOpeningWritingWorkspaceRepository(sql);
    const derived = await repo.command(SCOPE, docId, {
      action: "derive_variant",
      expectedRevisionNumber: 1,
      variantLabel: "A 稿",
    });

    expect(relationInserted).toBe(true);
    expect(derivedDocId).not.toBe("");
    expect(derivedBlockId).not.toBe(blockId);
    expect(derived.workspace.currentDocumentId).toBe(derivedDocId);
    expect(derived.workspace.currentVariant.parentDocumentId).toBe(docId);
    expect(derived.workspace.currentVariant.focusBlockId).toBe(derivedBlockId);

    // Verify adopt_suggestion conflict & success paths on a document with a recorded polish suggestion
    const metaWithSuggestion = {
      workGroupId: docId,
      variantLabel: "初稿",
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: false,
      focusBlockId: blockId,
      assistanceRecords: [
        {
          id: assistanceId,
          documentId: docId,
          baseRevisionNumber: 1,
          targetBlockId: blockId,
          targetBlockTextSnapshot: "原句。",
          dimension: "language",
          kind: "polish_suggestion",
          suggestionText: "润色后的句子。",
          adoptedAt: null,
          adoptedRevisionNumber: null,
          createdAt: now,
        },
      ],
    };

    let adoptedMetaSaved: Record<string, unknown> | null = null;
    let revisionInsertReason = "";
    const adoptSql = createMockSql((text, values) => {
      if (text.includes("opening_learning_observations")) observationQuerySeen = true;
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("SELECT * FROM library_documents") || text.includes("FROM library_documents WHERE id =")) {
        return [{ id: docId, workspace_id: SCOPE.workspaceId, title: "既有笔记", lifecycle: "scratch", current_revision_number: 1, created_at: now, updated_at: now, deleted_at: null }];
      }
      if (text.includes("UPDATE library_documents")) {
        return [{ id: docId, workspace_id: SCOPE.workspaceId, title: "既有笔记", lifecycle: "scratch", schema_version: 1, current_revision_number: 2, created_at: now, updated_at: now, deleted_at: null }];
      }
      if (text.includes("SELECT now()")) return [{ now_ts: now }];
      if (text.includes("FROM library_blocks") && text.includes("ORDER BY position ASC")) {
        return [{ id: blockId, type: "paragraph", position: 0, content: { blockNoteContent: "原句。", props: null, children: [] } }];
      }
      if (text.includes("FROM library_properties") && text.includes("FOR UPDATE")) {
        return [{ value: metaWithSuggestion }];
      }
      if (text.startsWith("INSERT INTO library_revisions")) {
        revisionInsertReason = String(values[7]);
        return [];
      }
      if (text.startsWith("INSERT INTO library_properties")) {
        expect(values[2]).toBe(WRITING_META_PROPERTY_KEY);
        adoptedMetaSaved = values[3] as Record<string, unknown>;
        return [];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [{ id: docId, title: "既有笔记", current_revision_number: 2, created_at: now, updated_at: now, meta: adoptedMetaSaved ?? metaWithSuggestion }];
      }
      if (text.includes("FROM library_blocks") && text.includes("id::text =")) return [{ id: blockId }];
      if (text.includes("FROM opening_teaching_activities")) {
        return [{
          id: activityId,
          course_id: null,
          create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docId },
          checkpoint_json: {
            writingWorkspace: {
              protocol: WRITING_WORKSPACE_PROTOCOL,
              workGroupId: docId,
              activeDocumentId: docId,
              activeVariantLabel: "初稿",
              savedRevisionNumber: 1,
              focusBlockId: blockId,
              updatedAt: now,
            },
          },
        }];
      }
      return [];
    }).sql;

    const adoptRepo = createOpeningWritingWorkspaceRepository(adoptSql);
    await expect(
      adoptRepo.command(SCOPE, docId, {
        action: "adopt_suggestion",
        expectedRevisionNumber: 1,
        assistanceId: "99999999-9999-4999-8999-999999999999",
        targetBlockId: blockId,
        replacementText: "润色后的句子。",
      }),
    ).rejects.toBeInstanceOf(OpeningWritingError);

    const adopted = await adoptRepo.command(SCOPE, docId, {
      action: "adopt_suggestion",
      expectedRevisionNumber: 1,
      assistanceId,
      targetBlockId: blockId,
      replacementText: "润色后的句子。",
    });
    expect(revisionInsertReason).toBe("writing-adopt-polish");
    expect(adopted.outcome).toEqual({
      activityId,
      courseId: null,
      documentId: docId,
      revisionNumber: 2,
      assistance: "revealed",
      adoptedPolishCount: 1,
      keptAsPreferred: false,
      evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    });
    expect(observationQuerySeen).toBe(false);
  });

  it("counterexample 1: rejects start replay and teaching activity get/list with zero leakage when pinned variant B is deleted, while keeping surviving variant A readable", async () => {
    const docRoot = "33333333-3333-4333-8333-333333333333";
    const docA = "44444444-4444-4444-8444-444444444444";
    const docB = "55555555-5555-4555-8555-555555555555";
    const blockA = "66666666-6666-4666-8666-666666666666";
    const blockB = "77777777-7777-4777-8777-777777777777";
    const activityId = "88888888-8888-4888-8888-888888888888";
    const assistanceId = "99999999-9999-4999-8999-999999999999";
    const now = "2026-11-18T11:00:00.000Z";
    const secretLabel = "B稿-绝密删稿标识";
    const secretSnapshot = "UNIQUE_DELETED_SENTENCE_LEAK_GUARD_991";
    const secretFeedback = "UNIQUE_DELETED_FEEDBACK_LEAK_GUARD_991";

    const rootMeta = {
      workGroupId: docRoot,
      variantLabel: "初稿",
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: false,
      focusBlockId: blockA,
      assistanceRecords: [],
    };
    const metaA = {
      workGroupId: docRoot,
      variantLabel: "A 稿",
      parentDocumentId: docRoot,
      parentRevisionNumber: 1,
      keptAsPreferred: false,
      focusBlockId: blockA,
      assistanceRecords: [],
    };
    const existingActivity = {
      id: activityId,
      workspace_id: SCOPE.workspaceId,
      owner_user_id: SCOPE.ownerUserId,
      course_id: null,
      status: "active",
      generate_status: "ready",
      intent_kind: "topic",
      intent_summary: "双稿测试",
      source_ids: [],
      goal_json: {},
      path_version: 1,
      content_version: 0,
      client_key: "writing-ce1-key",
      created_at: now,
      updated_at: now,
      create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docRoot },
      checkpoint_json: {
        writingWorkspace: {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId: docRoot,
          activeDocumentId: docB,
          activeVariantLabel: secretLabel,
          savedRevisionNumber: 2,
          focusBlockId: blockB,
          updatedAt: now,
        },
      },
    };

    // Simulate state after docB is deleted (deleted_at IS NOT NULL / openingNoteReadable false),
    // even if library_properties row for docB still holds assistanceRecords in storage.
    let sawReadableWritingPredicate = false;
    const { sql, queries } = createMockSql((text, values) => {
      if (text.includes("checkpoint_json->'writingWorkspace'->>'activeDocumentId'")) {
        sawReadableWritingPredicate = true;
        return [];
      }
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("FROM opening_teaching_activities") && text.includes("FOR UPDATE")) {
        return [existingActivity];
      }
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        const requestedDocId = String(values[3]);
        if (requestedDocId === docRoot) {
          return [{ id: docRoot, title: "双稿测试", current_revision_number: 1, has_meta: true, meta: rootMeta, focus_exists: true }];
        }
        if (requestedDocId === docA) {
          return [{ id: docA, title: "双稿测试", current_revision_number: 1, has_meta: true, meta: metaA, focus_exists: true }];
        }
        // docB is deleted/revoked -> filtered by d.deleted_at IS NULL AND openingNoteReadable
        return [];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [
          { id: docRoot, title: "双稿测试", current_revision_number: 1, created_at: now, updated_at: now, meta: rootMeta },
          { id: docA, title: "双稿测试", current_revision_number: 1, created_at: now, updated_at: now, meta: metaA },
        ];
      }
      if (text.includes("FROM library_blocks")) return [{ id: blockA }];
      if (text.includes("SELECT * FROM opening_teaching_activities")) {
        return [existingActivity];
      }
      if (text.includes("FROM opening_teaching_activities a")) {
        if (text.includes("create_intent->>'workGroupId'")) {
          return [existingActivity];
        }
        // Teaching activity get / listByOwner embed openingWritingActivityReadableSql -> deleted docB omits existingActivity
        return sawReadableWritingPredicate ? [] : [existingActivity];
      }
      return [];
    });

    const writingRepo = createOpeningWritingWorkspaceRepository(sql);
    const teachingRepo = createOpeningTeachingActivitiesRepository(sql);

    // (a) Replay start with same clientKey (both exact params and mutated params) -> NOT_FOUND, zero writes, zero leak
    let sameReplayErr: unknown = null;
    try {
      await writingRepo.start(SCOPE, {
        clientKey: "writing-ce1-key",
        title: "双稿测试",
        initialText: "初始段落",
      });
    } catch (err) {
      sameReplayErr = err;
    }
    expect(sameReplayErr).toMatchObject({ name: "OpeningWritingError", code: "NOT_FOUND" });

    let diffReplayErr: unknown = null;
    try {
      await writingRepo.start(SCOPE, {
        clientKey: "writing-ce1-key",
        title: "改参探测标题",
        initialText: "改参探测正文",
      });
    } catch (err) {
      diffReplayErr = err;
    }
    expect(diffReplayErr).toMatchObject({ name: "OpeningWritingError", code: "NOT_FOUND" });

    // (b) Teaching activity get -> null; assertOwnedActivity / setStatus / associateCourse / create replay -> NOT_FOUND
    const activityDetail = await teachingRepo.get(SCOPE, activityId);
    expect(sawReadableWritingPredicate).toBe(true);
    expect(activityDetail).toBeNull();
    await expect(teachingRepo.assertOwnedActivity(SCOPE, activityId)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      teachingRepo.setStatus(SCOPE, activityId, { status: "paused", expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      teachingRepo.associateCourse(SCOPE, activityId, { courseId: null, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      teachingRepo.create(SCOPE, {
        clientKey: "writing-ce1-key",
        intentKind: "topic",
        intentSummary: "探测同键重放",
        createIntent: { intentKind: "topic" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // (c) Teaching activity listByOwner -> omits deleted B activity
    const listedActivities = await teachingRepo.listByOwner(SCOPE);
    expect(listedActivities).toEqual([]);

    const serializedPayloads = JSON.stringify({
      sameReplayErr: sameReplayErr instanceof Error ? { code: (sameReplayErr as OpeningWritingError).code, message: sameReplayErr.message } : sameReplayErr,
      diffReplayErr: diffReplayErr instanceof Error ? { code: (diffReplayErr as OpeningWritingError).code, message: diffReplayErr.message } : diffReplayErr,
      activityDetail,
      listedActivities,
    });
    for (const forbidden of [secretLabel, secretSnapshot, secretFeedback, docB, blockB, assistanceId]) {
      expect(serializedPayloads).not.toContain(forbidden);
    }
    expect(
      queries.some(
        (q) =>
          /^(INSERT|UPDATE|DELETE)\b/.test(q.sql)
          && !q.sql.startsWith("INSERT INTO opening_workspace_history_revisions"),
      ),
    ).toBe(false);

    // Surviving variant A remains normally accessible via its own document entry
    const queriesBeforeReadOnly = queries.length;
    const viewA = await writingRepo.getView(SCOPE, docA);
    expect(viewA).not.toBeNull();
    expect(viewA!.currentDocumentId).toBe(docA);
    expect(viewA!.variants.map((v) => v.documentId)).toEqual([docRoot, docA]);
    expect(JSON.stringify(viewA)).not.toContain(docB);
    expect(JSON.stringify(viewA)).not.toContain(secretLabel);
    expect(
      queries.slice(queriesBeforeReadOnly).some((q) => /^(INSERT|UPDATE|DELETE)\b/.test(q.sql)),
    ).toBe(false);
  });

  it("counterexample 2: rejects explicit cross-group, empty-checkpoint, or missing activityId on getView with NOT_FOUND, while preserving block_missing and readable feedback on same variant B", async () => {
    const group1 = "33333333-3333-4333-8333-333333333333";
    const group2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const docB = "55555555-5555-4555-8555-555555555555";
    const docPlain = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const deletedBlock2 = "77777777-7777-4777-8777-777777777777";
    const group1ActivityId = "88888888-8888-4888-8888-888888888888";
    const otherGroupActivityId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const emptyCheckpointActivityId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const assistanceId = "99999999-9999-4999-8999-999999999999";
    const now = "2026-11-18T11:30:00.000Z";

    const metaB = {
      workGroupId: group1,
      variantLabel: "B 稿",
      parentDocumentId: group1,
      parentRevisionNumber: 1,
      keptAsPreferred: true,
      focusBlockId: deletedBlock2,
      assistanceRecords: [
        {
          id: assistanceId,
          documentId: docB,
          baseRevisionNumber: 1,
          targetBlockId: deletedBlock2,
          targetBlockTextSnapshot: "B 稿原第二段文本。",
          dimension: "structure",
          kind: "feedback",
          suggestionText: "建议补充反例收束。",
          adoptedAt: null,
          adoptedRevisionNumber: null,
          createdAt: now,
        },
      ],
    };
    const validGroup1Checkpoint = {
      writingWorkspace: {
        protocol: WRITING_WORKSPACE_PROTOCOL,
        workGroupId: group1,
        activeDocumentId: docB,
        activeVariantLabel: "B 稿",
        savedRevisionNumber: 3,
        focusBlockId: deletedBlock2,
        updatedAt: now,
      },
    };

    const { sql } = createMockSql((text, values) => {
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        const targetId = String(values[3]);
        if (targetId === docPlain) {
          return [{ id: docPlain, title: "普通未初始化笔记", current_revision_number: 1, has_meta: false, meta: null, focus_exists: false }];
        }
        if (targetId === docB) {
          return [{ id: docB, title: "双稿测试", current_revision_number: 3, has_meta: true, meta: metaB, focus_exists: false }];
        }
        return [];
      }
      if (text.includes("FROM opening_teaching_activities a")) {
        if (text.includes("WHERE a.id =")) {
          const actId = String(values[1]).toLowerCase();
          if (actId === otherGroupActivityId) {
            return [{
              id: otherGroupActivityId,
              course_id: null,
              create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: group2 },
              checkpoint_json: {
                writingWorkspace: {
                  ...validGroup1Checkpoint.writingWorkspace,
                  workGroupId: group2,
                },
              },
            }];
          }
          if (actId === emptyCheckpointActivityId) {
            return [{
              id: emptyCheckpointActivityId,
              course_id: null,
              create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: group1 },
              checkpoint_json: {},
            }];
          }
          if (actId === group1ActivityId) {
            return [{
              id: group1ActivityId,
              course_id: null,
              create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: group1 },
              checkpoint_json: validGroup1Checkpoint,
            }];
          }
          return [];
        }
        return [{
          id: group1ActivityId,
          course_id: null,
          create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: group1 },
          checkpoint_json: validGroup1Checkpoint,
        }];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [
          { id: group1, title: "双稿测试", current_revision_number: 1, created_at: now, updated_at: now, meta: { ...metaB, variantLabel: "初稿", parentDocumentId: null, parentRevisionNumber: null, keptAsPreferred: false, focusBlockId: null, assistanceRecords: [] } },
          { id: docB, title: "双稿测试", current_revision_number: 3, created_at: now, updated_at: now, meta: metaB },
        ];
      }
      if (text.includes("FROM library_blocks")) {
        return [];
      }
      return [];
    });

    const repo = createOpeningWritingWorkspaceRepository(sql);

    // Explicit activity from another workGroup -> NOT_FOUND (404), never falls back to group view
    await expect(
      repo.getView(SCOPE, docB, { activityId: otherGroupActivityId }),
    ).rejects.toMatchObject({ name: "OpeningWritingError", code: "NOT_FOUND" });

    // GPT #3: Explicit writing-workspace-v1 activity with matching workGroupId but empty {} checkpoint -> NOT_FOUND (404)
    await expect(
      repo.getView(SCOPE, docB, { activityId: emptyCheckpointActivityId }),
    ).rejects.toMatchObject({ name: "OpeningWritingError", code: "NOT_FOUND" });

    // Explicit activity on an uninitialized note -> NOT_FOUND (404)
    await expect(
      repo.getView(SCOPE, docPlain, { activityId: group1ActivityId }),
    ).rejects.toMatchObject({ name: "OpeningWritingError", code: "NOT_FOUND" });

    // Deleting B's second block still opens the exact same B variant with block_missing and preserved feedback
    const viewB = await repo.getView(SCOPE, docB, { activityId: group1ActivityId });
    expect(viewB).not.toBeNull();
    expect(viewB!.currentDocumentId).toBe(docB);
    expect(viewB!.activityId).toBe(group1ActivityId);
    expect(viewB!.focusRestore).toEqual({
      status: "block_missing",
      requestedBlockId: deletedBlock2,
      message: "上次定位的段落已删除或合并，已打开当前服务器保存的内容。",
    });
    expect(viewB!.currentVariant.assistanceRecords).toHaveLength(1);
    expect(viewB!.currentVariant.assistanceRecords[0]!.suggestionText).toBe("建议补充反例收束。");
  });

  it("counterexample 3: enforces single-snapshot consistency when concurrent revocation filters B out of variants during replay or getView", async () => {
    const docA = "33333333-3333-4333-8333-333333333333";
    const docB = "55555555-5555-4555-8555-555555555555";
    const blockB = "77777777-7777-4777-8777-777777777777";
    const activityId = "88888888-8888-4888-8888-888888888888";
    const assistanceId = "99999999-9999-4999-8999-999999999999";
    const now = "2026-11-18T12:00:00.000Z";
    const secretSentence = "CONCURRENT_REVOKE_SNAPSHOT_SENTENCE_777";

    const metaA = {
      workGroupId: docA,
      variantLabel: "初稿",
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: false,
      focusBlockId: null,
      assistanceRecords: [],
    };
    const metaB = {
      workGroupId: docA,
      variantLabel: "B 稿",
      parentDocumentId: docA,
      parentRevisionNumber: 1,
      keptAsPreferred: true,
      focusBlockId: blockB,
      assistanceRecords: [
        {
          id: assistanceId,
          documentId: docB,
          baseRevisionNumber: 1,
          targetBlockId: blockB,
          targetBlockTextSnapshot: secretSentence,
          dimension: "language",
          kind: "polish_suggestion",
          suggestionText: "并发撤权前的建议",
          adoptedAt: null,
          adoptedRevisionNumber: null,
          createdAt: now,
        },
      ],
    };
    const existingActivity = {
      id: activityId,
      course_id: null,
      create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docA },
      checkpoint_json: {
        writingWorkspace: {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId: docA,
          activeDocumentId: docB,
          activeVariantLabel: "B 稿",
          savedRevisionNumber: 1,
          focusBlockId: blockB,
          updatedAt: now,
        },
      },
    };

    // Simulate concurrent revocation committing right before buildView's groupRows snapshot:
    // initial readAuthorizedWritingDocument still saw docB, while groupRows only sees [docA].
    // buildView MUST reject with NOT_FOUND rather than returning variants:[A] + currentVariant:B.
    const { sql, queries } = createMockSql((text, values) => {
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("FROM opening_teaching_activities") && text.includes("FOR UPDATE")) {
        return [existingActivity];
      }
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        const targetId = String(values[3]);
        if (targetId === docA) {
          return [{ id: docA, title: "并发测试", current_revision_number: 1, has_meta: true, meta: metaA, focus_exists: false }];
        }
        return [{ id: docB, title: "并发测试", current_revision_number: 1, has_meta: true, meta: metaB, focus_exists: true }];
      }
      if (text.includes("FROM library_revisions")) {
        return [{ title: "并发测试", blocks: [{ content: { blockNoteContent: "初稿正文", props: null, children: [] } }] }];
      }
      if (text.includes("FROM opening_teaching_activities a")) {
        return [existingActivity];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        // Post-revocation snapshot omits docB!
        return [{ id: docA, title: "并发测试", current_revision_number: 1, created_at: now, updated_at: now, meta: metaA }];
      }
      return [];
    });

    const repo = createOpeningWritingWorkspaceRepository(sql);
    await expect(repo.getView(SCOPE, docB)).rejects.toMatchObject({
      name: "OpeningWritingError",
      code: "NOT_FOUND",
    });
    expect(queries.some((q) => /^(INSERT|UPDATE|DELETE)\b/.test(q.sql))).toBe(false);

    await expect(
      repo.start(SCOPE, {
        clientKey: "writing-ce3-key",
        title: "并发测试",
        initialText: "初稿正文",
      }),
    ).rejects.toMatchObject({
      name: "OpeningWritingError",
      code: "NOT_FOUND",
    });
    expect(
      queries.some(
        (q) =>
          /^(INSERT|UPDATE|DELETE)\b/.test(q.sql)
          && !q.sql.startsWith("INSERT INTO opening_workspace_history_revisions"),
      ),
    ).toBe(false);
  });

  it("rejects malformed writing activities (missing savedRevisionNumber or partial doc metadata) while keeping ordinary writing-workgroup clientKey activities readable", async () => {
    const workGroupId = "33333333-3333-4333-8333-333333333333";
    const docPartialMeta = "44444444-4444-4444-8444-444444444444";
    const missingRevActivityId = "55555555-5555-4555-8555-555555555555";
    const partialMetaActivityId = "66666666-6666-4666-8666-666666666666";
    const ordinaryPrefixedActivityId = "77777777-7777-4777-8777-777777777777";
    const now = "2026-11-18T12:30:00.000Z";

    const missingRevRow = {
      id: missingRevActivityId,
      workspace_id: SCOPE.workspaceId,
      owner_user_id: SCOPE.ownerUserId,
      course_id: null,
      status: "active",
      generate_status: "ready",
      intent_kind: "topic",
      intent_summary: "缺 savedRevisionNumber",
      source_ids: [],
      goal_json: {},
      path_version: 1,
      content_version: 0,
      client_key: "malformed-missing-rev",
      created_at: now,
      updated_at: now,
      create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId },
      checkpoint_json: {
        writingWorkspace: {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId,
          activeDocumentId: docPartialMeta,
          activeVariantLabel: "初稿",
          focusBlockId: null,
          updatedAt: now,
        },
      },
    };
    const partialMetaRow = {
      ...missingRevRow,
      id: partialMetaActivityId,
      intent_summary: "残缺稿件元数据",
      client_key: "malformed-partial-meta",
      checkpoint_json: {
        writingWorkspace: {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId,
          activeDocumentId: docPartialMeta,
          activeVariantLabel: "初稿",
          savedRevisionNumber: 1,
          focusBlockId: null,
          updatedAt: now,
        },
      },
    };
    const ordinaryPrefixedRow = {
      ...missingRevRow,
      id: ordinaryPrefixedActivityId,
      intent_summary: "普通活动但使用 writing-workgroup 前缀键",
      client_key: `writing-workgroup:${workGroupId}`,
      create_intent: { intentKind: "topic" },
      checkpoint_json: {},
    };
    const byId = new Map([
      [missingRevActivityId, missingRevRow],
      [partialMetaActivityId, partialMetaRow],
      [ordinaryPrefixedActivityId, ordinaryPrefixedRow],
    ]);

    const { sql, queries } = createMockSql((text, values) => {
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        return [{
          id: docPartialMeta,
          title: "残缺元数据稿件",
          current_revision_number: 1,
          has_meta: true,
          meta: { workGroupId },
          focus_exists: false,
        }];
      }
      if (text.includes("SELECT * FROM opening_teaching_activities")) {
        if (text.includes("client_key =")) {
          const key = String(values[2]);
          const hit = [...byId.values()].find((r) => r.client_key === key);
          return hit ? [hit] : [];
        }
        const hit = byId.get(String(values[0]));
        return hit ? [hit] : [];
      }
      if (text.includes("FROM opening_teaching_activities a")) {
        if (text.includes("WHERE a.id =")) {
          const hit = byId.get(String(values[1]));
          return hit ? [hit] : [];
        }
        return [missingRevRow, partialMetaRow, ordinaryPrefixedRow];
      }
      return [];
    });

    const teachingRepo = createOpeningTeachingActivitiesRepository(sql);

    // GPT #1: Both malformed writing records are excluded from get, assertOwnedActivity, listByOwner, setStatus, and create replay
    expect(await teachingRepo.get(SCOPE, missingRevActivityId)).toBeNull();
    expect(await teachingRepo.get(SCOPE, partialMetaActivityId)).toBeNull();
    await expect(teachingRepo.assertOwnedActivity(SCOPE, missingRevActivityId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(teachingRepo.assertOwnedActivity(SCOPE, partialMetaActivityId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(teachingRepo.setStatus(SCOPE, missingRevActivityId, { status: "paused" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(teachingRepo.setStatus(SCOPE, partialMetaActivityId, { status: "paused" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      teachingRepo.create(SCOPE, {
        clientKey: "malformed-partial-meta",
        intentKind: "topic",
        intentSummary: "probe",
        createIntent: { intentKind: "topic" },
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    // GPT #2: Ordinary teaching activity with clientKey = "writing-workgroup:..." remains readable in get & listByOwner
    const ordinary = await teachingRepo.get(SCOPE, ordinaryPrefixedActivityId);
    expect(ordinary?.id).toBe(ordinaryPrefixedActivityId);
    expect(ordinary?.clientKey).toBe(`writing-workgroup:${workGroupId}`);

    const listed = await teachingRepo.listByOwner(SCOPE);
    expect(listed.map((a) => a.id)).toEqual([ordinaryPrefixedActivityId]);

    const joinedSql = queries.map((q) => q.sql).join(" ");
    expect(joinedSql).not.toContain("writing-workgroup:%");
    expect(joinedSql).toContain("savedRevisionNumber");
  });

  it("opens the same owned readable manuscript with both lowercase and uppercase UUIDs", async () => {
    const lowerDocId = "abcdef12-3456-4abc-8def-abcdef123456";
    const upperDocId = lowerDocId.toUpperCase();
    const lowerBlockId = "fedcba98-7654-4fed-8cba-fedcba987654";
    const upperBlockId = lowerBlockId.toUpperCase();
    const lowerActivityId = "12345678-9abc-4def-8123-456789abcdef";
    const upperActivityId = lowerActivityId.toUpperCase();
    const now = "2026-11-18T13:00:00.000Z";

    const meta = {
      workGroupId: lowerDocId,
      variantLabel: "初稿",
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: false,
      focusBlockId: lowerBlockId,
      assistanceRecords: [],
    };
    const activityRow = {
      id: lowerActivityId,
      course_id: null,
      create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: lowerDocId },
      checkpoint_json: {
        writingWorkspace: {
          protocol: WRITING_WORKSPACE_PROTOCOL,
          workGroupId: lowerDocId,
          activeDocumentId: lowerDocId,
          activeVariantLabel: "初稿",
          savedRevisionNumber: 1,
          focusBlockId: lowerBlockId,
          updatedAt: now,
        },
      },
    };

    const { sql } = createMockSql((text, values) => {
      if (text.includes("FROM library_documents d") && text.includes("LEFT JOIN library_properties p")) {
        expect(String(values[3])).toBe(lowerDocId);
        return [{ id: lowerDocId, title: "大小写兼容测试", current_revision_number: 1, has_meta: true, meta, focus_exists: true }];
      }
      if (text.includes("FROM opening_teaching_activities a")) {
        return [activityRow];
      }
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [{ id: lowerDocId, title: "大小写兼容测试", current_revision_number: 1, created_at: now, updated_at: now, meta }];
      }
      if (text.includes("FROM library_blocks") && text.includes("id::text =")) {
        return [{ id: lowerBlockId }];
      }
      return [];
    });

    const repo = createOpeningWritingWorkspaceRepository(sql);
    const lowerView = await repo.getView(SCOPE, lowerDocId, {
      activityId: lowerActivityId,
      focusBlockId: lowerBlockId,
    });
    const upperView = await repo.getView(SCOPE, upperDocId, {
      activityId: upperActivityId,
      focusBlockId: upperBlockId,
    });

    expect(lowerView).not.toBeNull();
    expect(upperView).toEqual(lowerView);
    expect(upperView!.currentDocumentId).toBe(lowerDocId);
    expect(upperView!.activityId).toBe(lowerActivityId);
    expect(upperView!.focusRestore).toEqual({ status: "exact", blockId: lowerBlockId });
  });
});
