import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLibraryRepository,
  readOpeningWorkspaceActivityRecovery,
} from "@aistudy/database";
import type { CourselessActivityOutcome, WritingWorkspaceResponse, WritingWorkspaceView } from "@aistudy/contracts";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST as startWriting } from "../../../apps/web/src/app/api/opening/writing/route";
import {
  GET as getWriting,
  POST as commandWriting,
} from "../../../apps/web/src/app/api/opening/writing/[documentId]/route";
import { PATCH as patchDocument } from "../../../apps/web/src/app/api/documents/[id]/route";
import { createOpeningFixture, type OpeningFixture } from "../opening-fixture";

let f: OpeningFixture;
let runtime: ReturnType<typeof createAuthRuntime>;

function req(path: string, method: string, body?: unknown, cookie = f.cookie) {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const docCtx = (documentId: string) => ({ params: Promise.resolve({ documentId }) });
const idCtx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeAll(async () => {
  f = await createOpeningFixture();
  runtime = createAuthRuntime({
    databaseUrl: process.env.DATABASE_URL!,
    authSecret: process.env.AUTH_SECRET ?? "opening-fixture-secret-opening-fixture-secret",
    sessionCookieSecure: false,
    sessionTtlSeconds: 3600,
    authCookieName: "aistudy_session",
  });
  setAuthRuntimeForTests(runtime);
});

afterAll(async () => {
  setAuthRuntimeForTests(null);
  await runtime?.close();
  await f?.close();
});

describe("opening writing workspace route handlers", () => {
  it("requires authentication, rejects foreign ownership, and returns initialized: false for ordinary notes", async () => {
    const library = createLibraryRepository(f.sql);
    const normalDoc = await library.createDocument({
      workspaceId: f.scope.workspaceId,
      title: "普通笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { blockNoteContent: "普通正文", props: null, children: [] } }],
    });
    const foreignDoc = await library.createDocument({
      workspaceId: f.otherScope.workspaceId,
      title: "他人笔记",
      blocks: [{ id: randomUUID(), type: "paragraph", content: { blockNoteContent: "私密内容", props: null, children: [] } }],
    });

    const unauth = await getWriting(req(`/api/opening/writing/${normalDoc.id}`, "GET", undefined, ""), docCtx(normalDoc.id));
    expect(unauth.status).toBe(401);

    const foreign = await getWriting(req(`/api/opening/writing/${foreignDoc.id}`, "GET"), docCtx(foreignDoc.id));
    expect(foreign.status).toBe(404);

    const uninit = await getWriting(req(`/api/opening/writing/${normalDoc.id}`, "GET"), docCtx(normalDoc.id));
    expect(uninit.status).toBe(200);
    await expect(uninit.json()).resolves.toEqual({ initialized: false, documentId: normalDoc.id });
  });

  it("supports course-less start, A/B derivation, pinned B recovery despite later A edit, block_missing restore, feedback & adopt polish with zero observations", async () => {
    const startKey = `writing-e2e-${randomUUID()}`;
    const startBody = {
      clientKey: startKey,
      title: "跨分支独立写作",
      initialText: "第一段：初始论点。",
      variantLabel: "初稿",
      courseId: null,
    };

    const startRes = await startWriting(req("/api/opening/writing", "POST", startBody));
    expect(startRes.status).toBe(201);
    const started = (await startRes.json()) as WritingWorkspaceView;
    expect(started.courseId).toBeNull();
    expect(started.currentVariant.variantLabel).toBe("初稿");
    expect(started.variants).toHaveLength(1);
    const docInit = started.currentDocumentId;
    const activityId = started.activityId!;

    // Idempotent replay vs payload mismatch conflict
    const replayRes = await startWriting(req("/api/opening/writing", "POST", startBody));
    expect(replayRes.status).toBe(201);
    expect(((await replayRes.json()) as WritingWorkspaceView).workGroupId).toBe(started.workGroupId);

    const conflictRes = await startWriting(
      req("/api/opening/writing", "POST", { ...startBody, title: "篡改标题" }),
    );
    expect(conflictRes.status).toBe(409);

    // Derive A 稿 and B 稿 from 初稿
    const deriveARes = await commandWriting(
      req(`/api/opening/writing/${docInit}`, "POST", {
        action: "derive_variant",
        expectedRevisionNumber: 1,
        variantLabel: "A 稿",
        activityId,
      }),
      docCtx(docInit),
    );
    expect(deriveARes.status).toBe(200);
    const derivedA = (await deriveARes.json()) as { workspace: WritingWorkspaceView };
    const docA = derivedA.workspace.currentDocumentId;

    const deriveBRes = await commandWriting(
      req(`/api/opening/writing/${docInit}`, "POST", {
        action: "derive_variant",
        expectedRevisionNumber: 1,
        variantLabel: "B 稿",
        activityId,
      }),
      docCtx(docInit),
    );
    expect(deriveBRes.status).toBe(200);
    const derivedB = (await deriveBRes.json()) as { workspace: WritingWorkspaceView };
    const docB = derivedB.workspace.currentDocumentId;

    // Add paragraph 1 & paragraph 2 to B 稿 via PATCH /api/documents/[id]
    const bBlock1 = randomUUID();
    const bBlock2 = randomUUID();
    const patchB1 = await patchDocument(
      req(`/api/documents/${docB}`, "PATCH", {
        expectedRevisionNumber: 1,
        title: "跨分支独立写作",
        blocks: [
          { id: bBlock1, type: "paragraph", content: { blockNoteContent: "B 稿第一段原句。", props: null, children: [] } },
          { id: bBlock2, type: "paragraph", content: { blockNoteContent: "B 稿第二段论据。", props: null, children: [] } },
        ],
      }),
      idCtx(docB),
    );
    expect(patchB1.status).toBe(200);

    // Pin checkpoint to B 稿 paragraph 2 and mark preferred
    const pinB = await commandWriting(
      req(`/api/opening/writing/${docB}`, "POST", {
        action: "save_checkpoint",
        activityId,
        focusBlockId: bBlock2,
        keptAsPreferred: true,
      }),
      docCtx(docB),
    );
    expect(pinB.status).toBe(200);

    // Record argument feedback on B 稿 before editing A
    const feedbackArgRes = await commandWriting(
      req(`/api/opening/writing/${docB}`, "POST", {
        action: "record_feedback",
        expectedRevisionNumber: 2,
        targetBlockId: bBlock1,
        dimension: "argument",
        kind: "feedback",
        suggestionText: "论点可以更聚焦核心前提。",
      }),
      docCtx(docB),
    );
    expect(feedbackArgRes.status).toBe(200);

    // Edit A 稿 LATER than B 稿; checkpoint MUST stay pinned to B paragraph 2
    const patchA = await patchDocument(
      req(`/api/documents/${docA}`, "PATCH", {
        expectedRevisionNumber: 1,
        title: "跨分支独立写作",
        blocks: [
          { id: randomUUID(), type: "paragraph", content: { blockNoteContent: "A 稿较晚编辑的新版本。", props: null, children: [] } },
        ],
      }),
      idCtx(docA),
    );
    expect(patchA.status).toBe(200);

    const exactRecovery = await readOpeningWorkspaceActivityRecovery(f.sql, f.scope, { activityId });
    expect(exactRecovery).toMatchObject({
      kind: "writing",
      activityId,
      courseId: null,
      documentId: docB,
      variantLabel: "B 稿",
      focusBlockId: bBlock2,
      focusStatus: "exact",
    });

    // Delete paragraph 2 from B 稿 -> restore shows block_missing while keeping A & old feedback
    const deleteB2 = await patchDocument(
      req(`/api/documents/${docB}`, "PATCH", {
        expectedRevisionNumber: 2,
        title: "跨分支独立写作",
        blocks: [
          { id: bBlock1, type: "paragraph", content: { blockNoteContent: "B 稿第一段原句。", props: null, children: [] } },
        ],
      }),
      idCtx(docB),
    );
    expect(deleteB2.status).toBe(200);

    const missingRecovery = await readOpeningWorkspaceActivityRecovery(f.sql, f.scope, { activityId });
    expect(missingRecovery).toMatchObject({
      kind: "writing",
      documentId: docB,
      focusStatus: "block_missing",
    });

    const restoreRes = await getWriting(
      req(`/api/opening/writing/${docB}?focusBlock=${bBlock2}&activity=${activityId}`, "GET"),
      docCtx(docB),
    );
    expect(restoreRes.status).toBe(200);
    const restoreBody = (await restoreRes.json()) as WritingWorkspaceResponse;
    expect(restoreBody.initialized).toBe(true);
    if (restoreBody.initialized) {
      expect(restoreBody.workspace.focusRestore.status).toBe("block_missing");
      expect(restoreBody.workspace.variants.some((v) => v.documentId === docA && v.variantLabel === "A 稿")).toBe(true);
      expect(restoreBody.workspace.currentVariant.assistanceRecords).toHaveLength(1);
      expect(restoreBody.workspace.currentVariant.assistanceRecords[0]?.dimension).toBe("argument");
    }

    // Record language polish suggestion and adopt 1 sentence
    const feedbackLangRes = await commandWriting(
      req(`/api/opening/writing/${docB}`, "POST", {
        action: "record_feedback",
        expectedRevisionNumber: 3,
        targetBlockId: bBlock1,
        dimension: "language",
        kind: "polish_suggestion",
        suggestionText: "B 稿第一段凝练表达。",
      }),
      docCtx(docB),
    );
    expect(feedbackLangRes.status).toBe(200);
    const langView = (await feedbackLangRes.json()) as { workspace: WritingWorkspaceView };
    const polishId = langView.workspace.currentVariant.assistanceRecords.find(
      (r) => r.dimension === "language" && r.kind === "polish_suggestion",
    )!.id;

    const adoptRes = await commandWriting(
      req(`/api/opening/writing/${docB}`, "POST", {
        action: "adopt_suggestion",
        expectedRevisionNumber: 3,
        assistanceId: polishId,
        targetBlockId: bBlock1,
        replacementText: "B 稿第一段凝练表达。",
        activityId,
      }),
      docCtx(docB),
    );
    expect(adoptRes.status).toBe(200);
    const adoptBody = (await adoptRes.json()) as {
      workspace: WritingWorkspaceView;
      outcome: CourselessActivityOutcome;
    };
    expect(adoptBody.outcome).toEqual({
      activityId,
      courseId: null,
      documentId: docB,
      revisionNumber: 4,
      assistance: "revealed",
      adoptedPolishCount: 1,
      keptAsPreferred: true,
      evidenceVerdict: "MASTERY_NOT_ESTABLISHED",
    });

    const [obsCountRow] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM opening_learning_observations
      WHERE workspace_id = ${f.scope.workspaceId}
    `;
    expect(obsCountRow?.count).toBe(0);
  });
});
