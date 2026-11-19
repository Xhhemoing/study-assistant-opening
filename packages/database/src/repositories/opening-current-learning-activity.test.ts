import { expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import {
  readOpeningCurrentLearningActivity,
  readOpeningCurrentLearningRecovery,
  readOpeningTaskTeachingBinding,
  readOpeningWorkspaceActivityRecovery,
} from "./opening-current-learning-activity";
const scope = { workspaceId: "workspace", ownerUserId: "owner" };
const row = (id: string, extra = {}) => ({ id, course_id: "course", status: "active", updated_at: "2026-11-01T00:00:00Z", content_version: 1, intent_kind: "topic", create_intent: {}, ...extra });
function db(...results: unknown[][]) {
  return vi.fn((strings: TemplateStringsArray) => strings.join("").trimStart().startsWith("SELECT")
    ? Promise.resolve(results.shift() ?? []) : {}) as unknown as Sql;
}
function queries(sql: Sql): string[] {
  return (sql as unknown as ReturnType<typeof vi.fn>).mock.calls
    .map(call => (call[0] as TemplateStringsArray).join(" "));
}
it("selects descending ids and returns identity only", async () => {
  const sql = db([row("a"), row("z")]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course")).toEqual({ activityId: "z", courseId: "course", sessionId: null });
});
it("rejects missing session/task references without querying latest", async () => {
  for (const reference of [{ sessionId: "missing" }, { taskId: "missing" }]) {
    const sql = db([]);
    expect(await readOpeningCurrentLearningActivity(sql, scope, "course", reference)).toBeNull();
    expect(sql).toHaveBeenCalledTimes(1);
  }
});
it("rejects ambiguous persisted task bindings without substituting latest", async () => {
  const sql = db([{ id: "task", activity_id: "a" }, { id: "task", activity_id: "b" }]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toBeNull();
  expect(sql).toHaveBeenCalledTimes(1);
});
it("falls back within the course only when a valid task has no persisted activity binding", async () => {
  const sql = db([{ id: "task", activity_id: null }], [row("current")]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toMatchObject({ activityId: "current" });
});
it("requires agreement between explicit activity and persisted session", async () => {
  const sql = db([{ activity_id: "b" }], [row("a"), row("b", { session_id: "session" })]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { activityId: "a", sessionId: "session" })).toBeNull();
});
it("uses the older persisted task target rather than a newer candidate", async () => {
  const sql = db([{ id: "task", activity_id: "old", course_id: "course", status: "active", create_intent: {} }], [row("old"), row("new", { updated_at: "2026-11-02T00:00:00Z" })]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toMatchObject({ activityId: "old" });
});
it("does not treat a missing persisted onboarding target as an unbound task", async () => {
  const sql = db([{ id: "task", activity_id: null, origin: "manual", client_key: "first-learning-activity:missing" }], [row("latest")]);
  expect(await readOpeningCurrentLearningActivity(sql, scope, "course", { taskId: "task" })).toBeNull();
});
it.each(["branch", "cycle", "multiple-live", "foreign-parent", "skipped"])("rejects malformed continuation lineage %s", async kind => {
  const root = { activity_id: "root", course_id: "course", status: "completed", activity_client_key: "task:task", create_intent: { source: "task", taskId: "task" } };
  const child = { activity_id: "child", course_id: "course", status: "active", activity_client_key: "task:task:next:root", create_intent: { source: "task", taskId: "task", continuesActivityId: "root" } };
  const rows = kind === "branch" ? [root, child, { ...child, activity_id: "other" }]
    : kind === "cycle" ? [{ ...root, create_intent: { ...root.create_intent, continuesActivityId: "child" } }, child]
    : kind === "multiple-live" ? [{ ...root, status: "active" }, child]
    : kind === "foreign-parent" ? [root, { ...child, create_intent: { ...child.create_intent, continuesActivityId: "foreign" } }]
    : [root, { ...child, status: "skipped" }];
  expect((await readOpeningTaskTeachingBinding(db(rows), scope, "course", "task")).kind).toBe("unavailable");
});
it("rejects content-zero legacy placeholders but preserves static lesson sessions", async () => {
  const shell = row("shell", { intent_kind: "course_continue", content_version: 0 });
  expect(await readOpeningCurrentLearningActivity(db([shell]), scope, "course")).toBeNull();
  const span = { ...shell, id: "span", create_intent: { protocol: "span-lesson-v1" }, session_id: "session" };
  expect(await readOpeningCurrentLearningActivity(db([span]), scope, "course")).toMatchObject({ activityId: "span", sessionId: "session" });
  expect(await readOpeningCurrentLearningActivity(db([{ ...span, session_id: null }]), scope, "course")).toBeNull();
});
it("prefers live recovery candidates and falls back only to decision-bearing activities", async () => {
  const selectCount = (sql: Sql) => queries(sql).filter(query => query.trimStart().startsWith("SELECT")).length;
  const liveSql = db([row("live")]);
  expect(await readOpeningCurrentLearningRecovery(liveSql, scope)).toEqual({ activityId: "live", courseId: "course", sessionId: null });
  expect(selectCount(liveSql)).toBe(1);
  expect(queries(liveSql).some(query => query.includes("'proposed','accepted','in_progress'") && query.includes("rt.status NOT IN ('done','skipped')"))).toBe(true);
  const fallbackSql = db([], [row("decided")]);
  expect(await readOpeningCurrentLearningRecovery(fallbackSql, scope)).toEqual({ activityId: "decided", courseId: "course", sessionId: null });
  expect(selectCount(fallbackSql)).toBe(2);
  expect(queries(fallbackSql).some(query => query.includes("a.create_intent->>'protocol'='span-lesson-v1' OR a.goal_json ? 'courseRoute'")
    && query.includes("opening_learning_decisions"))).toBe(true);
  expect(await readOpeningCurrentLearningRecovery(db([], []), scope)).toBeNull();
});
it("excludes card-session keys, cardReviewSession checkpoints, and legacy-course-continue keys in SQL candidates and sorts fractional timestamps", async () => {
  const whole = row("ffffffff-ffff-4fff-8fff-ffffffffffff", { updated_at: "2026-11-17T10:00:00Z" });
  const fractional = row("11111111-1111-4111-8111-111111111111", { updated_at: "2026-11-17T10:00:00.500Z" });
  const currentSql = db([whole, fractional]);
  expect(await readOpeningCurrentLearningActivity(currentSql, scope, "course")).toEqual({
    activityId: fractional.id, courseId: "course", sessionId: null,
  });
  const recoverySql = db([whole, fractional]);
  expect(await readOpeningCurrentLearningRecovery(recoverySql, scope)).toEqual({
    activityId: fractional.id, courseId: "course", sessionId: null,
  });
  for (const sql of [currentSql, recoverySql]) {
    const query = queries(sql).find(item => item.includes("FROM opening_teaching_activities a"));
    expect(query).toContain("a.client_key NOT LIKE 'card-session:%'");
    expect(query).toContain("NOT (COALESCE(a.checkpoint_json,'{}'::jsonb) ? 'cardReviewSession')");
    expect(query).toContain("a.client_key NOT LIKE 'legacy-course-continue:%'");
  }
});

it("recovers course-less writing workspace pinned to checkpoint variant and verifies block status", async () => {
  const workGroupId = "11111111-1111-4111-8111-111111111111";
  const docB = "22222222-2222-4222-8222-222222222222";
  const block2 = "33333333-3333-4333-8333-333333333333";
  const metaB = {
    workGroupId,
    variantLabel: "B 稿",
    parentDocumentId: workGroupId,
    parentRevisionNumber: 1,
    keptAsPreferred: true,
    focusBlockId: block2,
    assistanceRecords: [],
  };
  const writingRow = row("44444444-4444-4444-8444-444444444444", {
    course_id: null,
    updated_at: "2026-11-18T10:00:00Z",
    create_intent: { protocol: "writing-workspace-v1", workGroupId },
    checkpoint_json: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId,
        activeDocumentId: docB,
        activeVariantLabel: "B 稿",
        savedRevisionNumber: 2,
        focusBlockId: block2,
        updatedAt: "2026-11-18T10:00:00.000Z",
      },
    },
  });

  const exactSql = db(
    [writingRow],
    [{ id: docB, title: "论证草稿", current_revision_number: 3, has_meta: true, meta: metaB, focus_exists: true }],
  );
  expect(await readOpeningWorkspaceActivityRecovery(exactSql, scope)).toEqual({
    kind: "writing",
    activityId: writingRow.id,
    courseId: null,
    workGroupId,
    documentId: docB,
    variantLabel: "B 稿",
    savedRevisionNumber: 2,
    currentRevisionNumber: 3,
    focusBlockId: block2,
    focusStatus: "exact",
  });
  const sqlText = queries(exactSql).find(item => item.includes("FROM opening_teaching_activities a"))!;
  expect(sqlText).toContain("LEFT JOIN courses c ON c.id=a.course_id AND c.workspace_id=a.workspace_id");
  expect(sqlText).toContain("a.course_id IS NULL OR c.archived_at IS NULL");

  const missingBlockSql = db(
    [writingRow],
    [{ id: docB, title: "论证草稿", current_revision_number: 4, has_meta: true, meta: metaB, focus_exists: false }],
  );
  expect(await readOpeningWorkspaceActivityRecovery(missingBlockSql, scope)).toMatchObject({
    kind: "writing",
    documentId: docB,
    currentRevisionNumber: 4,
    focusBlockId: block2,
    focusStatus: "block_missing",
  });

  const noFocusRow = {
    ...writingRow,
    checkpoint_json: {
      writingWorkspace: { ...writingRow.checkpoint_json.writingWorkspace, focusBlockId: null },
    },
  };
  const noneSql = db(
    [noFocusRow],
    [{ id: docB, title: "论证草稿", current_revision_number: 2, has_meta: true, meta: { ...metaB, focusBlockId: null }, focus_exists: false }],
  );
  expect(await readOpeningWorkspaceActivityRecovery(noneSql, scope)).toMatchObject({
    kind: "writing",
    focusBlockId: null,
    focusStatus: "none",
  });
});

it("dispatches course recovery when course activity is newer or when writing doc is deleted", async () => {
  const workGroupId = "11111111-1111-4111-8111-111111111111";
  const docA = "22222222-2222-4222-8222-222222222222";
  const writingOld = row("44444444-4444-4444-8444-444444444444", {
    course_id: null,
    updated_at: "2026-11-18T09:00:00Z",
    create_intent: { protocol: "writing-workspace-v1", workGroupId },
    checkpoint_json: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId,
        activeDocumentId: docA,
        activeVariantLabel: "初稿",
        savedRevisionNumber: 1,
        focusBlockId: null,
        updatedAt: "2026-11-18T09:00:00.000Z",
      },
    },
  });
  const courseNew = row("55555555-5555-4555-8555-555555555555", {
    course_id: "course-1",
    updated_at: "2026-11-18T11:00:00Z",
    session_id: "sess-1",
  });

  expect(await readOpeningWorkspaceActivityRecovery(db([writingOld, courseNew]), scope)).toEqual({
    kind: "course",
    activityId: courseNew.id,
    courseId: "course-1",
    sessionId: "sess-1",
  });

  // If explicit reference points to a deleted writing document, never fall back to another activity.
  const deletedExplicitSql = db([writingOld], []);
  expect(await readOpeningWorkspaceActivityRecovery(deletedExplicitSql, scope, { activityId: writingOld.id })).toBeNull();

  // Without explicit reference, deleted writing doc falls through to remaining live course candidate.
  const deletedFallbackSql = db([writingOld, { ...courseNew, updated_at: "2026-11-18T08:00:00Z" }], []);
  expect(await readOpeningWorkspaceActivityRecovery(deletedFallbackSql, scope)).toEqual({
    kind: "course",
    activityId: courseNew.id,
    courseId: "course-1",
    sessionId: "sess-1",
  });
});

