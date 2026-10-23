import { aiGradingProposalSchema, gradingEvaluationDatasetSchema, gradingEvaluationRunSchema, providerOutputSchema, type GradingEvaluationRun } from "@aistudy/contracts";
import { buildAnswerGradingInput } from "./answer-grading";
import { createOpeningProvider, OpeningProviderError, type OpeningFetch } from "./provider";
import { fetchOpeningProvider } from "./provider-network";

type CaseStatus = "not_started" | "valid_output" | "invalid_model_output" | "provider_error" | "photo_not_supported" | "request_limit_reached";
type CaseCollection = {
  caseId: string; caseVersion: string; status: CaseStatus; errorCode?: string;
  rawMessageContent: string | null; rawMessageLength: number | null;
  requestId: string | null; inputTokens: number | null; outputTokens: number | null; elapsedMs: number | null;
};
export type GradingCollection = {
  run: GradingEvaluationRun;
  collection: { status: "in_progress" | "completed"; textOnly: true; maxRequests: number; requestCount: number; elapsedMs: number; cases: CaseCollection[] };
};
export type GradingCollectionOptions = {
  baseUrl: string; apiKey: string; model: string; maxRequests: number; timeoutMs?: number;
  /** Trusted fixture injection only; runtime configuration never supplies a transport. */
  fetchImpl?: OpeningFetch;
  onProgress?: (snapshot: GradingCollection) => Promise<void>;
};

function isGradingJson(text: string): boolean {
  try { return aiGradingProposalSchema.safeParse(JSON.parse(text)).success; }
  catch { return false; }
}

/** Explicit offline collection: no learner writes, fallback models or automatic retries. */
export async function collectGradingRun(rawDataset: unknown, options: GradingCollectionOptions): Promise<GradingCollection> {
  const dataset = gradingEvaluationDatasetSchema.parse(rawDataset);
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 1000
    || !options.apiKey.trim() || !options.model.trim() || options.model.length > 160
    || options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000 || options.timeoutMs > 120_000)) {
    throw new Error("Invalid grading collection configuration");
  }
  const startedAt = performance.now();
  let captured: string | null = null;
  let requestCount = 0;
  let activeCase: CaseCollection | null = null;
  const transport: OpeningFetch = options.fetchImpl ?? ((url, init) => fetchOpeningProvider(String(url), init ?? {}));
  const provider = createOpeningProvider({
    baseUrl: options.baseUrl, apiKey: options.apiKey, model: options.model, timeoutMs: options.timeoutMs,
    fetchImpl: async (url, init) => {
      requestCount += 1;
      const response = await transport(url, init);
      if (response.ok) {
        // Capture transport diagnostics separately; only the adapter's successful
        // decoded output can become an evaluation result.
        try {
          const body = await response.clone().json() as { id?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
            choices?: Array<{ message?: { content?: unknown } }> } | null;
          const content = body?.choices?.[0]?.message?.content;
          if (typeof content === "string") captured = content;
          if (activeCase) {
            const id = providerOutputSchema.shape.requestId.safeParse(body?.id ?? null);
            const input = providerOutputSchema.shape.inputTokens.safeParse(body?.usage?.prompt_tokens ?? null);
            const output = providerOutputSchema.shape.outputTokens.safeParse(body?.usage?.completion_tokens ?? null);
            if (id.success) activeCase.requestId = id.data;
            if (input.success) activeCase.inputTokens = input.data;
            if (output.success) activeCase.outputTokens = output.data;
          }
        } catch { /* The provider adapter rejects malformed response envelopes. */ }
      }
      return response;
    },
  });
  const snapshot: GradingCollection = {
    run: gradingEvaluationRunSchema.parse({ datasetId: dataset.datasetId, datasetVersion: dataset.datasetVersion,
      modelLabel: options.model, completedAt: new Date().toISOString(), provenance: options.fetchImpl ? "test_fixture" : "real_provider",
      results: dataset.cases.map(test => ({ caseId: test.id, caseVersion: test.version, input: test.input, rawOutput: "" })) }),
    collection: { status: "in_progress", textOnly: true, maxRequests: options.maxRequests, requestCount: 0, elapsedMs: 0,
      cases: dataset.cases.map(test => ({ caseId: test.id, caseVersion: test.version, status: "not_started", rawMessageContent: null,
        rawMessageLength: null, requestId: null, inputTokens: null, outputTokens: null, elapsedMs: null })) },
  };
  await options.onProgress?.(snapshot);
  for (const [index, test] of dataset.cases.entries()) {
    const record = snapshot.collection.cases[index]!;
    if (test.modality === "photo") record.status = "photo_not_supported";
    else if (snapshot.collection.requestCount >= options.maxRequests) record.status = "request_limit_reached";
    else {
      captured = null;
      activeCase = record;
      const requestStartedAt = performance.now();
      let failed = false;
      let decoded: string | null = null;
      try {
        // Deliberately select only input fields. Candidate labels, review truth,
        // rationale, error groups and reviewer identities never reach the model.
        const output = await provider.complete(buildAnswerGradingInput({ question: test.input.question,
          answer: test.input.answer, referenceText: test.input.referenceText, imageParts: [] }));
        decoded = output.text;
      } catch (error) {
        failed = true;
        record.errorCode = error instanceof OpeningProviderError ? error.code : "COLLECTION_REQUEST_FAILED";
      }
      activeCase = null;
      record.elapsedMs = performance.now() - requestStartedAt;
      snapshot.collection.requestCount = requestCount;
      const raw: string = captured ?? "";
      record.rawMessageContent = captured === null ? null : raw.slice(0, 80_000);
      record.rawMessageLength = captured === null ? null : raw.length;
      if (failed && raw.length > 80_000) {
        record.status = "invalid_model_output"; record.errorCode = "COLLECTION_OUTPUT_TOO_LARGE";
      } else if (failed) {
        record.status = record.errorCode === "PROVIDER_RESPONSE" && !isGradingJson(raw) ? "invalid_model_output" : "provider_error";
      } else {
        snapshot.run.results[index]!.rawOutput = decoded!;
        record.status = isGradingJson(decoded!) ? "valid_output" : "invalid_model_output";
      }
    }
    snapshot.run.completedAt = new Date().toISOString();
    snapshot.collection.elapsedMs = performance.now() - startedAt;
    await options.onProgress?.(snapshot);
  }
  snapshot.collection.status = "completed";
  snapshot.collection.elapsedMs = performance.now() - startedAt;
  await options.onProgress?.(snapshot);
  return snapshot;
}
