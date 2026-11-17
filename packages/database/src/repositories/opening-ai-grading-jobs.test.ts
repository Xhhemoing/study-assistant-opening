import { randomUUID } from "node:crypto";
import type { Sql } from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GradingLedgerState } from "./opening-ai-grading-ledger";

const mocks = vi.hoisted(() => ({
  qualify: vi.fn(),
  ledger: vi.fn(),
  priorUnresolved: vi.fn(),
  context: vi.fn(),
  skip: vi.fn(),
  budget: vi.fn(),
}));
vi.mock("./opening-observation-revision-history", () => ({ qualifyObservationRevision: mocks.qualify }));
vi.mock("./opening-ai-grading-ledger", () => ({ readOpeningAiGradingLedger: mocks.ledger }));
vi.mock("./opening-answer-interpretation-ledger", () => ({ openingAnswerInterpretationPriorCostUnresolved: mocks.priorUnresolved }));
vi.mock("./opening-ai-grading-context", async original => ({
  ...(await original<typeof import("./opening-ai-grading-context")>()),
  readOpeningAiGradingContext: mocks.context,
}));
vi.mock("./opening-auto-grade-policy", () => ({
  readOpeningAutoGradeSkip: mocks.skip,
  checkOpeningAutoGradeBudget: mocks.budget,
}));

import { createOpeningAiGradingJobRepository } from "./opening-ai-grading-jobs";

const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const rootId = randomUUID(), headId = randomUUID(), resultId = randomUUID();
const attemptId = randomUUID(), problemId = randomUUID(), itemVersionId = randomUUID();
const requestId = randomUUID(), regradeJobId = randomUUID(), baseJobId = randomUUID();
const regradeOperation = `ai-regrade:${scope.workspaceId}:${requestId}`;
const baseOperation = `ai-grade:${scope.workspaceId}:${rootId}:1`;

function makeDb(opts: {
  headRow?: Record<string, unknown>;
  regradeRow?: Record<string, unknown> | null;
  regradeJob?: Record<string, unknown> | null;
  baseJob?: Record<string, unknown> | null;
}) {
  const queries: string[] = [];
  const head = {
    id: headId,
    root_id: rootId,
    answer_revision: 1,
    current_epoch: 0,
    grading_operation_id: baseOperation,
    grading_work_source: null,
    revision_kind: "original",
    ai_evaluation: null,
    answer: "2",
    previous_answer: null,
    submitted_intent: {},
    ...opts.headRow,
  };
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?").replace(/\s+/g, " ").trim();
    queries.push(query);
    if (query.includes("FROM opening_learning_observations o JOIN opening_learning_observations root")) {
      return Promise.resolve([head]);
    }
    if (query.includes("FROM opening_explicit_regrade_requests")) {
      return Promise.resolve(opts.regradeRow ? [opts.regradeRow] : []);
    }
    if (query.includes("FROM opening_jobs")) {
      if (query.includes("AND id=?")) return Promise.resolve(opts.regradeJob ? [opts.regradeJob] : []);
      if (query.includes("AND key=?")) return Promise.resolve(opts.baseJob ? [opts.baseJob] : []);
      void values;
      return Promise.resolve([]);
    }
    return Promise.resolve([]);
  }) as unknown as Sql;
  sql.begin = ((...args: unknown[]) => (args.at(-1) as (tx: Sql) => unknown)(sql)) as Sql["begin"];
  return { sql, queries };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.priorUnresolved.mockResolvedValue(false);
  mocks.ledger.mockResolvedValue("unsent" satisfies GradingLedgerState);
  mocks.skip.mockResolvedValue(null);
  mocks.budget.mockResolvedValue({ allowed: true });
  mocks.qualify.mockResolvedValue({
    id: headId,
    rootObservationId: rootId,
    attemptId,
    problemId,
    itemVersionId,
    answer: "2",
    outcome: "unverified",
    revisionKind: "original",
    aiEvaluation: null,
    serverEvaluation: null,
    eligibility: { usableForCurrentVersion: "yes" },
  });
});