it("enforces writing target authorization and workGroup match across explicit and implicit workspace/course recovery without write side effects", async () => {
  const group1 = "11111111-1111-4111-8111-111111111111";
  const group2 = "99999999-9999-4999-8999-999999999999";
  const docB = "22222222-2222-4222-8222-222222222222";
  const courseFallbackRow = row("55555555-5555-4555-8555-555555555555", {
    course_id: "course-1",
    updated_at: "2026-11-18T08:00:00Z",
    session_id: "sess-live",
  });
  const writingCandidate = row("44444444-4444-4444-8444-444444444444", {
    course_id: "course-1",
    updated_at: "2026-11-18T12:00:00Z",
    create_intent: { protocol: "writing-workspace-v1", workGroupId: group1 },
    checkpoint_json: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId: group1,
        activeDocumentId: docB,
        activeVariantLabel: "B 绝密删稿",
        savedRevisionNumber: 2,
        focusBlockId: null,
        updatedAt: "2026-11-18T12:00:00.000Z",
      },
    },
  });

  // Explicit activityId whose document meta belongs to another workGroup -> null (never falls back)
  const mismatchedMetaExplicit = db(
    [writingCandidate],
    [{
      id: docB,
      title: "B 绝密删稿",
      current_revision_number: 2,
      has_meta: true,
      meta: {
        workGroupId: group2,
        variantLabel: "B 绝密删稿",
        parentDocumentId: null,
        parentRevisionNumber: null,
        keptAsPreferred: false,
        focusBlockId: null,
        assistanceRecords: [],
      },
      focus_exists: false,
    }],
  );
  expect(
    await readOpeningWorkspaceActivityRecovery(mismatchedMetaExplicit, scope, {
      activityId: writingCandidate.id,
    }),
  ).toBeNull();
  expect(queries(mismatchedMetaExplicit).some(q => /INSERT|UPDATE|DELETE/.test(q))).toBe(false);

  // Implicit recovery skips uninitialized/mismatched writing target and never leaks B's label/id;
  // also verify course-level candidate SQL carries the writing readability gate so courseFallback cannot resurrect it.
  const implicitSkipSql = db(
    [writingCandidate],
    [{ id: docB, title: "普通笔记", current_revision_number: 1, has_meta: false, meta: null, focus_exists: false }],
    [courseFallbackRow],
  );
  const recovered = await readOpeningWorkspaceActivityRecovery(implicitSkipSql, scope);
  expect(recovered).toEqual({
    kind: "course",
    activityId: courseFallbackRow.id,
    courseId: "course-1",
    sessionId: "sess-live",
  });
  expect(JSON.stringify(recovered)).not.toContain("B 绝密删稿");
  expect(JSON.stringify(recovered)).not.toContain(docB);
  expect(queries(implicitSkipSql).some(q => /INSERT|UPDATE|DELETE/.test(q))).toBe(false);

  // Verify SQL readability gate is embedded in both course candidates() and workspaceCandidates()
  const allFragments = queries(implicitSkipSql).join(" ");
  expect(allFragments).toContain("checkpoint_json->'writingWorkspace'->>'activeDocumentId'");
  expect(allFragments).toContain("wd.deleted_at IS NULL");

  // Malformed writing row (create_intent.workGroupId !== checkpoint.workGroupId) is treated as non-resumable placeholder
  const malformedIntentRow = {
    ...writingCandidate,
    checkpoint_json: {
      writingWorkspace: {
        ...writingCandidate.checkpoint_json.writingWorkspace,
        workGroupId: group2,
      },
    },
  };
  expect(
    await readOpeningWorkspaceActivityRecovery(db([malformedIntentRow]), scope, {
      activityId: malformedIntentRow.id,
    }),
  ).toBeNull();
});

