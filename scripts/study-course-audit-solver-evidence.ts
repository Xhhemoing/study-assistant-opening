import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { checkArithmeticAnswer } from "../packages/domain/src/opening/arithmetic-check";

// Shared private file/model boundary; not an authority or public product contract.
export const solveOutputSchema = z.object({
  status: z.enum(["solved", "unjudgeable"]), answer: z.string().max(12000),
  reason: z.string().min(1).max(8000).refine(value => value.trim().length > 0),
}).strict().refine(value => value.status !== "solved" || value.answer.trim().length > 0);
const count = z.number().int().nonnegative().safe();
const metadata = { requestId: z.string().nullable(), inputTokens: count.nullable(), outputTokens: count.nullable() };
const resultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("not_started") }).strict(),
  z.object({ status: z.literal("request_limit_reached") }).strict(),
  z.object({ status: z.literal("valid_output"), solution: solveOutputSchema, ...metadata }).strict(),
  z.object({ status: z.literal("invalid_model_output"), errorCode: z.literal("invalid_solution"), rawOutput: z.string(), ...metadata }).strict(),
  z.object({ status: z.literal("provider_error"), errorCode: z.literal("provider_failure") }).strict(),
]);
const collectionSchema = z.object({
  format: z.literal("course-audit-blind-solve-v1"), instructionVersion: z.literal("v1"), requestedModel: z.string().refine(value => value.trim().length > 0),
  notice: z.string(), sample: z.unknown(), maxRequests: count.min(1).max(1000), requestCount: count,
  results: z.array(resultSchema), statusCounts: z.object({ not_started: count, valid_output: count,
    invalid_model_output: count, provider_error: count, request_limit_reached: count }).strict(),
}).strict();

export function createSolverEvidence(raw: unknown, sample: { samples: { prompt: string; referenceAnswer: string }[] }) {
  const collection = collectionSchema.parse(raw);
  if (!isDeepStrictEqual(raw, collection) || !isDeepStrictEqual(collection.sample, sample)
    || collection.results.length !== sample.samples.length) throw new Error("Invalid local solver binding");
  const attempted = (status: string) => ["valid_output", "invalid_model_output", "provider_error"].includes(status);
  const actualRequests = collection.results.filter(result => attempted(result.status)).length;
  const counts = Object.fromEntries(Object.keys(collection.statusCounts).map(status =>
    [status, collection.results.filter(result => result.status === status).length]));
  if (!isDeepStrictEqual(collection.statusCounts, counts) || collection.requestCount !== actualRequests
    || actualRequests > collection.maxRequests) throw new Error("Invalid local solver counts");
  // The collector attempts a sequential prefix; interrupted/unrequested rows remain unknown.
  for (const [index, result] of collection.results.entries()) {
    const expected = index >= collection.maxRequests ? "request_limit_reached"
      : index < actualRequests ? "attempted" : "not_started";
    if (expected === "attempted" ? !attempted(result.status) : result.status !== expected) throw new Error("Invalid local solver sequence");
  }
  return collection.results.map((result, index) => {
    const item = sample.samples[index]!;
    return { requestedModel: collection.requestedModel, instructionVersion: collection.instructionVersion, result,
      referenceArithmetic: checkArithmeticAnswer(item.prompt, item.referenceAnswer) ?? "unsupported",
      solverArithmetic: result.status === "valid_output" && result.solution.status === "solved"
        ? checkArithmeticAnswer(item.prompt, result.solution.answer) ?? "unsupported" : "unknown" };
  });
}
