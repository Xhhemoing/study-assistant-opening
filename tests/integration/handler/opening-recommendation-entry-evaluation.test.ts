import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type Scope } from "@aistudy/contracts";
import { createOpeningApi } from "../../../apps/web/src/features/opening/client/api";
import { appendEphemeralResponseIfActive } from "../../../apps/web/src/features/opening/assistant/assistant-view";
import { createOpeningAttemptService } from "../../../apps/web/src/features/opening/learning/attempt-service";
import { createSpanHintService } from "../../../apps/web/src/features/opening/teaching/span/hint-service";
import { solveSpanProblem, SPAN_SKILL_LABEL } from "@aistudy/domain";
import { getSpanReservedProblem } from "@aistudy/domain/span-heldout-catalog";
import { POST as ephemeralPost } from "../../../apps/web/src/app/api/opening/ephemeral/route";
import { learningAttemptFixture } from "../opening-learning-attempt-fixture";
import type { OpeningFixture } from "../opening-fixture";
import {
  complete, ephemeralCounts, postEphemeral, resetEphemeralRows, startEphemeralHandler,
  stopEphemeralHandler, workspaceForCookie, sql,
} from "./opening-ephemeral-harness";

beforeAll(startEphemeralHandler);
beforeEach(async () => {
  await resetEphemeralRows();
  vi.stubEnv("OPENING_SYSTEM_QUERY", "1");
  vi.stubEnv("OPENING_MODEL_CATALOG", "invalid catalog");
  vi.stubEnv("OPENING_MODEL_API_KEY", "");
});
afterEach(() => vi.unstubAllEnvs());
afterAll(stopEphemeralHandler);

type Scenario = { kind: "unique" | "none"; errors: string[]; success: string };
const scenarios: Scenario[] = [
  { kind: "unique", errors: ["span-reserved-20261021-q01", "span-reserved-fraction"], success: "span-reserved-20261021-q02" },
  { kind: "none", errors: ["span-reserved-transfer", "span-reserved-20261021-q07"], success: "span-reserved-20261021-q03" },
];

async function setup(scope: Scope, scenario: Scenario) {
  const fixture = await learningAttemptFixture({ sql, scope } as OpeningFixture);
  const session = await fixture.learning.createSession(scope, {
    courseId: fixture.courseId, sourceIds: [fixture.sourceId], skillLabel: SPAN_SKILL_LABEL,
  });
  const attempts = createOpeningAttemptService(sql);
  const create = (problemId: string) => attempts.create(scope, {
    sessionId: session.id, clientKey: randomUUID(), spanExercise: { sourceId: fixture.sourceId, problemId, version: 1 },
  });
  const submit = (attemptId: string, answer: unknown, assistance: "hinted" | "independent") => attempts.submit(scope, attemptId, {
    clientKey: randomUUID(), answer: JSON.stringify(answer), outcome: "unverified", assistance,
  });
  const answerFor = (problemId: string) => {
    const problem = getSpanReservedProblem(problemId, 1)!;
    const solution = solveSpanProblem(problem);
    return solution.kind === "none"
      ? { membership: "not_in_span", equation: problem, noSolutionWitness: ["-2", "1", "1"] }
      : { membership: "in_span", equation: problem, coefficients: solution.coefficients, coordinateChecks: problem.target };
  };
  for (const problemId of scenario.errors) {
    const attempt = await create(problemId);
    const hint = await createSpanHintService(sql).read(scope, { attemptId: attempt.id, level: 1 });
    expect(hint.exposureReceipt).toBeTruthy();
    const observation = await submit(attempt.id,
      scenario.kind === "none" ? { membership: "in_span", coefficients: ["999", "999"] } : { membership: "in_span", coefficients: ["999", "999"] },
      "hinted");
    expect(observation).toMatchObject({ outcome: "incorrect", assistance: "hinted", serverEvaluation: { evaluatorVersion: "span-exact-v1" } });
  }
  const queryInput = { querySystem: true, text: "为什么推荐我继续练习？", courseId: fixture.courseId, sourceIds: [], mode: "listen" as const, history: [] };
  const client = createOpeningApi(async (_url, init) => ephemeralPost(postEphemeral(JSON.parse(String(init?.body)))));
  return { fixture, session, create, submit, answerFor, queryInput, client };
}

it.each(scenarios)("evaluates the real $kind recommendation HTTP entry without model or budget side effects", async scenario => {
  const workspaceId = await workspaceForCookie();
  const [owner] = await sql`SELECT owner_user_id FROM workspaces WHERE id=${workspaceId}`;
  const scope: Scope = { workspaceId, ownerUserId: String(owner!.owner_user_id) };
  const f = await setup(scope, scenario);
  const before = await ephemeralCounts();

  const first = await f.client.replyEphemeral(f.queryInput);
  const recommendation = first.systemQuery!.results.find(row => row.name === "recommendation");
  expect(recommendation).toMatchObject({ status: "partial", data: [{ step: { activityKind: "full_explain", reasonCode: "repeated_assisted_error" } }] });
  expect(recommendation?.data[0]?.evidenceIds).toHaveLength(2);
  expect(first.text).toContain("获得帮助后仍多次在同一步骤出错");
  const messages = appendEphemeralResponseIfActive([], { clientKey: "recommendation", text: f.queryInput.text, output: first }, new AbortController().signal);
  expect(messages.at(-1)).toMatchObject({ text: first.text, systemQuery: true, queryEvidenceLinks: expect.arrayContaining([
    { href: `/opening/courses/${f.fixture.courseId}?tab=records`, label: "实际作答记录" },
  ]) });
  const afterFirstQuery = await ephemeralCounts();
  expect(afterFirstQuery).toEqual(before);
  expect(complete).not.toHaveBeenCalled();

  const successAttempt = await f.create(scenario.success);
  const success = await f.submit(successAttempt.id, f.answerFor(scenario.success), "independent");
  expect(success).toMatchObject({ outcome: "correct", assistance: "independent", eligibility: { verifiedCorrect: "yes", independentAttempt: "yes" } });
  const afterSuccess = await f.client.replyEphemeral(f.queryInput);
  const successRecommendation = afterSuccess.systemQuery!.results.find(row => row.name === "recommendation");
  expect(successRecommendation?.data[0]).not.toMatchObject({ step: { reasonCode: "repeated_assisted_error" } });
  const afterSuccessCounts = await ephemeralCounts();
  expect(afterSuccessCounts).toEqual({ ...before, learning_observations: before.learning_observations + 1 });
  expect(complete).not.toHaveBeenCalled();

  await sql`UPDATE opening_learning_eligibility SET policy_version='old-policy' WHERE root_observation_id=${success.id}`;
  const expired = await f.client.replyEphemeral(f.queryInput);
  const expiredRecommendation = expired.systemQuery!.results.find(row => row.name === "recommendation");
  expect(expiredRecommendation).toMatchObject({ status: "partial", data: [{ recommendationStatus: "unknown" }] });
  expect(expired.text).toContain("当前证据不完整或资格待更新");
  expect(expired.text).not.toContain("获得帮助后仍多次在同一步骤出错");
  const afterExpiredCounts = await ephemeralCounts();
  expect(afterExpiredCounts).toEqual(afterSuccessCounts);
  expect(complete).not.toHaveBeenCalled();
}, 30_000);