it("skips malformed writing checkpoints and partial manuscript metadata in course/today selection while preserving ordinary writing-workgroup clientKey activities", async () => {
  const workGroupId = "11111111-1111-4111-8111-111111111111";
  const docPartial = "22222222-2222-4222-8222-222222222222";
  const readableOrdinary = row("33333333-3333-4333-8333-333333333333", {
    course_id: "course-1",
    updated_at: "2026-11-18T09:00:00Z",
    client_key: `writing-workgroup:${workGroupId}`,
    create_intent: { intentKind: "topic" },
    checkpoint_json: {},
  });
  const missingSavedRevisionRow = row("44444444-4444-4444-8444-444444444444", {
    course_id: "course-1",
    updated_at: "2026-11-18T12:00:00Z",
    create_intent: { protocol: "writing-workspace-v1", workGroupId },
    checkpoint_json: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId,
        activeDocumentId: docPartial,
        activeVariantLabel: "初稿",
        focusBlockId: null,
        updatedAt: "2026-11-18T12:00:00.000Z",
      },
    },
  });
  const partialMetaWritingRow = row("55555555-5555-4555-8555-555555555555", {
    course_id: "course-1",
    updated_at: "2026-11-18T11:00:00Z",
    create_intent: { protocol: "writing-workspace-v1", workGroupId },
    checkpoint_json: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId,
        activeDocumentId: docPartial,
        activeVariantLabel: "初稿",
        savedRevisionNumber: 1,
        focusBlockId: null,
        updatedAt: "2026-11-18T11:00:00.000Z",
      },
    },
  });
  const partialMetaDocLookup = [{
    id: docPartial,
    title: "残缺元数据稿件",
    current_revision_number: 1,
    has_meta: true,
    meta: { workGroupId },
    focus_exists: false,
  }];

  // Explicit lookups on either malformed writing row fail closed with null
  expect(
    await readOpeningCurrentLearningActivity(db([missingSavedRevisionRow]), scope, "course-1", {
      activityId: missingSavedRevisionRow.id,
    }),
  ).toBeNull();
  expect(
    await readOpeningCurrentLearningActivity(db([partialMetaWritingRow], partialMetaDocLookup), scope, "course-1", {
      activityId: partialMetaWritingRow.id,
    }),
  ).toBeNull();

  // Implicit course & cross-course Today selection skip both malformed writing rows and return the ordinary activity (even with writing-workgroup: clientKey)
  const courseFallbackSql = db([missingSavedRevisionRow, partialMetaWritingRow, readableOrdinary], partialMetaDocLookup);
  expect(await readOpeningCurrentLearningActivity(courseFallbackSql, scope, "course-1")).toEqual({
    activityId: readableOrdinary.id,
    courseId: "course-1",
    sessionId: null,
  });
  expect(queries(courseFallbackSql).join(" ")).not.toContain("writing-workgroup:%");

  const recoveryFallbackSql = db([missingSavedRevisionRow, partialMetaWritingRow, readableOrdinary], partialMetaDocLookup);
  expect(await readOpeningCurrentLearningRecovery(recoveryFallbackSql, scope)).toEqual({
    activityId: readableOrdinary.id,
    courseId: "course-1",
    sessionId: null,
  });

  const workspaceFallbackSql = db([missingSavedRevisionRow, partialMetaWritingRow, readableOrdinary], partialMetaDocLookup);
  expect(await readOpeningWorkspaceActivityRecovery(workspaceFallbackSql, scope)).toEqual({
    kind: "course",
    activityId: readableOrdinary.id,
    courseId: "course-1",
    sessionId: null,
  });
});

