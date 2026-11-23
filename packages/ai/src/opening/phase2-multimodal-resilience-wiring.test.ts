import type { AiGradingProposal, LearningObservation, OpeningAiSettings, OpeningModelSummary } from "@aistudy/contracts";
import { describe, expect, it, vi } from "vitest";
import * as ai from "../index";

const scope = { workspaceId: "workspace", ownerUserId: "learner" };
const photo = { id: "00000000-0000-4000-8000-000000000002", version: 2, physicalPage: 3 };
const observation = {
  id: "00000000-0000-4000-8000-000000000001", answer: "", photoStorageKey: "saved/photo",
} as LearningObservation;
const input = { observationId: observation.id, workSourceId: photo.id, workSourceVersion: photo.version, physicalPage: photo.physicalPage };
const proposal: AiGradingProposal = {
  outcome: "incorrect", confidence: 0.95, questionMatch: true, feedback: "Check the operation.",
  criteria: [{ label: "Operation", verdict: "incorrect", feedback: "Check the sign." }],
};
const handwriting = {
  observationId: observation.id, answerRevision: 1, workSource: photo, photoStorageKey: "saved/photo",
  steps: [{
    stepId: "step", bbox: [0, 0, 1, 1] as const,
    ast: { kind: "expression" as const, tokens: [{ tokenId: "sign", kind: "operator" as const, rawText: "-", confidence: 0.5 }] },
  }],
};

function gradingFixture(multimodalEvidence: ai.OpeningMultimodalEvidenceHook, assessed = proposal, rubricCalibration?: ai.OpeningRubricCalibrationHook) {
  const complete = vi.fn(async () => ({
    text: JSON.stringify(assessed), inputTokens: 1, outputTokens: 1, citedChunkIds: [], candidates: [], requestId: null,
  }));
  const gateway = ai.createModelGateway({ resolve: async () => ({
    provider: { complete }, inputCentsPerMillion: 1, outputCentsPerMillion: 1,
    modelSnapshot: { id: "model", providerId: "fixture", modelName: "fixture", inputCentsPerMillion: 1, outputCentsPerMillion: 1,
      mediaInputTokenUpperBound: 8000, mediaMaxInputBytes: 1024, mediaInputCentsPerMillion: 2 },
  }) });
  const reserve = vi.fn(async () => ({ id: "reservation", state: "reserved" as const }));
  const apply = vi.fn<ai.OpeningAiGradingServiceDeps["repository"]["apply"]>(async (_scope, _input, result) => ({
    ...observation, outcome: result.outcome,
  }));
  const deps = {
    repository: {
      context: async () => ({ observation, existing: null, stem: "Simplify", referenceText: "", misconceptions: [],
        workSource: photo, answerRevision: 1, operationId: "grading" }),
      apply, ledger: async () => "unsent" as const,
    },
    gateway,
    budget: () => ({
      reserve, settle: async () => undefined, claimExecution: async () => true,
      release: async () => undefined, markUnknown: async () => undefined,
    }),
    images: async () => [{ sourceId: photo.id, physicalPage: photo.physicalPage, mediaType: "image/png", data: "data:image/png;base64,AA==" }],
    multimodalEvidence,
    rubricCalibration,
  };
  return { service: ai.createOpeningAiGradingService(deps), complete, reserve, apply };
}

