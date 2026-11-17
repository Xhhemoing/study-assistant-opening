import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GradingLedgerState } from "./opening-ai-grading-ledger";

const mocks = vi.hoisted(() => ({
  qualify: vi.fn(),
  ledger: vi.fn(),
  priorUnresolved: vi.fn(),
  candidateContext: vi.fn(),
  budget: vi.fn(),
}));
vi.mock("./opening-learning-facts", async original => ({
  ...(await original<typeof import("./opening-learning-facts")>()),
  lockLearningOwner: vi.fn(async () => undefined),
  lockWorkspaceLearningHistory: vi.fn(async () => undefined),
}));
vi.mock("./opening-observation-revision-history", () => ({ qualifyObservationRevision: mocks.qualify }));
vi.mock("./opening-ai-grading-ledger", () => ({ readOpeningAiGradingLedger: mocks.ledger }));
vi.mock("./opening-answer-interpretation-ledger", () => ({ openingAnswerInterpretationPriorCostUnresolved: mocks.priorUnresolved }));
vi.mock("./opening-ai-grading-context", () => ({ readOpeningExplicitRegradeCandidateContext: mocks.candidateContext }));
vi.mock("./opening-auto-grade-policy", () => ({ checkOpeningAutoGradeBudget: mocks.budget }));

import { createOpeningExplicitRegradeRequestRepository } from "./opening-explicit-regrade-requests";

const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const rootId = randomUUID(), headId = randomUUID(), jobId = randomUUID(), outboxId = randomUUID();
const baseOp = `ai-grade:${scope.workspaceId}:${rootId}:2`;

function makeDb(state: { confirmedRow?: Record<string, unknown> | null; preparedRow?: Record<string, unknown> | null; jobState?: string } = {}) {
  const inserted: Record<string, unknown>[] = [];
  let prepared = state.preparedRow ?? null;
  let confirmed = state.confirmedRow ?? null;
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    if (query.includes("SELECT w.privacy_epoch FROM workspaces")) return Promise.resolve([{ privacy_epoch: 0 }]);
    if (query.includes("FROM opening_learning_observations o JOIN opening_learning_observations root")) {
      return Promise.resolve([{ id: headId, root_observation_id: rootId, answer_revision: 2, privacy_epoch: 0, grading_operation_id: baseOp }]);
    }
    if (query.includes("SELECT * FROM opening_explicit_regrade_requests") && query.includes("AND client_key=?")) {
      return Promise.resolve([]);
    }
    if (query.includes("SELECT * FROM opening_explicit_regrade_requests") && query.includes("AND confirmed_at IS NOT NULL")) {
      return Promise.resolve(confirmed ? [confirmed] : []);
    }
    if (query.includes("SELECT * FROM opening_explicit_regrade_requests WHERE id=?")) {
      return Promise.resolve(prepared ? [prepared] : []);
    }
    if (query.includes("INSERT INTO opening_explicit_regrade_requests")) {
      prepared = {
        id: values[0], workspace_id: values[1], owner_user_id: values[2], root_observation_id: values[3],
        expected_head_id: values[4], answer_revision: values[5], privacy_epoch: values[6],
        previous_grading_version: values[7], grading_version: values[8], previous_operation_id: values[9],
        operation_id: values[10], client_key: values[11], confirmation_version: values[12], work_source: null,
        confirmed_at: null, job_id: null, result_observation_id: null,
      };
      inserted.push(prepared);
      return Promise.resolve([prepared]);
    }
    if (query.includes("UPDATE opening_explicit_regrade_requests SET confirmed_at=clock_timestamp()")) {
      prepared = { ...prepared!, confirmed_at: new Date("2026-11-17T00:00:00Z") };
      confirmed = prepared;
      return Promise.resolve([prepared]);
    }
    if (query.includes("INSERT INTO opening_jobs")) {
      return Promise.resolve([{ id: jobId, owner_user_id: scope.ownerUserId, kind: "grade-observation", privacy_epoch: values[5], payload: values[4] }]);
    }
    if (query.includes("INSERT INTO opening_outbox")) {
      return Promise.resolve([{ id: outboxId }]);
    }
    if (query.includes("UPDATE opening_explicit_regrade_requests SET job_id=")) {
      prepared = { ...prepared!, job_id: values[0] };
      confirmed = prepared;
      return Promise.resolve([prepared]);
    }
    if (query.includes("SELECT state FROM opening_jobs")) {
      return Promise.resolve(state.jobState ? [{ state: state.jobState }] : []);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.begin = ((...args: unknown[]) => (args.at(-1) as (tx: Sql) => unknown)(sql)) as Sql["begin"];
  sql.json = ((value: unknown) => value) as Sql["json"];
  return { sql, inserted };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.ledger.mockResolvedValue("unsent" satisfies GradingLedgerState);
  mocks.priorUnresolved.mockResolvedValue(false);
  mocks.budget.mockResolvedValue({ allowed: true, requiredCents: 3 });
  mocks.qualify.mockResolvedValue({
    id: headId,
    rootObservationId: rootId,
    eligibility: { usableForCurrentVersion: "yes" },
    aiEvaluation: null,
    outcome: "unverified",
  });
  mocks.candidateContext.mockResolvedValue({
    observation: { id: headId, rootObservationId: rootId, answer: "corrected" },
    answerRevision: 2,
    operationId: baseOp,
    workSource: null,
    workSourceMetadata: null,
    stem: "stem",
    referenceText: "ref",
    misconceptions: [],
    referenceSourceMetadata: [],
  });
});

