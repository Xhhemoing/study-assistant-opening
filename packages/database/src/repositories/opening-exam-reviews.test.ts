import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { ExamWorkReviewInput, Scope } from "@aistudy/contracts";
import { createOpeningExamReviewsRepository } from "./opening-exam-reviews";

const scope: Scope = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  ownerUserId: "22222222-2222-4222-8222-222222222222",
};
const sprintId = "33333333-3333-4333-8333-333333333333";
const courseId = "44444444-4444-4444-8444-444444444444";
const workId = "55555555-5555-4555-8555-555555555555";
const referenceId = "66666666-6666-4666-8666-666666666666";
const reviewId = "77777777-7777-4777-8777-777777777777";
const packSourceId = "88888888-8888-4888-8888-888888888888";

const input: ExamWorkReviewInput = {
  clientKey: "review-key-12345678",
  sourceItemId: "worksheet-1",
  workSourceId: workId,
  workSourceVersion: 1,
  referenceSourceId: referenceId,
  referenceSourceVersion: 1,
  answerText: "My derivation",
};

const pack = {
  id: "review-fixture", version: "1", title: "Review", description: "Fixture",
  topics: [{ id: "limits", title: "Limits" }],
  lessons: [{ id: "lesson", topicId: "limits", title: "Limits", summary: "Review",
    steps: ["Check"], workedExample: "Example", pitfalls: [] }],
  questions: [{ id: "question", topicId: "limits", skillId: "limit-rules", familyId: "family", lessonId: "lesson",
    pool: "training", difficulty: "foundation", prompt: "Prompt",
    options: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
    answer: "a", explanation: "Exp", hint: "Hint", estimatedMinutes: 2 }],
  sourceItems: [{ id: "worksheet-1", topicId: "limits", label: "Exercise 1", sourceTitle: "Worksheet.pdf", sourcePage: 2,
    kind: "exercise", suggestedDay: 1, skills: ["limit-rules"] }],
  weekPlan: [], limitations: ["Practice only"],
};

const state = {
  version: 1,
  startedAt: "2026-10-17T00:00:00.000Z",
  examDate: null,
  dailyMinutes: 60,
  runs: [],
  attempts: [],
  sourceRecords: [],
  lessonExposures: [],
};

const binding = {
  courseId,
  milestoneId: null,
  packSourceId,
  boundAt: "2026-10-17T00:00:00.000Z",
  skills: [],
  materials: [{ sourceTitle: "Worksheet.pdf", sourceId: referenceId, sourceVersion: 1 }],
};

function makeFakeSql(options: {
  existingStatus?: string;
  isStale: boolean;
  ledgerRows: Array<Record<string, unknown>>;
  matchByClientKey?: boolean;
  leaseTimestamp?: string;
  reviewMissing?: boolean;
}) {
  let currentStatus = options.existingStatus ?? "pending";
  let currentLease = options.leaseTimestamp ?? "2026-10-17 00:00:00.000000+00";
  let insertedRow: Record<string, unknown> | null = null;
  const matchByClientKey = options.matchByClientKey ?? true;
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const makeReviewRow = (id: string, status: string, clientKey: string) => ({
    id,
    sprint_id: sprintId,
    workspace_id: scope.workspaceId,
    owner_user_id: scope.ownerUserId,
    source_item_id: input.sourceItemId,
    work_source_id: workId,
    work_source_version: 1,
    reference_source_id: referenceId,
    reference_source_version: 1,
    answer_text: input.answerText,
    client_key: clientKey,
    intent: { ...input, clientKey },
    status,
    proposal: null,
    model_label: null,
    privacy_epoch: 1,
    created_at: new Date("2026-10-17T00:00:00.000Z"),
    updated_at: new Date("2026-10-17T00:00:00.000Z"),
    is_stale: options.isStale,
  });
  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (strings.length === 1 && query === "") return { __fragment: "" };
    if (query.startsWith("AND ")) return { __fragment: query, values };
    calls.push({ query, values });
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId, privacy_epoch: 1 }]);
    if (query.includes("FROM opening_exam_sprints s JOIN opening_exam_bindings")) {
      return Promise.resolve([{ id: sprintId, pack_snapshot: pack, state, binding }]);
    }
    if (query.includes("FROM courses WHERE")) return Promise.resolve([{ id: courseId }]);
    if (query.includes("FROM opening_sources s JOIN opening_source_versions")) return Promise.resolve([{ id: workId }]);
    if (query.includes("SELECT version FROM opening_sources")) return Promise.resolve([{ version: 1 }]);
    if (query.includes("SELECT mime FROM opening_sources")) return Promise.resolve([{ mime: "image/png" }]);
    if (query.includes("FROM opening_source_chunks")) return Promise.resolve([{ "?column?": 1 }]);
    if (query.includes("FROM opening_budget_reservations")) return Promise.resolve(options.ledgerRows);
    if (query.includes("UPDATE opening_exam_reviews SET status='unknown'")) {
      currentStatus = "unknown";
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status='failed'")) {
      currentStatus = "failed";
      currentLease = "2026-10-17 00:02:00.000001+00";
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status='ready'")) {
      if (currentStatus === "pending" || currentStatus === "unknown") {
        currentStatus = "ready";
      }
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status=?")) {
      currentStatus = String(values[0]);
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET updated_at=GREATEST")) {
      currentLease = "2026-10-17 00:02:00.123456+00";
      return Promise.resolve([{ lease_updated_at: currentLease }]);
    }
    if (query.includes("INSERT INTO opening_exam_reviews")) {
      const newId = String(values[0]);
      const newKey = String(values[10]);
      insertedRow = makeReviewRow(newId, "pending", newKey);
      return Promise.resolve([{ lease_updated_at: "2026-10-17 00:03:00.654321+00" }]);
    }
    if (query.includes("SELECT id FROM opening_exam_reviews") && query.includes("AND status='pending'")) {
      const leaseFrag = values.find((v): v is { __fragment: string; values?: unknown[] } =>
        Boolean(v && typeof v === "object" && "__fragment" in v && String((v as { __fragment: string }).__fragment).includes("updated_at")));
      const expectedLease = leaseFrag?.values?.[0];
      const matches = currentStatus === "pending" && (!expectedLease || expectedLease === currentLease);
      return Promise.resolve(matches ? [{ id: reviewId }] : []);
    }
    if (query.includes("FROM opening_exam_reviews")) {
      if (options.reviewMissing) return Promise.resolve([]);
      if (query.includes("AND client_key=?") && !matchByClientKey) return Promise.resolve([]);
      if (query.includes("WHERE id=?") && insertedRow && values[0] === insertedRow.id) {
        return Promise.resolve([insertedRow]);
      }
      return Promise.resolve([makeReviewRow(reviewId, currentStatus, input.clientKey)]);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(exec, {
    json: (value: unknown) => value,
    begin: async <T>(fn: (tx: unknown) => Promise<T>) => fn(sql),
  }) as unknown as Sql;
  return { sql, calls, getStatus: () => currentStatus, getLease: () => currentLease };
}

