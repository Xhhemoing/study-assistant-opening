import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import {
  WRITING_META_PROPERTY_KEY,
  WRITING_WORKSPACE_PROTOCOL,
} from "@aistudy/contracts";
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
        return [{ id: "33333333-3333-4333-8333-333333333333", course_id: null, create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: capturedDocId } }];
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
      if (text.includes("FROM library_revisions")) {
        return [{ title: "同题重放", blocks: [{ content: { blockNoteContent: "原初文本", props: null, children: [] } }] }];
      }
      if (text.includes("FROM library_properties")) {
        return [{ value: meta }];
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
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("FROM library_documents d")) return [{ id: docId }];
      if (text.includes("FROM library_properties")) return [];
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
      if (text.includes("FROM workspaces")) return [{ id: SCOPE.workspaceId }];
      if (text.includes("FROM library_documents d JOIN library_properties p")) {
        return [{ id: docId, title: "普通笔记", current_revision_number: 2, created_at: now, updated_at: now, meta }];
      }
      if (text.includes("FROM library_documents d")) return [{ id: docId }];
      if (text.includes("FROM library_properties")) return [{ value: meta }];
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
        return [{ id: activityId, course_id: null, create_intent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docId } }];
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
});
