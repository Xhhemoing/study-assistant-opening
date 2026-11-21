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
}) {
  let currentStatus = options.existingStatus ?? "pending";
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
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET status=?")) {
      currentStatus = String(values[0]);
      return Promise.resolve([]);
    }
    if (query.includes("UPDATE opening_exam_reviews SET updated_at=GREATEST")) {
      return Promise.resolve([{ lease_updated_at: "2026-10-17 00:02:00.123456+00" }]);
    }
    if (query.includes("INSERT INTO opening_exam_reviews")) {
      const newId = String(values[0]);
      const newKey = String(values[10]);
      insertedRow = makeReviewRow(newId, "pending", newKey);
      return Promise.resolve([{ lease_updated_at: "2026-10-17 00:03:00.654321+00" }]);
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
  return { sql, calls, getStatus: () => currentStatus };
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

  it("transitions a stale pending review with an active/billed reservation to unknown and never reclaims execution", async () => {
    const f = makeFakeSql({
      isStale: true,
      ledgerRows: [{ state: "reserved", outcome_unknown_at: null, pending_reconcile_cents: 0 }],
    });
    const ctx = await createOpeningExamReviewsRepository(f.sql).begin(scope, input);
    expect(ctx.review.status).toBe("unknown");
    expect(ctx.reusedUnresolved).toBe(true);
    expect(ctx.executionUpdatedAt).toBeUndefined();
    expect(f.getStatus()).toBe("unknown");
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

  it("guards fail() with pending status, optional lease timestamp, and budget reservation check on failed", async () => {
    const f = makeFakeSql({ isStale: false, ledgerRows: [] });
    const repo = createOpeningExamReviewsRepository(f.sql);
    await repo.fail(scope, reviewId, "failed", "2026-10-17 00:02:00.123456+00");
    const failedCall = f.calls.at(-1)!;
    expect(failedCall.query).toContain("AND status='pending'");
    const failedFragments = failedCall.values.filter((v): v is { __fragment: string; values?: unknown[] } =>
      Boolean(v && typeof v === "object" && "__fragment" in v));
    expect(failedFragments.some(fr => fr.__fragment.includes("AND updated_at=?::timestamptz"))).toBe(true);
    expect(failedFragments.some(fr => fr.__fragment.includes("opening_budget_reservations"))).toBe(true);

    await repo.fail(scope, reviewId, "unknown", "2026-10-17 00:02:00.123456+00");
    const unknownCall = f.calls.at(-1)!;
    expect(unknownCall.query).toContain("AND status='pending'");
    const unknownFragments = unknownCall.values.filter((v): v is { __fragment: string; values?: unknown[] } =>
      Boolean(v && typeof v === "object" && "__fragment" in v));
    expect(unknownFragments.some(fr => fr.__fragment.includes("AND updated_at=?::timestamptz"))).toBe(true);
    expect(unknownFragments.some(fr => fr.__fragment.includes("opening_budget_reservations"))).toBe(false);
  });
});
