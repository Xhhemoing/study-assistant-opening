import { describe, expect, it } from "vitest";
import type { TransactionSql } from "postgres";
import { getSpanProblem, spanProblemStem, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { evaluateOpeningSpanAttempt } from "./opening-span-evaluation";
const source = "11111111-1111-4111-8111-111111111111";
const scope = { workspaceId: source, ownerUserId: source };
function fixture(problemId = "span-example-2d", changed = false, prior = false) {
  const problem = getSpanProblem(problemId)!;
  const spec = { kind: "span", specVersion: "span-v1", problemId, version: 1 };
  let calls = 0;
  const tx = Object.assign(async () => ++calls === 1 ? [{ evaluation_spec: spec, source_id: source, source_version: 1,
    stem_snapshot: spanProblemStem(problem), current_stem: spanProblemStem(problem), current_source_version: changed ? 2 : 1 }] : prior ? [{ id: source }] : [], { json: (value: unknown) => value }) as unknown as TransactionSql;
  const attempt = { id: source, item_version_id: source, problem_id: source, course_id: source, requirement_key: SPAN_REQUIREMENT_KEY,
    create_intent: { spanExercise: { sourceId: source, problemId, version: 1 } }, source_versions: { [source]: 1 } };
  return { problem, tx, attempt };
}
describe("server span evaluator", () => {
  it("accepts a complete exact answer and detects repeated feedback without a client verdict", async () => {
    const { tx, attempt, problem } = fixture("span-example-2d", false, true);
    const result = await evaluateOpeningSpanAttempt(tx, scope, attempt, JSON.stringify({ membership: "in_span", coefficients: ["3", "-1/2"], equation: { vectors: problem.vectors, target: problem.target }, coordinateChecks: ["3", "-1"] }), [{ id: source, version: 1 }]);
    expect(result).toMatchObject({ decision: "correct", outcome: "correct", priorFeedback: true, coreEvidenceComplete: true, skills: { equation: "correct", coefficients: "correct", allCoordinates: "correct" } });
  });
  it.each(["not JSON", JSON.stringify({ membership: "in_span", recognition: "uncertain" })])("does not count unparseable or uncertain input as a student error", async answer => {
    const { tx, attempt } = fixture();
    expect(await evaluateOpeningSpanAttempt(tx, scope, attempt, answer, [{ id: source, version: 1 }])).toMatchObject({ decision: "abstain", outcome: "unverified" });
  });
  it("does not promote an unsupported no-span click or omitted process to complete skill evidence", async () => {
    const missing = fixture("span-independent-3d");
    expect(await evaluateOpeningSpanAttempt(missing.tx, scope, missing.attempt, JSON.stringify({ membership: "not_in_span" }), [{ id: source, version: 1 }])).toMatchObject({ decision: "abstain", outcome: "unverified", reasonCodes: ["no_solution_proof_unobserved"] });
    const bare = fixture();
    expect(await evaluateOpeningSpanAttempt(bare.tx, scope, bare.attempt, JSON.stringify({ membership: "in_span", coefficients: ["3", "-1/2"] }), [{ id: source, version: 1 }])).toMatchObject({ decision: "abstain", reasonCodes: ["core_steps_unobserved"] });
  });
  it("abstains after a version change and conservatively records faded steps as assisted", async () => {
    const changed = fixture("span-example-2d", true);
    expect(await evaluateOpeningSpanAttempt(changed.tx, scope, changed.attempt, "{}", [{ id: source, version: 1 }])).toMatchObject({ decision: "abstain", reasonCodes: ["version_changed"] });
    const faded = fixture("span-faded-3d");
    expect(await evaluateOpeningSpanAttempt(faded.tx, scope, faded.attempt, JSON.stringify({ membership: "in_span", coefficients: ["2", "-1"] }), [{ id: source, version: 1 }])).toMatchObject({ priorFeedback: true });
  });
});