describe("0111 explicit regrade with answer-interpretation unresolved prior cost", () => {
  it("reports oldStatus=unknown_cost in snapshot and allows prepare+confirm when ledger is unsent and prior interpretation cost is unresolved", async () => {
    mocks.priorUnresolved.mockResolvedValue(true);
    const { sql } = makeDb();
    const repo = createOpeningExplicitRegradeRequestRepository(sql);
    expect(await repo.snapshot(scope, headId)).toMatchObject({
      rootObservationId: rootId, expectedHead: headId, answerRevision: 2, previousGradingVersion: 0, oldStatus: "unknown_cost",
    });
    const prepared = await repo.prepare(scope, { observationId: headId, expectedHead: headId, expectedGradingVersion: 0, clientKey: "interp-key-1" });
    expect(prepared.state).toBe("prepared");
    const confirmed = await repo.confirm(scope, { requestId: prepared.requestId, confirmationVersion: prepared.confirmationVersion, acceptPossibleDoubleCharge: true });
    expect(confirmed).toMatchObject({ state: "confirmed", jobId, gradingVersion: 1 });
  });

  it("keeps strict ledger guard when prior interpretation cost is settled (or ledger is settled)", async () => {
    mocks.priorUnresolved.mockResolvedValue(false);
    const { sql } = makeDb();
    const repo = createOpeningExplicitRegradeRequestRepository(sql);
    expect(await repo.snapshot(scope, headId)).toMatchObject({ oldStatus: "needs_manual" });
    await expect(repo.prepare(scope, { observationId: headId, expectedHead: headId, expectedGradingVersion: 0, clientKey: "interp-key-2" }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rejects confirm if the prior interpretation cost settled between prepare and confirm", async () => {
    mocks.priorUnresolved.mockResolvedValueOnce(true);
    const { sql } = makeDb();
    const repo = createOpeningExplicitRegradeRequestRepository(sql);
    const prepared = await repo.prepare(scope, { observationId: headId, expectedHead: headId, expectedGradingVersion: 0, clientKey: "interp-key-3" });
    mocks.priorUnresolved.mockResolvedValueOnce(false);
    await expect(repo.confirm(scope, { requestId: prepared.requestId, confirmationVersion: prepared.confirmationVersion, acceptPossibleDoubleCharge: true }))
      .rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("uses the confirmed 0111 request status in snapshot instead of forcing unknown_cost from older interpretation revisions", async () => {
    mocks.priorUnresolved.mockResolvedValue(true);
    const confirmedRow = {
      id: randomUUID(), operation_id: `ai-regrade:${scope.workspaceId}:${randomUUID()}`, job_id: jobId, grading_version: 1,
    };
    const { sql } = makeDb({ confirmedRow, jobState: "queued" });
    const repo = createOpeningExplicitRegradeRequestRepository(sql);
    expect(await repo.snapshot(scope, headId)).toMatchObject({ previousGradingVersion: 1, oldStatus: "queued" });
  });
});