describe("Opening handwriting admission", () => {
  it.each(["correct", "incorrect"] as const)("preserves feedback but withholds a model %s for an unresolved critical glyph", async outcome => {
    const assessed = { ...proposal, outcome };
    const { service, apply } = gradingFixture(() => handwriting, assessed);
    await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: "unverified" });
    expect(apply.mock.calls[0]?.[2]).toMatchObject({ outcome: "unverified", feedback: proposal.feedback, criteria: proposal.criteria });
  });

  it.each([
    null, { ...handwriting, observationId: "older-observation" }, { ...handwriting, answerRevision: 0 },
    { ...handwriting, workSource: { ...photo, id: "other-source" } },
    { ...handwriting, workSource: { ...photo, version: 1 } },
    { ...handwriting, workSource: { ...photo, physicalPage: 4 } },
    { ...handwriting, photoStorageKey: "old/photo" }, { ...handwriting, steps: [] },
  ])("withholds photo mastery without matching evidence", async evidence => {
    const { service } = gradingFixture(() => evidence, { ...proposal, outcome: "correct" });
    await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: "unverified" });
  });

  it("keeps normal grading on a current learner-confirmed glyph", async () => {
    const { service } = gradingFixture(() => ({
      ...handwriting, confirmations: [{ stepId: "step", tokenId: "sign", confirmedText: "+" }],
    }));
    await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: "incorrect" });
  });

  it("does not penalize a photo when the learner confirms only one critical glyph", async () => {
    const step = handwriting.steps[0]!;
    const { service } = gradingFixture(() => ({
      ...handwriting,
      steps: [{ ...step, ast: { ...step.ast, tokens: [...step.ast.tokens, { tokenId: "digit", kind: "digit", rawText: "8", confidence: 0.5 }] } }],
      confirmations: [{ stepId: "step", tokenId: "sign", confirmedText: "+" }],
    }));
    await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: "unverified" });
  });

  it("keeps normal grading for high-confidence tokens without a confirmation", async () => {
    const step = handwriting.steps[0]!;
    const { service } = gradingFixture(() => ({
      ...handwriting, steps: [{ ...step, ast: { ...step.ast, tokens: step.ast.tokens.map(token => ({ ...token, confidence: 0.95 })) } }],
    }));
    await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: "incorrect" });
  });

  it("still applies rubric qualification after handwriting confirmation", async () => {
    const rubricCalibration: ai.OpeningRubricCalibrationHook = () => ({
      submission: { dimension: "task_response", comparisons: [], mode: "formal_assessment", assisted: false },
      calibration: null,
    });
    const { service } = gradingFixture(() => ({
      ...handwriting, confirmations: [{ stepId: "step", tokenId: "sign", confirmedText: "+" }],
    }), proposal, rubricCalibration);
    await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: "unverified" });
  });

  it("returns a retryable diagnostic before reserving or sending on lookup failure", async () => {
    const failure = new Error("Evidence lookup failed");
    ai.recordGradingDiagnostic(failure, "parse", undefined, "GRADING_PARSE");
    const lookup = vi.fn().mockRejectedValueOnce(failure).mockResolvedValueOnce({
      ...handwriting, confirmations: [{ stepId: "step", tokenId: "sign", confirmedText: "-" }],
    });
    const { service, reserve, complete } = gradingFixture(lookup);
    const error = await service.grade(scope, input).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(ai.readGradingDiagnostic(error)?.code).toBe("GRADING_PARSE");
    expect(reserve).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    await expect(service.grade(scope, input)).resolves.toMatchObject({ outcome: "incorrect" });
    expect(reserve).toHaveBeenCalledTimes(1);
  });
});

it("maps hesitations on the original PCM timeline and caps opted-in raw audio retention", () => {
  const { receipt, retention, transcriptDigest } = ai.buildOpeningSpeechTimingEvidence({
    timing: { receiptId: "speech", totalOriginalDurationMs: 3000, issuedAtMs: 1000, voicedSegments: [
      { originalStartMs: 100, originalEndMs: 500, strippedStartMs: 0, strippedEndMs: 400 },
      { originalStartMs: 2100, originalEndMs: 2500, strippedStartMs: 400, strippedEndMs: 800 },
    ], words: [{ word: "hello", startMs: 10, endMs: 400 }, { word: "world", startMs: 400, endMs: 700 }] },
    audio: { mediaBytesUsed: 0, recordingBytes: 100, mediaQuotaBytes: 1000, maxRecordingDurationMs: 5000,
      learnerOptInReplay: true, requestedRetentionUntilMs: 2 * 86_400_000 },
  });
  expect(receipt?.midClauseHesitationPauses).toMatchObject([{ startMs: 500, endMs: 2100, durationMs: 1600 }]);
  expect(transcriptDigest).toBe("sha256:b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9");
  expect(retention).toMatchObject({ retainRawAudio: true, deleteDeadlineMs: 86_401_000 });
});

