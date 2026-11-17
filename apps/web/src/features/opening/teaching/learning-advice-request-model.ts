import { z } from "zod";
import type { ExperimentalLearningAdvicePort } from "./experimental-learning-advice-port";

/** Local invalidation context, NOT a principal, grant or server authorization token. */
export type LearningAdviceContext = Readonly<{
  actorKey: string;
  courseId: string;
  activityId: string;
  attemptId: string;
  revision: number;
  accessEpoch: number;
}>;
export type LearningAdviceTransport = (request: {
  activityId: string;
  body: { attemptId: string; expectedRevision: number; optIn: boolean };
  signal: AbortSignal;
}) => Promise<unknown>;

const ruleSchema = z.object({
  activityKind: z.enum(["diagnose", "targeted_explain", "reduced_help_practice", "transfer_check", "full_explain"]),
  reasonCode: z.enum(["due_retest", "remediation_limit", "requested_consolidate", "requested_full", "no_evidence",
    "unverified_only", "verified_incorrect", "repeated_assisted_error", "assisted_success", "assistance_dependent",
    "independent", "correct_needs_independent_check", "needs_check"]),
}).strict();
const portSchema = z.discriminatedUnion("status", [
  z.object({ ruleDecision: ruleSchema, status: z.literal("disabled"), experimentalAdvice: z.null() }).strict(),
  z.object({ ruleDecision: ruleSchema, status: z.literal("unavailable"), experimentalAdvice: z.null() }).strict(),
  z.object({ ruleDecision: ruleSchema, status: z.literal("fallback"), experimentalAdvice: z.null(),
    reason: z.enum(["disabled", "incomplete_target", "invalid_cutoff", "priority_rule", "no_qualified_samples",
      "insufficient_samples", "additional_support", "retain_rule"]) }).strict(),
  z.object({ ruleDecision: ruleSchema, status: z.literal("compared"),
    experimentalAdvice: z.object({ kind: z.enum(["supported_practice", "continue_rule"]) }).strict() }).strict(),
]);
const responseSchema = z.object({
  advice: portSchema.nullable(),
  experimentState: z.enum(["off", "unavailable", "ready"]),
  messageCode: z.enum(["off", "unavailable", "compared", "fallback"]),
}).strict().superRefine((value, ctx) => {
  const status = value.advice?.status;
  const valid = value.experimentState === "ready"
    ? (status === "compared" || status === "fallback") && value.messageCode === status
    : value.experimentState === "off"
      ? (status === undefined || status === "disabled") && value.messageCode === "off"
      : status !== "compared" && value.messageCode === "unavailable";
  if (!valid) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Inconsistent advice response" });
});

/** Feature-local draft response boundary. Parsing a safe DTO does not authenticate it. */
export function parseLearningAdviceResponse(input: unknown) {
  return responseSchema.parse(input);
}
export type LearningAdviceRequestState = Readonly<{
  optedIn: boolean;
  status: "idle" | "loading" | "off" | "unavailable" | "ready";
  rule: ExperimentalLearningAdvicePort["ruleDecision"] | null;
  advice: ExperimentalLearningAdvicePort | null;
  /** Original error identity for the caller; never render or serialize this value. */
  error: unknown;
}>;
const emptyState: LearningAdviceRequestState = { optedIn: false, status: "idle", rule: null, advice: null, error: null };
export function learningAdviceContextKey(context: LearningAdviceContext | null) {
  return context === null ? "null" : JSON.stringify([context.actorKey, context.courseId, context.activityId,
    context.attemptId, context.revision, context.accessEpoch]);
}

/** No fetch, persistence, wrapper invocation or permission decision. One owned request at a time. */
export class LearningAdviceRequestModel {
  private context: LearningAdviceContext | null = null;
  private operation = {};
  private controller: AbortController | null = null;
  private state: LearningAdviceRequestState = emptyState;
  private readonly listeners = new Set<() => void>();
  constructor(private readonly transport: LearningAdviceTransport) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(state: LearningAdviceRequestState) {
    this.state = state;
    this.listeners.forEach(listener => listener());
  }
  private cancel() {
    // Reserve before abort callbacks: each reentrant operation gets a distinct identity.
    const operation = {};
    this.operation = operation;
    // The outer cancellation wins over synchronous abort cleanup, including its retries.
    // Detach before abort, then drain every controller installed by those callbacks.
    while (this.controller) {
      const controller = this.controller;
      this.controller = null;
      controller.abort();
    }
    this.operation = operation;
    return operation;
  }
  setContext(context: LearningAdviceContext | null) {
    if (learningAdviceContextKey(this.context) === learningAdviceContextKey(context)) return;
    const operation = this.cancel();
    this.context = context === null ? null : { ...context };
    this.publish(emptyState);
    if (operation === this.operation && this.context) this.request(false);
  }
  /** Known access changes and return from a blurred/hidden page reset this visit's opt-in. */
  refresh() {
    const operation = this.cancel();
    this.publish(emptyState);
    if (operation === this.operation && this.context) this.request(false);
  }
  /** Suspend on blur/hidden, without re-fetching until the page becomes active again. */
  suspend() {
    this.cancel();
    this.publish(emptyState);
  }
  clear() {
    this.cancel();
    this.context = null;
    this.publish(emptyState);
  }
  setOptIn(optIn: boolean) {
    if (!this.context) return;
    this.request(optIn);
  }
  retry() {
    if (this.context) this.request(this.state.optedIn);
  }
  private request(optIn: boolean) {
    if (!this.context) return;
    const previousIdentity = learningAdviceContextKey(this.context);
    const operation = this.cancel();
    const context = this.context;
    if (!context) return;
    const identity = learningAdviceContextKey(context);
    // Abort cleanup may change context; intent must not cross that identity boundary.
    if (identity !== previousIdentity) optIn = false;
    const controller = new AbortController();
    this.controller = controller;
    const current = () => operation === this.operation && this.controller === controller && !controller.signal.aborted
      && identity === learningAdviceContextKey(this.context);
    this.publish({ optedIn: optIn, status: "loading", rule: this.state.rule, advice: null, error: null });
    void (async () => {
      try {
        // Subscribers can synchronously revoke intent or tear down during publish.
        if (!current()) return;
        const raw = await this.transport({ activityId: context.activityId,
          body: { attemptId: context.attemptId, expectedRevision: context.revision, optIn }, signal: controller.signal });
        if (!current()) return;
        const response = parseLearningAdviceResponse(raw);
        if (!current()) return;
        if (!optIn && response.experimentState === "ready") throw new Error("Unrequested experimental response");
        this.publish({ optedIn: optIn, status: response.experimentState, rule: response.advice?.ruleDecision ?? null,
          advice: optIn ? response.advice : null, error: null });
      } catch (error) {
        if (!current()) return;
        this.publish({ optedIn: optIn, status: "unavailable", rule: this.state.rule, advice: null, error });
      } finally {
        if (current()) this.controller = null;
      }
    })();
  }
}