describe("opening-exam-reviews stale pending reconciliation and fail guards", () => {
  it("keeps fresh pending reviews non-reclaimable (reusedUnresolved: true) without querying the budget ledger", async () => {
    const f = makeFakeSql({ isStale: false, ledgerRows: [] });
    const ctx = await createOpeningExamReviewsRepository(f.sql).begin(scope, input);
    expect(ctx.reusedUnresolved).toBe(true);
    expect(ctx.executionUpdatedAt).toBeUndefined();
    expect(f.calls.some(c => c.query.includes("opening_budget_reservations"))).toBe(false);
  });

  it("reclaims a stale pending review when opening_budget_reservations has no row and returns exact lease_updated_at", async () => {
    const f = makeFakeSql({ isStale: true, ledgerRows: [] });
    const ctx = await createOpeningExamReviewsRepository(f.sql).begin(scope, input);
    expect(ctx.reusedUnresolved).toBeUndefined();
    expect(ctx.executionUpdatedAt).toBe("2026-10-17 00:02:00.123456+00");
    expect(f.calls.some(c => c.query.includes("UPDATE opening_exam_reviews SET updated_at=GREATEST"))).toBe(true);
  });

  it("transitions a stale pending review with an active/billed reservation to unknown, locks ledger FOR UPDATE, and preserves lease updated_at", async () => {
    const f = makeFakeSql({
      isStale: true,
      ledgerRows: [{ state: "reserved", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const ctx = await createOpeningExamReviewsRepository(f.sql).begin(scope, input);
    expect(ctx.review.status).toBe("unknown");
    expect(ctx.reusedUnresolved).toBe(true);
    expect(ctx.executionUpdatedAt).toBeUndefined();
    expect(f.getStatus()).toBe("unknown");
    const ledgerQuery = f.calls.find(c => c.query.includes("FROM opening_budget_reservations"));
    expect(ledgerQuery?.query).toContain("FOR UPDATE");
    const unknownUpdate = f.calls.find(c => c.query.includes("SET status='unknown'"));
    expect(unknownUpdate?.query).not.toContain("updated_at=");
  });

  it("keeps fresh, billed, and backup-restored (0 ledger rows) unknown reviews non-billable, and recovers stale unknown ONLY with positive released_only receipt", async () => {
    const fresh = makeFakeSql({ existingStatus: "unknown", isStale: false, ledgerRows: [] });
    const freshCtx = await createOpeningExamReviewsRepository(fresh.sql).begin(scope, input);
    expect(freshCtx.review.status).toBe("unknown");
    expect(freshCtx.reusedUnresolved).toBe(true);
    expect(fresh.calls.some(c => c.query.includes("opening_budget_reservations"))).toBe(false);

    // Backup v2 restores in-flight reviews as status='unknown' without opening_budget_reservations.
    // Absence of ledger rows is NOT proof of zero spend: both same-key and fresh-key retries stay unknown.
    const backupRestoredSameKey = makeFakeSql({ existingStatus: "unknown", isStale: true, ledgerRows: [] });
    const backupSameCtx = await createOpeningExamReviewsRepository(backupRestoredSameKey.sql).begin(scope, input);
    expect(backupSameCtx.review.status).toBe("unknown");
    expect(backupSameCtx.reusedUnresolved).toBe(true);
    expect(backupSameCtx.executionUpdatedAt).toBeUndefined();
    expect(backupRestoredSameKey.getStatus()).toBe("unknown");

    const backupRestoredFreshKey = makeFakeSql({ existingStatus: "unknown", isStale: true, matchByClientKey: false, ledgerRows: [] });
    const backupFreshCtx = await createOpeningExamReviewsRepository(backupRestoredFreshKey.sql).begin(scope, {
      ...input,
      clientKey: "review-key-after-backup-restore-1",
    });
    expect(backupFreshCtx.review.id).toBe(reviewId);
    expect(backupFreshCtx.review.status).toBe("unknown");
    expect(backupFreshCtx.reusedUnresolved).toBe(true);
    expect(backupFreshCtx.executionUpdatedAt).toBeUndefined();
    expect(backupRestoredFreshKey.getStatus()).toBe("unknown");

    const staleBilled = makeFakeSql({
      existingStatus: "unknown",
      isStale: true,
      ledgerRows: [{ state: "completed", release_reason: null, outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const staleBilledCtx = await createOpeningExamReviewsRepository(staleBilled.sql).begin(scope, input);
    expect(staleBilledCtx.review.status).toBe("unknown");
    expect(staleBilledCtx.reusedUnresolved).toBe(true);

    const staleReleased = makeFakeSql({
      existingStatus: "unknown",
      isStale: true,
      ledgerRows: [{ state: "released", release_reason: "not_sent", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const staleReleasedCtx = await createOpeningExamReviewsRepository(staleReleased.sql).begin(scope, input);
    expect(staleReleasedCtx.review.status).toBe("failed");
    expect(staleReleasedCtx.reusedUnresolved).toBeUndefined();
    expect(staleReleased.getStatus()).toBe("failed");

    const staleReleasedFreshKey = makeFakeSql({
      existingStatus: "unknown",
      isStale: true,
      matchByClientKey: false,
      ledgerRows: [{ state: "released", release_reason: "not_sent", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const freshAfterUnknown = await createOpeningExamReviewsRepository(staleReleasedFreshKey.sql).begin(scope, {
      ...input,
      clientKey: "review-key-after-unknown-999",
    });
    expect(staleReleasedFreshKey.getStatus()).toBe("failed");
    expect(freshAfterUnknown.review.id).not.toBe(reviewId);
    expect(freshAfterUnknown.review.status).toBe("pending");
    expect(freshAfterUnknown.executionUpdatedAt).toBe("2026-10-17 00:03:00.654321+00");
  });

  it("fences assertCurrent after readContext with status='pending' and text-cast microsecond lease, and blocks complete() on failed reviews", async () => {
    const lease = "2026-10-17 00:00:00.123456+00";
    const f = makeFakeSql({ isStale: false, ledgerRows: [], leaseTimestamp: lease });
    const repo = createOpeningExamReviewsRepository(f.sql);
    await expect(repo.assertCurrent(scope, reviewId, lease)).resolves.toBeUndefined();
    const readIdx = f.calls.findIndex(c => c.query.startsWith("SELECT * FROM opening_exam_reviews"));
    const leaseIdx = f.calls.findIndex(c => c.query.includes("SELECT id FROM opening_exam_reviews") && c.query.includes("AND status='pending'"));
    expect(readIdx).toBeGreaterThanOrEqual(0);
    expect(leaseIdx).toBeGreaterThan(readIdx);
    const leaseFrag = f.calls[leaseIdx]!.values.find((v): v is { __fragment: string; values?: unknown[] } =>
      Boolean(v && typeof v === "object" && "__fragment" in v && String((v as { __fragment: string }).__fragment).includes("updated_at")));
    expect(leaseFrag?.__fragment).toBe("AND updated_at=(?::text)::timestamptz");
    expect(leaseFrag?.values).toEqual([lease]);

    await expect(repo.assertCurrent(scope, reviewId, "2026-10-17 00:01:00.123456+00")).rejects.toMatchObject({ code: "CONFLICT" });

    // Missing or foreign-workspace review must throw NOT_FOUND from readContext before status/lease CONFLICT.
    const foreignFake = makeFakeSql({ isStale: false, ledgerRows: [], reviewMissing: true });
    await expect(createOpeningExamReviewsRepository(foreignFake.sql).assertCurrent(scope, reviewId, lease)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(foreignFake.calls.some(c => c.query.includes("AND status='pending'"))).toBe(false);

    const failedFake = makeFakeSql({ existingStatus: "failed", isStale: false, ledgerRows: [], leaseTimestamp: lease });
    const failedRepo = createOpeningExamReviewsRepository(failedFake.sql);
    await expect(failedRepo.assertCurrent(scope, reviewId, lease)).rejects.toMatchObject({ code: "CONFLICT" });
    await failedRepo.complete(scope, reviewId, {
      transcription: "x=1", questionMatch: true, outcome: "correct",
      steps: [{ label: "Step 1", verdict: "correct", feedback: "ok" }], summary: "ok", errorCause: null,
    }, "model");
    const completeCall = failedFake.calls.find(c => c.query.includes("SET status='ready'"));
    expect(completeCall?.query).toContain("AND status IN ('pending', 'unknown')");
    expect(failedFake.getStatus()).toBe("failed");
  });

  it("transitions a stale pending review with an unconfirmed released reservation (missing release_reason) to unknown", async () => {
    const f = makeFakeSql({
      isStale: true,
      ledgerRows: [{ state: "released", release_reason: null, outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const ctx = await createOpeningExamReviewsRepository(f.sql).begin(scope, input);
    expect(ctx.review.status).toBe("unknown");
    expect(ctx.reusedUnresolved).toBe(true);
    expect(ctx.executionUpdatedAt).toBeUndefined();
    expect(f.getStatus()).toBe("unknown");
  });

  it("transitions a stale pending review with only a confirmed released reservation to failed without reclaiming", async () => {
    const f = makeFakeSql({
      isStale: true,
      ledgerRows: [{ state: "released", release_reason: "not_sent", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const ctx = await createOpeningExamReviewsRepository(f.sql).begin(scope, input);
    expect(ctx.review.status).toBe("failed");
    expect(ctx.reusedUnresolved).toBeUndefined();
    expect(ctx.executionUpdatedAt).toBeUndefined();
    expect(f.getStatus()).toBe("failed");
  });

  it("transitions a stale released-only pending review to failed and mints a fresh review on a new clientKey", async () => {
    const f = makeFakeSql({
      isStale: true,
      matchByClientKey: false,
      ledgerRows: [{ state: "released", release_reason: "not_sent", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const freshInput = { ...input, clientKey: "review-key-fresh-87654321" };
    const ctx = await createOpeningExamReviewsRepository(f.sql).begin(scope, freshInput);
    expect(f.getStatus()).toBe("failed");
    expect(ctx.review.id).not.toBe(reviewId);
    expect(ctx.review.status).toBe("pending");
    expect(ctx.reusedUnresolved).toBeUndefined();
    expect(ctx.executionUpdatedAt).toBe("2026-10-17 00:03:00.654321+00");
  });

  it("guards fail() with lease-scoped unknown->failed recovery, unleased pending-only guard, and budget ledger check", async () => {
    const f = makeFakeSql({ isStale: false, ledgerRows: [] });
    const repo = createOpeningExamReviewsRepository(f.sql);
    const getFrags = (call: { values: unknown[] }) => call.values.filter((v): v is { __fragment: string; values?: unknown[] } =>
      Boolean(v && typeof v === "object" && "__fragment" in v));

    await repo.fail(scope, reviewId, "failed", "2026-10-17 00:02:00.123456+00");
    const leasedFailedFrags = getFrags(f.calls.at(-1)!);
    expect(leasedFailedFrags.some(fr => fr.__fragment.includes("status='pending'")
      && fr.__fragment.includes("status='unknown'")
      && fr.__fragment.includes("EXISTS (")
      && fr.__fragment.includes("r.state='released'"))).toBe(true);
    expect(leasedFailedFrags.some(fr => fr.__fragment === "AND updated_at=(?::text)::timestamptz" && fr.values?.[0] === "2026-10-17 00:02:00.123456+00")).toBe(true);
    expect(leasedFailedFrags.some(fr => fr.__fragment.includes("opening_budget_reservations")
      && fr.__fragment.includes("b.release_reason IS NOT NULL")
      && fr.__fragment.includes("IS NOT TRUE"))).toBe(true);

    await repo.fail(scope, reviewId, "failed");
    const unleasedFailedFrags = getFrags(f.calls.at(-1)!);
    expect(unleasedFailedFrags.some(fr => fr.__fragment.includes("AND status='pending'"))).toBe(true);
    expect(unleasedFailedFrags.some(fr => fr.__fragment.includes("updated_at"))).toBe(false);
    expect(unleasedFailedFrags.some(fr => fr.__fragment.includes("opening_budget_reservations"))).toBe(true);

    await repo.fail(scope, reviewId, "unknown", "2026-10-17 00:02:00.123456+00");
    const unknownFrags = getFrags(f.calls.at(-1)!);
    expect(unknownFrags.some(fr => fr.__fragment.includes("AND status='pending'"))).toBe(true);
    expect(unknownFrags.some(fr => fr.__fragment === "AND updated_at=(?::text)::timestamptz" && fr.values?.[0] === "2026-10-17 00:02:00.123456+00")).toBe(true);
    expect(unknownFrags.some(fr => fr.__fragment.includes("opening_budget_reservations"))).toBe(false);
  });

  it("locks all legacy same-intent rows and never creates a new review when an older row is released_only but a sibling is unknown or ready", async () => {
    const idA = "77777777-7777-4777-8777-777777777771";
    const idB = "77777777-7777-4777-8777-777777777772";
    const runScenario = async (siblingStatus: "unknown" | "ready") => {
      const store = makeStatefulMultiRowSql({
        rows: [
          {
            id: idA,
            clientKey: `legacy-${idA}`,
            status: "pending",
            createdAt: "2026-10-17T00:00:00.000Z",
            lease: "2026-10-17 00:00:00.000000+00",
            isStale: true,
            ledgerRows: [{ state: "released", release_reason: "not_sent", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
          },
          {
            id: idB,
            clientKey: `legacy-${idB}`,
            status: siblingStatus,
            createdAt: "2026-10-17T00:00:05.000Z",
            lease: "2026-10-17 00:00:05.000000+00",
            isStale: true,
            ledgerRows: [{ state: "reserved", release_reason: null, outcome_unknown_at: new Date("2026-10-17T00:00:30Z"), pending_reconcile_cents: 0 }],
          },
        ],
      });
      const repo = createOpeningExamReviewsRepository(store.sql);
      const ctx = await repo.begin(scope, { ...input, clientKey: `fresh-key-${siblingStatus}` });
      expect(store.getRow(idA).status).toBe("failed");
      expect(store.getRow(idA).clientKey).not.toBe(`legacy-${idA}`);
      expect(store.getRow(idB).status).toBe(siblingStatus);
      expect(store.insertedCount()).toBe(0);
      expect(ctx.review.id).toBe(idB);
      expect(ctx.review.status).toBe(siblingStatus);
      expect(ctx.executionUpdatedAt).toBeUndefined();
      expect(ctx.reusedUnresolved).toBe(siblingStatus === "unknown" ? true : undefined);
      // Original key of superseded row A now resolves directly to B instead of failed A.
      const followUp = await repo.begin(scope, { ...input, clientKey: `legacy-${idA}` });
      expect(followUp.review.id).toBe(idB);
      expect(followUp.review.status).toBe(siblingStatus);
    };
    await runScenario("unknown");
    await runScenario("ready");
  });

  it("retires skipped stale rows (revoking their lease) and rebinds original + alias keys to chosen sibling B so repeated retries never regress to failed A", async () => {
    const idA = "77777777-7777-4777-8777-777777777781";
    const idB = "77777777-7777-4777-8777-777777777782";
    const keyA = "legacy-original-key-a";
    const aliasKeyA = "legacy-alias-key-a";
    const secondaryAliasKeyA = "legacy-alias-key-a2";
    const oldLeaseA = "2026-10-17 00:00:00.111111+00";

    const runRetry = async (
      entry: "original" | "alias",
      rowALedger: "none" | "released_only",
      siblingKind: "ready" | "unknown" | "fresh_pending",
    ) => {
      const siblingStatus = siblingKind === "fresh_pending" ? "pending" : siblingKind;
      const store = makeStatefulMultiRowSql({
        rows: [
          {
            id: idA,
            clientKey: keyA,
            status: "pending",
            createdAt: "2026-10-17T00:00:00.000Z",
            lease: oldLeaseA,
            isStale: true,
            ledgerRows: rowALedger === "released_only"
              ? [{ state: "released", release_reason: "not_sent", outcome_unknown_at: null, pending_reconcile_cents: 0 }]
              : [],
          },
          {
            id: idB,
            clientKey: "legacy-key-b",
            status: siblingStatus,
            createdAt: "2026-10-17T00:00:05.000Z",
            lease: "2026-10-17 00:00:05.222222+00",
            isStale: siblingKind !== "fresh_pending",
            ledgerRows: siblingKind === "unknown"
              ? [{ state: "reserved", release_reason: null, outcome_unknown_at: new Date("2026-10-17T00:00:30Z"), pending_reconcile_cents: 0 }]
              : [],
          },
        ],
        aliases: [
          { clientKey: aliasKeyA, reviewId: idA },
          { clientKey: secondaryAliasKeyA, reviewId: idA },
        ],
      });
      const repo = createOpeningExamReviewsRepository(store.sql);
      const retryKey = entry === "original" ? keyA : aliasKeyA;

      // Retry #1 returns B, retires A (even when A had ledger='none'), revokes A's lease, and rebinds A's keys -> B.
      const first = await repo.begin(scope, { ...input, clientKey: retryKey });
      expect(store.reclaimedCount()).toBe(0);
      expect(store.insertedCount()).toBe(0);
      expect(store.getRow(idA).status).toBe("failed");
      expect(store.getRow(idA).lease).not.toBe(oldLeaseA);
      expect(store.getRow(idA).clientKey).not.toBe(keyA);
      expect(first.review.id).toBe(idB);
      expect(first.review.status).toBe(siblingStatus);
      expect(first.executionUpdatedAt).toBeUndefined();
      expect(first.reusedUnresolved).toBe(siblingKind === "ready" ? undefined : true);

      // Paused worker for A MUST be fenced out by assertCurrent (both leased and unleased).
      await expect(repo.assertCurrent(scope, idA, oldLeaseA)).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(repo.assertCurrent(scope, idA)).rejects.toMatchObject({ code: "CONFLICT" });

      // Retry #2 (simulating lost HTTP response) with original keyA AND both aliases MUST STILL return B, never failed A.
      for (const replayKey of [keyA, aliasKeyA, secondaryAliasKeyA]) {
        const second = await repo.begin(scope, { ...input, clientKey: replayKey });
        expect(second.review.id).toBe(idB);
        expect(second.review.status).toBe(siblingStatus);
        expect(second.executionUpdatedAt).toBeUndefined();
        expect(second.reusedUnresolved).toBe(siblingKind === "ready" ? undefined : true);
      }

      // Mismatched intent on rebound keyA MUST still reject with CONFLICT.
      await expect(repo.begin(scope, { ...input, clientKey: keyA, answerText: "Different answer" }))
        .rejects.toMatchObject({ code: "CONFLICT" });
    };

    for (const entry of ["original", "alias"] as const) {
      for (const rowALedger of ["none", "released_only"] as const) {
        for (const siblingKind of ["ready", "unknown", "fresh_pending"] as const) {
          await runRetry(entry, rowALedger, siblingKind);
        }
      }
    }
  });

  it("rebinds superseded stale rows to the reclaimed winner and leaves genuinely failed solo reviews under their own key", async () => {
    const idA0 = "77777777-7777-4777-8777-777777777790";
    const idA1 = "77777777-7777-4777-8777-777777777791";
    const idA2 = "77777777-7777-4777-8777-777777777792";
    const store = makeStatefulMultiRowSql({
      rows: [
        {
          id: idA0,
          clientKey: "multi-stale-key-0",
          status: "unknown",
          createdAt: "2026-10-17T00:00:00.000Z",
          lease: "2026-10-17 00:00:00.000000+00",
          isStale: true,
          ledgerRows: [{ state: "released", release_reason: "not_sent", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
        },
        {
          id: idA1,
          clientKey: "multi-stale-key-1",
          status: "pending",
          createdAt: "2026-10-17T00:00:01.000Z",
          lease: "2026-10-17 00:00:01.000000+00",
          isStale: true,
          ledgerRows: [],
        },
        {
          id: idA2,
          clientKey: "multi-stale-key-2",
          status: "pending",
          createdAt: "2026-10-17T00:00:02.000Z",
          lease: "2026-10-17 00:00:02.000000+00",
          isStale: true,
          ledgerRows: [],
        },
      ],
      aliases: [{ clientKey: "multi-stale-alias-2", reviewId: idA2 }],
    });
    const repo = createOpeningExamReviewsRepository(store.sql);

    // Reclaiming via key-0 selects A1 (oldest reclaimable), retires A0 + A2, and rebinds their keys/aliases to A1.
    const reclaimed = await repo.begin(scope, { ...input, clientKey: "multi-stale-key-0" });
    expect(reclaimed.review.id).toBe(idA1);
    expect(reclaimed.review.status).toBe("pending");
    expect(reclaimed.executionUpdatedAt).toBeDefined();
    expect(store.getRow(idA0).status).toBe("failed");
    expect(store.getRow(idA2).status).toBe("failed");
    await expect(repo.assertCurrent(scope, idA2, "2026-10-17 00:00:02.000000+00")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(repo.assertCurrent(scope, idA1, reclaimed.executionUpdatedAt)).resolves.toBeUndefined();

    // Mark A1 ready, then verify retries with key-0, key-2, and alias-2 all replay ready A1.
    await repo.complete(scope, idA1, {
      transcription: "x=1", questionMatch: true, outcome: "correct",
      steps: [{ label: "Step 1", verdict: "correct", feedback: "ok" }], summary: "ok", errorCause: null,
    }, "vision-model");
    for (const key of ["multi-stale-key-0", "multi-stale-key-2", "multi-stale-alias-2"]) {
      const replay = await repo.begin(scope, { ...input, clientKey: key });
      expect(replay.review.id).toBe(idA1);
      expect(replay.review.status).toBe("ready");
    }

    // Solo genuinely failed review (no sibling B) keeps its original key and terminal failed receipt.
    const soloStore = makeStatefulMultiRowSql({
      rows: [
        {
          id: idA0,
          clientKey: "solo-failed-key-1",
          status: "failed",
          createdAt: "2026-10-17T00:00:00.000Z",
          lease: "2026-10-17 00:00:00.000000+00",
          isStale: true,
          ledgerRows: [],
        },
      ],
    });
    const soloRepo = createOpeningExamReviewsRepository(soloStore.sql);
    const solo1 = await soloRepo.begin(scope, { ...input, clientKey: "solo-failed-key-1" });
    const solo2 = await soloRepo.begin(scope, { ...input, clientKey: "solo-failed-key-1" });
    expect(solo1.review).toMatchObject({ id: idA0, status: "failed" });
    expect(solo2.review).toMatchObject({ id: idA0, status: "failed" });
    expect(soloStore.getRow(idA0).clientKey).toBe("solo-failed-key-1");
  });
});

function makeStatefulMultiRowSql(options: {
  rows: Array<{
    id: string;
    clientKey: string;
    status: "pending" | "ready" | "unknown" | "failed";
    createdAt: string;
    lease: string;
    isStale: boolean;
    ledgerRows: Array<Record<string, unknown>>;
  }>;
  aliases?: Array<{ clientKey: string; reviewId: string }>;
}) {
  const aliasPrefix = `exam-review-alias:v1:${"_".repeat(180)}:`;
  const readyProposal = {
    transcription: "x=1", questionMatch: true, outcome: "correct" as const,
    steps: [{ label: "Step 1", verdict: "correct" as const, feedback: "ok" }], summary: "ok", errorCause: null,
  };
  let leaseSeq = 1;
  let reclaimed = 0;
  let inserted = 0;
  const rowsById = new Map(options.rows.map(row => [row.id, {
    ...row,
    originalIntentKey: row.clientKey,
    proposal: row.status === "ready" ? readyProposal : null,
    modelLabel: row.status === "ready" ? "vision-model" : null,
  }]));
  const aliasesByFullKey = new Map<string, { id: string; sprintId: string; reviewId: string }>(
    (options.aliases ?? []).map((alias, idx) => [
      `${aliasPrefix}${alias.clientKey}`,
      { id: `alias-cmd-${idx + 1}`, sprintId, reviewId: alias.reviewId },
    ]),
  );
  const toDbRow = (r: ReturnType<typeof rowsById.get> & object) => ({
    id: r.id,
    sprint_id: sprintId,
    workspace_id: scope.workspaceId,
    owner_user_id: scope.ownerUserId,
    source_item_id: input.sourceItemId,
    work_source_id: workId,
    work_source_version: 1,
    reference_source_id: referenceId,
    reference_source_version: 1,
    answer_text: input.answerText,
    client_key: r.clientKey,
    intent: { ...input, clientKey: r.originalIntentKey },
    status: r.status,
    proposal: r.proposal,
    model_label: r.modelLabel,
    privacy_epoch: 1,
    created_at: new Date(r.createdAt),
    updated_at: new Date(r.createdAt),
    is_stale: r.isStale,
  });
  const nextLease = () => `2026-10-17 00:05:${String(leaseSeq++).padStart(2, "0")}.123456+00`;

  const exec = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (strings.length === 1 && query === "") return { __fragment: "" };
    if (query.startsWith("AND ") || query.startsWith("OR ")) return { __fragment: query, values };
    if (query.includes("FROM workspaces")) return Promise.resolve([{ id: scope.workspaceId, privacy_epoch: 1 }]);
    if (query.includes("FROM opening_exam_integration_commands")) {
      const fullKey = String(values[2]);
      const hit = aliasesByFullKey.get(fullKey);
      return Promise.resolve(hit ? [{ id: hit.id, sprint_id: hit.sprintId, intent: { reviewId: hit.reviewId } }] : []);
    }
    if (query.includes("INSERT INTO opening_exam_integration_commands")) {
      const cmdId = String(values[0]);
      const cmdSprintId = String(values[1]);
      const fullKey = String(values[2]);
      const aliasIntent = values[3] as { reviewId: string };
      aliasesByFullKey.set(fullKey, { id: cmdId, sprintId: cmdSprintId, reviewId: aliasIntent.reviewId });
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_integration_commands")) {
      const aliasIntent = values[0] as { reviewId: string };
      const prefix = String(values[2]);
      const oldReviewId = String(values[4]);
      for (const [fullKey, entry] of aliasesByFullKey.entries()) {
        if (fullKey.startsWith(prefix) && entry.reviewId === oldReviewId) {
          aliasesByFullKey.set(fullKey, { ...entry, reviewId: aliasIntent.reviewId });
        }
      }
      return Promise.resolve([]);
    }
    if (query.includes("FROM opening_exam_sprints s JOIN opening_exam_bindings")) {
      return Promise.resolve([{ id: sprintId, pack_snapshot: pack, state, binding }]);
    }
    if (query.includes("FROM courses WHERE")) return Promise.resolve([{ id: courseId }]);
    if (query.includes("FROM opening_sources s JOIN opening_source_versions")) return Promise.resolve([{ id: workId }]);
    if (query.includes("SELECT version FROM opening_sources")) return Promise.resolve([{ version: 1 }]);
    if (query.includes("SELECT mime FROM opening_sources")) return Promise.resolve([{ mime: "image/png" }]);
    if (query.includes("FROM opening_source_chunks")) return Promise.resolve([{ "?column?": 1 }]);
    if (query.includes("FROM opening_budget_reservations")) {
      const opId = String(values[1]);
      const ownerRow = [...rowsById.values()].find(r => `exam-review:${scope.workspaceId}:${r.id}` === opId);
      return Promise.resolve(ownerRow?.ledgerRows ?? []);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status='failed', client_key=?")) {
      const newKey = String(values[0]);
      const rowId = String(values[1]);
      const row = rowsById.get(rowId);
      if (row && (row.status === "pending" || row.status === "unknown")) {
        row.status = "failed";
        row.clientKey = newKey;
        row.lease = nextLease();
      }
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status='failed'")) {
      const rowId = String(values[0]);
      const row = rowsById.get(rowId);
      if (row && (row.status === "pending" || row.status === "unknown")) {
        row.status = "failed";
        row.lease = nextLease();
      }
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status='unknown'")) {
      const rowId = String(values[0]);
      const row = rowsById.get(rowId);
      if (row && row.status === "pending") row.status = "unknown";
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status='ready'")) {
      const proposalValue = values[0] as typeof readyProposal;
      const modelLabel = values[1] as string | null;
      const rowId = String(values[2]);
      const row = rowsById.get(rowId);
      if (row && (row.status === "pending" || row.status === "unknown")) {
        row.status = "ready";
        row.proposal = proposalValue;
        row.modelLabel = modelLabel;
        row.lease = nextLease();
      }
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET updated_at=GREATEST")) {
      reclaimed++;
      const rowId = String(values[0]);
      const row = rowsById.get(rowId);
      const lease = nextLease();
      if (row && row.status === "pending") {
        row.lease = lease;
        row.isStale = false;
        return Promise.resolve([{ lease_updated_at: lease }]);
      }
      return Promise.resolve([]);
    }
    if (query.includes("INSERT INTO opening_exam_reviews")) {
      inserted++;
      return Promise.resolve([{ lease_updated_at: nextLease() }]);
    }
    if (query.includes("SELECT id FROM opening_exam_reviews") && query.includes("AND status='pending'")) {
      const rowId = String(values[0]);
      const row = rowsById.get(rowId);
      const leaseFrag = values.find((v): v is { __fragment: string; values?: unknown[] } =>
        Boolean(v && typeof v === "object" && "__fragment" in v && String((v as { __fragment: string }).__fragment).includes("updated_at")));
      const expectedLease = leaseFrag?.values?.[0];
      const matches = Boolean(row && row.status === "pending" && (!expectedLease || expectedLease === row.lease));
      return Promise.resolve(matches ? [{ id: rowId }] : []);
    }
    if (query.includes("FROM opening_exam_reviews")) {
      if (query.includes("WHERE id=?")) {
        const targetId = String(values[0]);
        const row = rowsById.get(targetId);
        return Promise.resolve(row ? [toDbRow(row)] : []);
      }
      expect(query).not.toContain("LIMIT 1");
      expect(query).toContain("ORDER BY id ASC FOR UPDATE");
      const reqClientKey = String(values[3]);
      const aliasFrag = values[4] as { __fragment?: string; values?: unknown[] } | undefined;
      const aliasReviewId = aliasFrag?.values?.[0] ? String(aliasFrag.values[0]) : null;
      const reqAnswerText = String(values[11]);
      const matched = [...rowsById.values()]
        .filter(r =>
          r.clientKey === reqClientKey
          || (aliasReviewId !== null && r.id === aliasReviewId)
          || (input.answerText === reqAnswerText && (r.status === "pending" || r.status === "unknown" || r.status === "ready")))
        .sort((a, b) => a.id.localeCompare(b.id))
        .map(toDbRow);
      return Promise.resolve(matched);
    }
    return Promise.resolve([]);
  };
  const sql = Object.assign(exec, {
    json: (value: unknown) => value,
    begin: async <T>(fn: (tx: unknown) => Promise<T>) => fn(sql),
  }) as unknown as Sql;
  return {
    sql,
    getRow: (id: string) => rowsById.get(id)!,
    reclaimedCount: () => reclaimed,
    insertedCount: () => inserted,
  };
}
