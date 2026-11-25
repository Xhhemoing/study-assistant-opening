import type { OpeningAiSettings, OpeningModelSummary } from "@aistudy/contracts";
import {
  authorizeModelRoute, evaluateMarginGuardrail,
  type LearnerInteractionStepKind, type MarginGuardrailInput,
} from "@aistudy/domain/commercial-resilience";
import { resolveFallbackModelForTask, resolveModelForTask } from "./model-routing";
import type { ModelTaskKey } from "./model-tasks";

const taskStepKinds = {
  "tutor.listen": "standard_draft",
  "tutor.hint": "standard_draft",
  "tutor.explain": "explanation",
  "tutor.think_together": "explanation",
  "materials.recognize-page": "standard_draft",
  "teaching.compile-visual": "standard_draft",
  "knowledge.extract": "standard_draft",
  "teaching.solve": "standard_draft",
  "teaching.compile": "standard_draft",
  "practice.grade-text": "exam_grading",
  "practice.grade-photo": "exam_grading",
  "practice.exam": "standard_draft",
  "practice.recognize-photo": "standard_draft",
  "settings.probe": "standard_draft",
  "media.transcribe": "standard_draft",
} as const satisfies Record<ModelTaskKey, LearnerInteractionStepKind>;

type OpeningLocalAction = Extract<LearnerInteractionStepKind, "local_verify" | "flashcard_review" | "local_socratic_rule" | "material_reading">;

/** Credential provenance and route profile come from the server catalog. */
export type OpeningMarginModel = OpeningModelSummary & (
  | { readonly credentialMode: "platform"; readonly platformProfile: "flagship" | "distilled_cached" }
  | { readonly credentialMode: "byok"; readonly platformProfile?: never }
);

type OpeningConfiguredRoute = { readonly settings: OpeningAiSettings; readonly serverDefaultId: string | null };

export type OpeningMarginRouteInput<T extends OpeningMarginModel> = {
  readonly guardrail: MarginGuardrailInput;
} & (
  | { readonly localAction: OpeningLocalAction }
  | (OpeningConfiguredRoute & {
    readonly task: ModelTaskKey;
    readonly models: readonly T[];
    readonly economicalRoute?: OpeningConfiguredRoute;
    /** The caller confirms local rules could not resolve this specific step. */
    readonly localResolution?: "irreducible_ambiguous";
    /** Resolve a fallback on a new call after the gateway establishes fallback eligibility. */
    readonly attempt?: "primary" | "fallback";
  } & (
    | { readonly credentialMode: "platform"; readonly estimatedPlatformCostMicros: bigint }
    | { readonly credentialMode: "byok" }
  ))
);

/** Routes one attempt against the current budget using a server-side cost bound for the selected lane. */
export function resolveOpeningMarginRoute<T extends OpeningMarginModel>(input: OpeningMarginRouteInput<T>) {
  const guardrail = evaluateMarginGuardrail(input.guardrail);
  const authorization = authorizeModelRoute("localAction" in input
    ? { guardrail, stepKind: input.localAction, credentialMode: "platform" }
    : {
      guardrail, credentialMode: input.credentialMode,
      stepKind: guardrail.tier === "deterministic_90_100" && input.localResolution
        ? input.localResolution
        : taskStepKinds[input.task],
      estimatedPlatformCostMicros: input.credentialMode === "platform" ? input.estimatedPlatformCostMicros : undefined,
    });
  if ("localAction" in input || authorization.target === "local_zero_cost") return { guardrail, authorization, model: null };

  const economical = authorization.target === "platform_distilled_cached";
  const route = (economical && input.settings.mode !== "manual" ? input.economicalRoute : undefined) ?? input;
  const available = input.models.filter(model => model.credentialMode === input.credentialMode
    && (authorization.target !== "platform_flagship" || model.platformProfile === "flagship")
    && (!economical || model.platformProfile === "distilled_cached"));
  const model = input.attempt === "fallback"
    ? resolveFallbackModelForTask(available, route.settings, input.task)
    : resolveModelForTask(available, route.settings, input.task, route.serverDefaultId);
  return { guardrail, authorization, model };
}