const settings: OpeningAiSettings = {
  mode: "automatic", defaultModelId: "flagship",
  routes: { listen: null, hint: null, explain: null, think_together: null },
  taskRoutes: { "tutor.hint": { primary: null, fallback: "flagship" } },
};
const model = (id: string) => ({
  id, modelName: id, label: id, providerId: "provider", providerLabel: "Provider", availability: "available" as const,
  inputCentsPerMillion: 1, outputCentsPerMillion: 1,
}) satisfies OpeningModelSummary;
const catalog = [
  { ...model("flagship"), credentialMode: "platform", platformProfile: "flagship" },
  { ...model("distilled"), credentialMode: "platform", platformProfile: "distilled_cached" },
  { ...model("user-key"), credentialMode: "byok" },
] satisfies ai.OpeningMarginModel[];
const guardrail = {
  accountId: "account", currency: "USD", recognizedRevenueMicros: 2000n,
  channelAndRefundReserveMicros: 0n, fixedInfraReserveMicros: 0n, periodSpendMicros: 0n, dailySpendMicros: 0n,
};
const routing = {
  models: catalog, settings, serverDefaultId: null, guardrail, credentialMode: "platform" as const, task: "tutor.hint" as const,
  economicalRoute: { settings: { ...settings, defaultModelId: "distilled" }, serverDefaultId: null },
  estimatedPlatformCostMicros: 10n,
};

describe("Opening margin routing", () => {
  it.each([
    [489n, "normal", "flagship"], [490n, "economical_70_90", "distilled"],
    [630n, "deterministic_90_100", undefined], [700n, "zero_cost_floor_100", undefined],
  ])("authorizes the configured catalog at spend %s", (periodSpendMicros, tier, modelId) => {
    const result = ai.resolveOpeningMarginRoute({ ...routing, guardrail: { ...guardrail, periodSpendMicros } });
    expect(result.authorization.effectiveTier).toBe(tier);
    expect(result.model?.id).toBe(modelId);
  });

  it("switches before a projected daily burst and keeps exam grading on the flagship lane", () => {
    expect(ai.resolveOpeningMarginRoute({ ...routing, guardrail: { ...guardrail, dailySpendMicros: 45n } }))
      .toMatchObject({ model: { id: "distilled" }, authorization: { upgradedByDailyBurstProjection: true } });
    expect(ai.resolveOpeningMarginRoute({
      ...routing, task: "practice.grade-text", localResolution: "irreducible_ambiguous", guardrail: { ...guardrail, periodSpendMicros: 490n },
    }))
      .toMatchObject({ model: { id: "flagship" }, authorization: { effectiveTier: "economical_70_90" } });
  });

  it("allows paid irreducible work at tier two after an explicit local-first outcome", () => {
    expect(ai.resolveOpeningMarginRoute({ ...routing, localResolution: "irreducible_ambiguous", guardrail: { ...guardrail, periodSpendMicros: 630n } }))
      .toMatchObject({ model: { id: "flagship" }, authorization: { target: "platform_irreducible_only" } });
  });

  it.each(["local_verify", "flashcard_review", "local_socratic_rule", "material_reading"] as const)("keeps %s active for an exhausted account", localAction => {
    const result = ai.resolveOpeningMarginRoute({ localAction, guardrail: { ...guardrail, periodSpendMicros: 700n } });
    expect(result).toMatchObject({ model: null, authorization: { target: "local_zero_cost", denialReason: null, platformBudgetDebitMicros: 0n } });
  });

  it("keeps BYOK active at exhaustion and refuses a configured platform fallback", () => {
    const byok = { ...routing, credentialMode: "byok" as const, guardrail: { ...guardrail, periodSpendMicros: 700n },
      settings: { ...settings, defaultModelId: "user-key" } };
    expect(ai.resolveOpeningMarginRoute(byok)).toMatchObject({
      model: { id: "user-key" },
      guardrail: { allowPlatformCredentialFallbackForByok: false },
      authorization: { allowByokModelCall: true, allowPaidModelCall: false, platformBudgetDebitMicros: 0n },
    });
    expect(ai.resolveOpeningMarginRoute({ ...byok, attempt: "fallback" }).model).toBeNull();
  });
});