describe("readStatus with 0111 explicit regrade", () => {
  it.each([
    { state: "queued", ledger: "unsent", expected: "queued" },
    { state: "running", ledger: "unsent", expected: "grading" },
    { state: "running", ledger: "in_flight", expected: "grading" },
    { state: "failed", ledger: "unsent", expected: "needs_manual" },
    { state: "outcome_unknown", ledger: "unknown", expected: "unknown_cost" },
  ] as const)("reflects active 0111 job state=$state ledger=$ledger as $expected even when base job is failed and prior interpretation cost is unresolved", async ({ state, ledger, expected }) => {
    mocks.priorUnresolved.mockResolvedValue(true);
    mocks.ledger.mockImplementation(async (_tx: unknown, _scope: unknown, op: string) => op === regradeOperation ? ledger : "unknown");
    const { sql } = makeDb({
      headRow: { revision_kind: "replace", answer: "2", previous_answer: "2" },
      regradeRow: { id: requestId, expected_head_id: headId, operation_id: regradeOperation, job_id: regradeJobId, result_observation_id: null },
      regradeJob: {
        id: regradeJobId, state, privacy_epoch: 0,
        payload: { observationId: headId, rootObservationId: rootId, answerRevision: 1, regrade: { requestId, operationId: regradeOperation, ownerUserId: scope.ownerUserId, privacyEpoch: 0, gradingVersion: 1, workSource: null } },
      },
      baseJob: { id: baseJobId, state: "outcome_unknown", privacy_epoch: 0, payload: { observationId: headId, rootObservationId: rootId, answerRevision: 1 } },
    });
    const status = await createOpeningAiGradingJobRepository(sql).read(scope, { observationId: headId });
    expect(status).toMatchObject({ status: expected, jobId: regradeJobId, retryable: false, autoGradeSkipped: null });
    expect(mocks.ledger).toHaveBeenCalledWith(expect.anything(), scope, regradeOperation);
  });

  it("reads settled 0111 result observation outcome without falling back to queued/grading or legacy retry", async () => {
    mocks.ledger.mockResolvedValue("completed");
    mocks.qualify.mockResolvedValue({
      id: resultId,
      rootObservationId: rootId,
      attemptId,
      problemId,
      itemVersionId,
      answer: "2",
      outcome: "correct",
      revisionKind: "replace",
      aiEvaluation: { outcome: "correct" },
      serverEvaluation: null,
      eligibility: { usableForCurrentVersion: "yes" },
    });
    const { sql } = makeDb({
      headRow: { id: resultId, grading_operation_id: regradeOperation, ai_evaluation: { outcome: "correct" }, revision_kind: "replace" },
      regradeRow: { id: requestId, expected_head_id: headId, operation_id: regradeOperation, job_id: regradeJobId, result_observation_id: resultId },
      regradeJob: {
        id: regradeJobId, state: "running", privacy_epoch: 0,
        payload: { observationId: headId, rootObservationId: rootId, answerRevision: 1, regrade: { requestId, operationId: regradeOperation, ownerUserId: scope.ownerUserId, privacyEpoch: 0, gradingVersion: 1, workSource: null } },
      },
    });
    const status = await createOpeningAiGradingJobRepository(sql).read(scope, { observationId: headId });
    expect(status).toMatchObject({ headObservationId: resultId, status: "graded", retryable: false, autoGradeSkipped: null });
  });

  it("keeps retryable=false when 0111 is confirmed without a linked job yet", async () => {
    const { sql } = makeDb({
      regradeRow: { id: requestId, expected_head_id: headId, operation_id: regradeOperation, job_id: null, result_observation_id: null },
    });
    const status = await createOpeningAiGradingJobRepository(sql).read(scope, { observationId: headId });
    expect(status).toMatchObject({ status: "needs_manual", jobId: null, retryable: false, autoGradeSkipped: null });
  });

  it("forwards readOnly=true to readOpeningAiGradingContext during repeatable-read-only policy checks", async () => {
    mocks.context.mockResolvedValue({
      stem: "1+1=?",
      observation: { answer: "2" },
      referenceText: "2",
      misconceptions: [],
      workSourceMetadata: null,
      referenceSourceMetadata: [],
    });
    const { sql } = makeDb({});
    const status = await createOpeningAiGradingJobRepository(sql).read(scope, { observationId: headId }, {} as never);
    expect(status).toMatchObject({ status: "needs_manual", retryable: true, autoGradeSkipped: null });
    expect(mocks.context).toHaveBeenCalledWith(sql, scope, { observationId: headId }, { readOnly: true });
  });
});