it("aligns SQL integer regex for JSONB decimal-zero numbers and enforces TS Zod second gate for bad updatedAt and malformed assistanceRecords", async () => {
  const workGroupId = "11111111-1111-4111-8111-111111111111";
  const docBadAssist = "22222222-2222-4222-8222-222222222222";
  const fallbackOrdinary = row("33333333-3333-4333-8333-333333333333", {
    course_id: "course-1",
    updated_at: "2026-11-18T08:00:00Z",
    create_intent: { intentKind: "topic" },
    checkpoint_json: {},
  });
  const badTimestampRow = row("44444444-4444-4444-8444-444444444444", {
    course_id: "course-1",
    updated_at: "2026-11-18T12:00:00Z",
    create_intent: { protocol: "writing-workspace-v1", workGroupId },
    checkpoint_json: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId,
        activeDocumentId: docBadAssist,
        activeVariantLabel: "初稿",
        savedRevisionNumber: 1,
        focusBlockId: null,
        updatedAt: "bad timestamp",
      },
    },
  });
  const badAssistRow = row("55555555-5555-4555-8555-555555555555", {
    course_id: "course-1",
    updated_at: "2026-11-18T11:00:00Z",
    create_intent: { protocol: "writing-workspace-v1", workGroupId },
    checkpoint_json: {
      writingWorkspace: {
        protocol: "writing-workspace-v1",
        workGroupId,
        activeDocumentId: docBadAssist,
        activeVariantLabel: "初稿",
        savedRevisionNumber: 1,
        focusBlockId: null,
        updatedAt: "2026-11-18T11:00:00.000Z",
      },
    },
  });
  const badAssistDocLookup = [{
    id: docBadAssist,
    title: "畸形辅助记录稿件",
    current_revision_number: 1,
    has_meta: true,
    meta: {
      workGroupId,
      variantLabel: "初稿",
      parentDocumentId: null,
      parentRevisionNumber: null,
      keptAsPreferred: false,
      focusBlockId: null,
      assistanceRecords: [{}],
    },
    focus_exists: false,
  }];

  // Explicit lookups fail closed for both bad timestamp and malformed assistanceRecords
  expect(
    await readOpeningCurrentLearningActivity(db([badTimestampRow]), scope, "course-1", {
      activityId: badTimestampRow.id,
    }),
  ).toBeNull();
  expect(
    await readOpeningCurrentLearningActivity(db([badAssistRow], badAssistDocLookup), scope, "course-1", {
      activityId: badAssistRow.id,
    }),
  ).toBeNull();
  expect(
    await readOpeningWorkspaceActivityRecovery(db([badTimestampRow]), scope, {
      activityId: badTimestampRow.id,
    }),
  ).toBeNull();
  expect(
    await readOpeningWorkspaceActivityRecovery(db([badAssistRow], badAssistDocLookup), scope, {
      activityId: badAssistRow.id,
    }),
  ).toBeNull();

  // Implicit lookups skip both malformed writing rows and verify relaxed SQL regex ^(0|[1-9][0-9]*)(\.0+)?$
  const courseSql = db([badTimestampRow, badAssistRow, fallbackOrdinary], badAssistDocLookup);
  expect(await readOpeningCurrentLearningActivity(courseSql, scope, "course-1")).toEqual({
    activityId: fallbackOrdinary.id,
    courseId: "course-1",
    sessionId: null,
  });
  expect(queries(courseSql).join(" ")).toContain("^(0|[1-9][0-9]*)(\\.0+)?$");

  const recoverySql = db([badTimestampRow, badAssistRow, fallbackOrdinary], badAssistDocLookup);
  expect(await readOpeningCurrentLearningRecovery(recoverySql, scope)).toEqual({
    activityId: fallbackOrdinary.id,
    courseId: "course-1",
    sessionId: null,
  });

  const workspaceSql = db([badTimestampRow, badAssistRow, fallbackOrdinary], badAssistDocLookup);
  expect(await readOpeningWorkspaceActivityRecovery(workspaceSql, scope)).toEqual({
    kind: "course",
    activityId: fallbackOrdinary.id,
    courseId: "course-1",
    sessionId: null,
  });
  expect(queries(workspaceSql).join(" ")).toContain("^(0|[1-9][0-9]*)(\\.0+)?$");
});
