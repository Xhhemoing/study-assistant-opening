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

  it("keeps fresh unknown reviews non-recoverable without querying the budget ledger, and recovers stale released-only/none unknown reviews to failed", async () => {
    const fresh = makeFakeSql({ existingStatus: "unknown", isStale: false, ledgerRows: [] });
    const freshCtx = await createOpeningExamReviewsRepository(fresh.sql).begin(scope, input);
    expect(freshCtx.review.status).toBe("unknown");
    expect(freshCtx.reusedUnresolved).toBe(true);
    expect(fresh.calls.some(c => c.query.includes("opening_budget_reservations"))).toBe(false);

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

  it("fences assertCurrent with status='pending' and lease updated_at, and blocks complete() on failed reviews", async () => {
    const lease = "2026-10-17 00:00:00.000000+00";
    const f = makeFakeSql({ isStale: false, ledgerRows: [], leaseTimestamp: lease });
    const repo = createOpeningExamReviewsRepository(f.sql);
    await expect(repo.assertCurrent(scope, reviewId, lease)).resolves.toBeUndefined();
    await expect(repo.assertCurrent(scope, reviewId, "2026-10-17 00:01:00.000000+00")).rejects.toThrow("评阅状态已变化");

    const failedFake = makeFakeSql({ existingStatus: "failed", isStale: false, ledgerRows: [], leaseTimestamp: lease });
    const failedRepo = createOpeningExamReviewsRepository(failedFake.sql);
    await expect(failedRepo.assertCurrent(scope, reviewId, lease)).rejects.toThrow("评阅状态已变化");
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
    expect(leasedFailedFrags.some(fr => fr.__fragment.includes("AND status IN ('pending', 'unknown')"))).toBe(true);
    expect(leasedFailedFrags.some(fr => fr.__fragment.includes("AND updated_at=?::timestamptz"))).toBe(true);
    expect(leasedFailedFrags.some(fr => fr.__fragment.includes("opening_budget_reservations"))).toBe(true);

    await repo.fail(scope, reviewId, "failed");
    const unleasedFailedFrags = getFrags(f.calls.at(-1)!);
    expect(unleasedFailedFrags.some(fr => fr.__fragment.includes("AND status='pending'"))).toBe(true);
    expect(unleasedFailedFrags.some(fr => fr.__fragment.includes("updated_at"))).toBe(false);
    expect(unleasedFailedFrags.some(fr => fr.__fragment.includes("opening_budget_reservations"))).toBe(true);

    await repo.fail(scope, reviewId, "unknown", "2026-10-17 00:02:00.123456+00");
    const unknownFrags = getFrags(f.calls.at(-1)!);
    expect(unknownFrags.some(fr => fr.__fragment.includes("AND status='pending'"))).toBe(true);
    expect(unknownFrags.some(fr => fr.__fragment.includes("AND updated_at=?::timestamptz"))).toBe(true);
    expect(unknownFrags.some(fr => fr.__fragment.includes("opening_budget_reservations"))).toBe(false);
  });
});
