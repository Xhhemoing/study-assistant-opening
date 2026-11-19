import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createLibraryRepository,
  createOpeningPrivacyRepository,
  readOpeningWorkspaceActivityRecovery,
} from "@aistudy/database";
import {
  WRITING_WORKSPACE_PROTOCOL,
  type CourselessActivityOutcome,
  type TeachingActivity,
  type WritingWorkspaceResponse,
  type WritingWorkspaceView,
} from "@aistudy/contracts";
import { createAuthRuntime } from "../../../apps/web/src/features/auth/service";
import { setAuthRuntimeForTests } from "../../../apps/web/src/server/runtime";
import { POST as startWriting } from "../../../apps/web/src/app/api/opening/writing/route";
import {
  GET as getWriting,
  POST as commandWriting,
} from "../../../apps/web/src/app/api/opening/writing/[documentId]/route";
import {
  GET as listTeachingActivities,
  POST as createTeachingActivity,
} from "../../../apps/web/src/app/api/opening/teaching-activities/route";
import { GET as getTeachingActivity } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/route";
import { PATCH as patchTeachingStatus } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/status/route";
import { POST as associateTeachingCourse } from "../../../apps/web/src/app/api/opening/teaching-activities/[id]/associate-course/route";
import { PATCH as patchDocument } from "../../../apps/web/src/app/api/documents/[id]/route";
import { backupRows } from "../opening-backup-records-fixture";
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

  it("enforces zero leakage across start replay, teaching-activity get/list, and recovery after deleting or revoking B, rejects cross-group activity on getView, and preserves AI-excluded readability", async () => {
    const library = createLibraryRepository(f.sql);
    const privacy = createOpeningPrivacyRepository(f.sql);
    const seeds = backupRows(f.sql, f.scope);

    const secretLabel = `B稿-绝密删稿-${randomUUID().slice(0, 8)}`;
    const secretSentence = `UNIQUE_B_PARAGRAPH_SENTENCE_CE1_${randomUUID()}`;
    const secretFeedback = `UNIQUE_B_FEEDBACK_TEXT_CE1_${randomUUID()}`;

    const startKey = `writing-ce1-${randomUUID()}`;
    const startBody = {
      clientKey: startKey,
      title: "权限收口主稿组",
      initialText: "第一段：初始论点。",
      variantLabel: "初稿",
      courseId: null,
    };
    const startRes = await startWriting(req("/api/opening/writing", "POST", startBody));
    expect(startRes.status).toBe(201);
    const started = (await startRes.json()) as WritingWorkspaceView;
    const docInit = started.currentDocumentId;
    const activityId = started.activityId!;

    // Create a second independent writing group to test explicit cross-group activityId rejection
    const otherStartRes = await startWriting(
      req("/api/opening/writing", "POST", {
        clientKey: `writing-other-group-${randomUUID()}`,
        title: "另一独立文稿组",
        initialText: "另一组正文。",
      }),
    );
    expect(otherStartRes.status).toBe(201);
    const otherGroup = (await otherStartRes.json()) as WritingWorkspaceView;
    const otherActivityId = otherGroup.activityId!;

    // Derive A 稿 and B 稿 in group 1
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
    const docA = ((await deriveARes.json()) as { workspace: WritingWorkspaceView }).workspace.currentDocumentId;

    const deriveBRes = await commandWriting(
      req(`/api/opening/writing/${docInit}`, "POST", {
        action: "derive_variant",
        expectedRevisionNumber: 1,
        variantLabel: secretLabel,
        activityId,
      }),
      docCtx(docInit),
    );
    expect(deriveBRes.status).toBe(200);
    const docB = ((await deriveBRes.json()) as { workspace: WritingWorkspaceView }).workspace.currentDocumentId;

    const bBlock1 = randomUUID();
    const bBlock2 = randomUUID();
    const patchB = await patchDocument(
      req(`/api/documents/${docB}`, "PATCH", {
        expectedRevisionNumber: 1,
        title: "权限收口主稿组",
        blocks: [
          { id: bBlock1, type: "paragraph", content: { blockNoteContent: "B 稿常规引子。", props: null, children: [] } },
          { id: bBlock2, type: "paragraph", content: { blockNoteContent: secretSentence, props: null, children: [] } },
        ],
      }),
      idCtx(docB),
    );
    expect(patchB.status).toBe(200);

    const feedbackRes = await commandWriting(
      req(`/api/opening/writing/${docB}`, "POST", {
        action: "record_feedback",
        expectedRevisionNumber: 2,
        targetBlockId: bBlock2,
        dimension: "argument",
        kind: "feedback",
        suggestionText: secretFeedback,
      }),
      docCtx(docB),
    );
    expect(feedbackRes.status).toBe(200);
    const feedbackView = ((await feedbackRes.json()) as { workspace: WritingWorkspaceView }).workspace;
    const assistanceId = feedbackView.currentVariant.assistanceRecords[0]!.id;

    const pinBRes = await commandWriting(
      req(`/api/opening/writing/${docB}`, "POST", {
        action: "save_checkpoint",
        activityId,
        focusBlockId: bBlock2,
        keptAsPreferred: true,
      }),
      docCtx(docB),
    );
    expect(pinBRes.status).toBe(200);

    // Counterexample 2: Explicit cross-group activityId on readable B -> 404 (never falls back to group 1 view)
    const wrongGroupViewRes = await getWriting(
      req(`/api/opening/writing/${docB}?activity=${otherActivityId}`, "GET"),
      docCtx(docB),
    );
    expect(wrongGroupViewRes.status).toBe(404);

    // Provenance AI-only exclusion (asset_deleted_at IS NULL) keeps personal reading & replay allowed
    const sourceId = await seeds.source();
    await f.sql`
      INSERT INTO opening_note_provenance (document_id, workspace_id, context_source_refs)
      VALUES (${docB}, ${f.scope.workspaceId}, ${f.sql.json([{ sourceId, sourceVersion: 1 }])})
    `;
    await privacy.recordExclusions(f.sql, f.scope, {
      sourceIds: [sourceId],
      memoryId: randomUUID(),
      deletedAt: new Date(),
    });

    const aiExcludedReplayRes = await startWriting(req("/api/opening/writing", "POST", startBody));
    expect(aiExcludedReplayRes.status).toBe(201);
    const aiExcludedGetActRes = await getTeachingActivity(
      req(`/api/opening/teaching-activities/${activityId}`, "GET"),
      idCtx(activityId),
    );
    expect(aiExcludedGetActRes.status).toBe(200);

    // Counterexample 1 (part 1: soft-deleting B)
    await library.softDeleteDocument({ workspaceId: f.scope.workspaceId, documentId: docB });

    const [docCountBefore] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM library_documents WHERE workspace_id = ${f.scope.workspaceId}
    `;
    const [actCountBefore] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM opening_teaching_activities WHERE workspace_id = ${f.scope.workspaceId}
    `;

    const assertZeroLeakOnUnreadableB = async () => {
      // (a1) Replay start with original clientKey & matching params -> 404
      const replayDeletedSame = await startWriting(req("/api/opening/writing", "POST", startBody));
      const replaySameText = await replayDeletedSame.text();
      expect(replayDeletedSame.status).toBe(404);

      // (a2) Replay start with original clientKey & mutated params -> 404 (must not probe 409)
      const replayDeletedDiff = await startWriting(
        req("/api/opening/writing", "POST", { ...startBody, title: "探测异参标题" }),
      );
      const replayDiffText = await replayDeletedDiff.text();
      expect(replayDeletedDiff.status).toBe(404);
      expect(replaySameText).toBe(replayDiffText);

      // (b) GET/PATCH/POST /api/opening/teaching-activities/[id] & same-key create replay -> 404 (zero checkpointJson / existence leak)
      const actDetailRes = await getTeachingActivity(
        req(`/api/opening/teaching-activities/${activityId}`, "GET"),
        idCtx(activityId),
      );
      const actDetailText = await actDetailRes.text();
      expect(actDetailRes.status).toBe(404);

      const patchStatusRes = await patchTeachingStatus(
        req(`/api/opening/teaching-activities/${activityId}/status`, "PATCH", { status: "paused" }),
        idCtx(activityId),
      );
      const patchStatusText = await patchStatusRes.text();
      expect(patchStatusRes.status).toBe(404);

      const associateRes = await associateTeachingCourse(
        req(`/api/opening/teaching-activities/${activityId}/associate-course`, "POST", { courseId: null }),
        idCtx(activityId),
      );
      const associateText = await associateRes.text();
      expect(associateRes.status).toBe(404);

      const genericReplaySameRes = await createTeachingActivity(
        req("/api/opening/teaching-activities", "POST", {
          clientKey: startKey,
          intentKind: "topic",
          intentSummary: "权限收口主稿组",
          createIntent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: docInit },
        }),
      );
      const genericReplaySameText = await genericReplaySameRes.text();
      expect(genericReplaySameRes.status).toBe(404);

      const genericReplayDiffRes = await createTeachingActivity(
        req("/api/opening/teaching-activities", "POST", {
          clientKey: startKey,
          intentKind: "question",
          intentSummary: "异参通用创建探测",
          createIntent: { intentKind: "question" },
        }),
      );
      const genericReplayDiffText = await genericReplayDiffRes.text();
      expect(genericReplayDiffRes.status).toBe(404);
      expect(genericReplaySameText).toBe(genericReplayDiffText);

      // (c) GET /api/opening/teaching-activities + Today recovery -> omits deleted B target
      const actListRes = await listTeachingActivities(req("/api/opening/teaching-activities", "GET"));
      const actListText = await actListRes.text();
      expect(actListRes.status).toBe(200);
      const listed = JSON.parse(actListText) as TeachingActivity[];
      expect(listed.some((item) => item.id === activityId)).toBe(false);
      expect(listed.some((item) => item.id === otherActivityId)).toBe(true);

      const explicitRecovery = await readOpeningWorkspaceActivityRecovery(f.sql, f.scope, { activityId });
      expect(explicitRecovery).toBeNull();
      const implicitRecovery = await readOpeningWorkspaceActivityRecovery(f.sql, f.scope);
      expect(implicitRecovery?.activityId).not.toBe(activityId);

      const combinedPayload = JSON.stringify({
        replaySameText,
        replayDiffText,
        actDetailText,
        patchStatusText,
        associateText,
        genericReplaySameText,
        genericReplayDiffText,
        actListText,
        explicitRecovery,
        implicitRecovery,
      });
      for (const forbidden of [docB, bBlock2, secretLabel, secretSentence, secretFeedback, assistanceId]) {
        expect(combinedPayload).not.toContain(forbidden);
      }

      // Surviving A 稿 remains accessible via its own document entry without exposing B
      const viewARes = await getWriting(req(`/api/opening/writing/${docA}`, "GET"), docCtx(docA));
      const viewAText = await viewARes.text();
      expect(viewARes.status).toBe(200);
      const viewABody = JSON.parse(viewAText) as WritingWorkspaceResponse;
      expect(viewABody.initialized).toBe(true);
      if (viewABody.initialized) {
        expect(viewABody.workspace.currentDocumentId).toBe(docA);
        expect(viewABody.workspace.variants.map((v) => v.documentId)).toEqual([docInit, docA]);
      }
      for (const forbidden of [docB, bBlock2, secretLabel, secretSentence, secretFeedback, assistanceId]) {
        expect(viewAText).not.toContain(forbidden);
      }
    };

    await assertZeroLeakOnUnreadableB();

    const [docCountAfterDeleteChecks] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM library_documents WHERE workspace_id = ${f.scope.workspaceId}
    `;
    const [actCountAfterDeleteChecks] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM opening_teaching_activities WHERE workspace_id = ${f.scope.workspaceId}
    `;
    expect(docCountAfterDeleteChecks?.count).toBe(docCountBefore?.count);
    expect(actCountAfterDeleteChecks?.count).toBe(actCountBefore?.count);

    // Counterexample 1 (part 2: restore B document, then permanently delete its provenance source asset)
    await library.restoreDocument({ workspaceId: f.scope.workspaceId, documentId: docB });
    const restoredCheck = await startWriting(req("/api/opening/writing", "POST", startBody));
    expect(restoredCheck.status).toBe(201);

    await f.sql`
      UPDATE opening_privacy_exclusions
      SET asset_deleted_at = now()
      WHERE workspace_id = ${f.scope.workspaceId} AND source_id = ${sourceId}
    `;
    await assertZeroLeakOnUnreadableB();

    // Counterexample 3: Concurrent replay vs soft-delete never returns variants omitting B with currentVariant carrying B's sentence,
    // and never creates replacement documents or activities.
    const raceKey = `writing-ce3-race-${randomUUID()}`;
    const raceBody = {
      clientKey: raceKey,
      title: "并发快照测试",
      initialText: "并发初稿段落。",
      variantLabel: "初稿",
      courseId: null,
    };
    const raceStartRes = await startWriting(req("/api/opening/writing", "POST", raceBody));
    expect(raceStartRes.status).toBe(201);
    const raceStarted = (await raceStartRes.json()) as WritingWorkspaceView;
    const raceActivityId = raceStarted.activityId!;

    const raceDeriveRes = await commandWriting(
      req(`/api/opening/writing/${raceStarted.currentDocumentId}`, "POST", {
        action: "derive_variant",
        expectedRevisionNumber: 1,
        variantLabel: "并发B稿",
        activityId: raceActivityId,
      }),
      docCtx(raceStarted.currentDocumentId),
    );
    expect(raceDeriveRes.status).toBe(200);
    const raceDerived = ((await raceDeriveRes.json()) as { workspace: WritingWorkspaceView }).workspace;
    const raceDocB = raceDerived.currentDocumentId;
    const raceBlockId = raceDerived.currentVariant.focusBlockId!;
    const raceSecretSentence = `CONCURRENT_RACE_SENTENCE_${randomUUID()}`;

    await patchDocument(
      req(`/api/documents/${raceDocB}`, "PATCH", {
        expectedRevisionNumber: 1,
        title: "并发快照测试",
        blocks: [
          { id: raceBlockId, type: "paragraph", content: { blockNoteContent: raceSecretSentence, props: null, children: [] } },
        ],
      }),
      idCtx(raceDocB),
    );
    await commandWriting(
      req(`/api/opening/writing/${raceDocB}`, "POST", {
        action: "record_feedback",
        expectedRevisionNumber: 2,
        targetBlockId: raceBlockId,
        dimension: "language",
        kind: "polish_suggestion",
        suggestionText: "并发润色建议",
      }),
      docCtx(raceDocB),
    );

    const [docsBeforeRace] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM library_documents WHERE workspace_id = ${f.scope.workspaceId}
    `;
    const [actsBeforeRace] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM opening_teaching_activities WHERE workspace_id = ${f.scope.workspaceId}
    `;

    const [concurrentReplayRes] = await Promise.all([
      startWriting(req("/api/opening/writing", "POST", raceBody)),
      library.softDeleteDocument({ workspaceId: f.scope.workspaceId, documentId: raceDocB }),
    ]);
    const concurrentText = await concurrentReplayRes.text();
    expect([201, 404]).toContain(concurrentReplayRes.status);
    if (concurrentReplayRes.status === 201) {
      const concurrentView = JSON.parse(concurrentText) as WritingWorkspaceView;
      expect(concurrentView.currentDocumentId).toBe(raceDocB);
      expect(concurrentView.variants.some((v) => v.documentId === raceDocB)).toBe(true);
    } else {
      expect(concurrentText).not.toContain(raceDocB);
      expect(concurrentText).not.toContain(raceSecretSentence);
    }

    const [docsAfterRace] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM library_documents WHERE workspace_id = ${f.scope.workspaceId}
    `;
    const [actsAfterRace] = await f.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM opening_teaching_activities WHERE workspace_id = ${f.scope.workspaceId}
    `;
    expect(docsAfterRace?.count).toBe(docsBeforeRace?.count);
    expect(actsAfterRace?.count).toBe(actsBeforeRace?.count);
  });

  it("preserves ordinary writing-workgroup clientKey activities, rejects empty-checkpoint writing-workspace-v1 activities on explicit getView, and opens manuscripts via both lowercase and uppercase UUIDs", async () => {
    // Ensure we obtain a manuscript whose UUID contains hex letters [a-f] so upper !== lower is guaranteed
    let started: WritingWorkspaceView | null = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const res = await startWriting(
        req("/api/opening/writing", "POST", {
          clientKey: `writing-round1-case-${attempt}-${randomUUID()}`,
          title: "大小写与空检查点回归",
          initialText: "第一段：用于验证大小写 UUID 与显式 activityId 校验。",
          variantLabel: "初稿",
          courseId: null,
        }),
      );
      expect(res.status).toBe(201);
      const candidate = (await res.json()) as WritingWorkspaceView;
      if (/[a-f]/.test(candidate.currentDocumentId)) {
        started = candidate;
        break;
      }
    }
    expect(started).not.toBeNull();
    const lowerDocId = started!.currentDocumentId;
    const upperDocId = lowerDocId.toUpperCase();
    expect(upperDocId).not.toBe(lowerDocId);
    const lowerActId = started!.activityId!;
    const upperActId = lowerActId.toUpperCase();
    const lowerBlockId = started!.currentVariant.focusBlockId!;
    const upperBlockId = lowerBlockId.toUpperCase();

    // GPT #4: Both lowercase and valid uppercase UUIDs open the exact same owned readable manuscript
    const lowerRes = await getWriting(
      req(`/api/opening/writing/${lowerDocId}?activity=${lowerActId}&block=${lowerBlockId}`, "GET"),
      docCtx(lowerDocId),
    );
    expect(lowerRes.status).toBe(200);
    const lowerBody = (await lowerRes.json()) as WritingWorkspaceResponse;

    const upperRes = await getWriting(
      req(`/api/opening/writing/${upperDocId}?activity=${upperActId}&block=${upperBlockId}`, "GET"),
      docCtx(upperDocId),
    );
    expect(upperRes.status).toBe(200);
    const upperBody = (await upperRes.json()) as WritingWorkspaceResponse;

    expect(upperBody).toEqual(lowerBody);
    expect(upperBody.initialized).toBe(true);
    if (upperBody.initialized) {
      expect(upperBody.workspace.currentDocumentId).toBe(lowerDocId);
      expect(upperBody.workspace.activityId).toBe(lowerActId);
      expect(upperBody.workspace.focusRestore).toEqual({ status: "exact", blockId: lowerBlockId });
    }

    // GPT #3: Generic teaching-activity create with protocol "writing-workspace-v1" + matching workGroupId persists {} checkpoint;
    // explicit ?activity= lookup on getView MUST reject with 404 (NOT_FOUND), and generic get/status/replay also return 404.
    const emptyCkptClientKey = `empty-writing-ckpt-${randomUUID()}`;
    const emptyCkptCreateRes = await createTeachingActivity(
      req("/api/opening/teaching-activities", "POST", {
        clientKey: emptyCkptClientKey,
        intentKind: "topic",
        intentSummary: "空检查点写作协议壳",
        createIntent: { protocol: WRITING_WORKSPACE_PROTOCOL, workGroupId: started!.workGroupId },
      }),
    );
    expect(emptyCkptCreateRes.status).toBe(201);
    const emptyCkptId = ((await emptyCkptCreateRes.json()) as TeachingActivity).id;

    const emptyCkptViewRes = await getWriting(
      req(`/api/opening/writing/${lowerDocId}?activity=${emptyCkptId}`, "GET"),
      docCtx(lowerDocId),
    );
    expect(emptyCkptViewRes.status).toBe(404);

    const emptyCkptActGetRes = await getTeachingActivity(
      req(`/api/opening/teaching-activities/${emptyCkptId}`, "GET"),
      idCtx(emptyCkptId),
    );
    expect(emptyCkptActGetRes.status).toBe(404);

    const emptyCkptPatchRes = await patchTeachingStatus(
      req(`/api/opening/teaching-activities/${emptyCkptId}/status`, "PATCH", { status: "paused" }),
      idCtx(emptyCkptId),
    );
    expect(emptyCkptPatchRes.status).toBe(404);

    // GPT #2: Ordinary teaching activity created with clientKey = "writing-workgroup:..." (non-writing protocol, no writingWorkspace checkpoint)
    // remains visible via GET /api/opening/teaching-activities/[id] and GET /api/opening/teaching-activities.
    const ordinaryClientKey = `writing-workgroup:${randomUUID()}`;
    const createOrdinaryRes = await createTeachingActivity(
      req("/api/opening/teaching-activities", "POST", {
        clientKey: ordinaryClientKey,
        intentKind: "topic",
        intentSummary: "普通教学活动（携带 writing-workgroup 前缀键）",
        createIntent: { intentKind: "topic" },
      }),
    );
    expect(createOrdinaryRes.status).toBe(201);
    const createdOrdinary = (await createOrdinaryRes.json()) as TeachingActivity;
    expect(createdOrdinary.clientKey).toBe(ordinaryClientKey);

    const getOrdinaryRes = await getTeachingActivity(
      req(`/api/opening/teaching-activities/${createdOrdinary.id}`, "GET"),
      idCtx(createdOrdinary.id),
    );
    expect(getOrdinaryRes.status).toBe(200);
    await expect(getOrdinaryRes.json()).resolves.toMatchObject({
      id: createdOrdinary.id,
      clientKey: ordinaryClientKey,
    });

    const listOrdinaryRes = await listTeachingActivities(req("/api/opening/teaching-activities", "GET"));
    expect(listOrdinaryRes.status).toBe(200);
    const listedAll = (await listOrdinaryRes.json()) as TeachingActivity[];
    expect(listedAll.some((item) => item.id === createdOrdinary.id)).toBe(true);
    expect(listedAll.some((item) => item.id === emptyCkptId)).toBe(false);
  });
});
