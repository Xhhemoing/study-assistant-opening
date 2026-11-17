import { z } from "zod";

// Firstslice owns an off-only boundary; it does not depend on the draft client model.
const ruleSchema = z.object({
  activityKind: z.enum(["diagnose", "targeted_explain", "reduced_help_practice", "transfer_check", "full_explain"]),
  reasonCode: z.enum(["due_retest", "remediation_limit", "requested_consolidate", "requested_full", "no_evidence",
    "unverified_only", "verified_incorrect", "repeated_assisted_error", "assisted_success", "assistance_dependent",
    "independent", "correct_needs_independent_check", "needs_check"]),
}).strict();
const disabledPortSchema = z.object({
  ruleDecision: ruleSchema, status: z.literal("disabled"), experimentalAdvice: z.null(),
}).strict();
const routeResponseSchema = z.discriminatedUnion("messageCode", [
  z.object({ experimentState: z.literal("off"), messageCode: z.literal("rule_only"), advice: disabledPortSchema }).strict(),
  z.object({ experimentState: z.literal("off"), messageCode: z.literal("advice_unavailable"), advice: z.null() }).strict(),
]);
const clientResponseSchema = z.object({
  experimentState: z.literal("off"), messageCode: z.literal("off"), advice: disabledPortSchema.nullable(),
}).strict();
const bodySchema = z.object({
  attemptId: z.string().uuid(), expectedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), optIn: z.boolean(),
}).strict();

export type LearningAdviceHttpResponse = z.infer<typeof clientResponseSchema>;
export type LearningAdviceHttpRequest = {
  activityId: string;
  body: { attemptId: string; expectedRevision: number; optIn: boolean };
  signal: AbortSignal;
};
export type LearningAdviceHttpTransport = (request: LearningAdviceHttpRequest) => Promise<LearningAdviceHttpResponse>;
export type LearningAdviceHttpFetch = (input: string, init: RequestInit) => Promise<Pick<Response, "status" | "redirected" | "json">>;

/** Reject accessors before a schema can read them. JSON objects have only enumerable own data fields. */
function assertDataRecord(input: unknown): asserts input is Record<string, unknown> {
  if (input === null || typeof input !== "object"
    || (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null)) {
    throw new TypeError("Invalid learning advice data");
  }
  for (const key of Reflect.ownKeys(input)) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!;
    if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Invalid learning advice data");
    }
  }
}

// Maximum object depth is response -> advice -> ruleDecision; arrays are never legal.
function assertResponseData(input: unknown, depth = 0): void {
  assertDataRecord(input);
  if (depth > 2) throw new TypeError("Invalid learning advice data");
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(input))) {
    const value: unknown = descriptor.value;
    if (value !== null && typeof value === "object") assertResponseData(value, depth + 1);
  }
}

export class LearningAdviceHttpError extends Error {
  constructor(readonly status: number) {
    super("Learning advice request failed");
    this.name = "LearningAdviceHttpError";
  }
}

/** Mandatory injection: no ambient fetch, auth, grant, retries, persistence or experiment activation. */
export function createLearningAdviceHttp(fetchImpl: LearningAdviceHttpFetch): LearningAdviceHttpTransport {
  return async request => {
    assertDataRecord(request);
    assertDataRecord(request.body);
    const activityId = z.string().uuid().parse(request.activityId);
    const body = bodySchema.parse(request.body);
    const signal = request.signal;
    signal.throwIfAborted();
    const response = await fetchImpl(`/api/opening/teaching/activities/${activityId}/learning-advice`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      credentials: "same-origin", cache: "no-store", redirect: "error", signal,
      body: JSON.stringify({ attemptId: body.attemptId, expectedRevision: body.expectedRevision, optIn: body.optIn }),
    });
    signal.throwIfAborted();
    if (response.redirected || response.status < 200 || response.status >= 300) {
      throw new LearningAdviceHttpError(response.status);
    }
    const raw: unknown = await response.json();
    signal.throwIfAborted();
    // Validate the entire raw object before constructing anything: never strip unknown fields to pass parsing.
    assertResponseData(raw);
    const validated = routeResponseSchema.parse(raw);
    return clientResponseSchema.parse({
      experimentState: "off", messageCode: "off",
      advice: validated.advice === null ? null : {
        ruleDecision: { activityKind: validated.advice.ruleDecision.activityKind, reasonCode: validated.advice.ruleDecision.reasonCode },
        status: "disabled", experimentalAdvice: null,
      },
    });
  };
}
