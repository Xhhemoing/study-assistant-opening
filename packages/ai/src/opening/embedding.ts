import type { ProviderInput } from "@aistudy/contracts";
import { runBudgetedCall, type BudgetedRepository } from "./budgeted-call";
import { classifyProviderFailure } from "./errors";
import { OpeningProviderError, type OpeningFetch } from "./provider";
import { assertOpeningProviderEndpoint, fetchOpeningProvider, OpeningProviderEndpointError } from "./provider-network";
import type { ParentInteractionBudget } from "./parent-interaction-budget";

export type EmbeddingModel = {
  baseUrl: string; apiKey: string; modelName: string; modelKey: string; dimensions: number;
  requestDimensions?: boolean; inputCentsPerMillion: number;
  billing: "metered" | "free_tier"; dailyRequestCap: number | null;
};
export type EmbeddingResult = { vectors: number[][]; inputTokens: number | null; requestId: string | null };
export type EmbeddingReceipt = { reservationId: string; settledCents: number | null };

function parseResult(raw: unknown, count: number, dimensions: number, requestId: string | null): EmbeddingResult {
  const fail = () => new OpeningProviderError("PROVIDER_RESPONSE", "资料检索模型返回了无效向量。", false, true);
  if (typeof raw !== "object" || raw === null) throw fail();
  const body = raw as { data?: unknown; usage?: { prompt_tokens?: unknown } };
  if (!Array.isArray(body.data) || body.data.length !== count) throw fail();
  const vectors: number[][] = Array.from({ length: count });
  for (const item of body.data) {
    if (!item || !Number.isInteger(item.index) || item.index < 0 || item.index >= count || vectors[item.index]
      || !Array.isArray(item.embedding) || item.embedding.length !== dimensions
      || !item.embedding.every((value: unknown) => typeof value === "number" && Number.isFinite(value))
      || !item.embedding.some((value: number) => value !== 0)) throw fail();
    vectors[item.index] = item.embedding;
  }
  const usage = body.usage?.prompt_tokens;
  if (usage !== undefined && (typeof usage !== "number" || !Number.isSafeInteger(usage) || usage < 0)) throw fail();
  return { vectors, inputTokens: typeof usage === "number" ? usage : null, requestId: requestId?.slice(0, 200) ?? null };
}

/** Real OpenAI-compatible embeddings, using the same pinned, redirect-free transport as chat. */
export function createOpeningEmbeddingProvider(config: EmbeddingModel, options: { fetchImpl?: OpeningFetch; timeoutMs?: number } = {}) {
  if (!config.apiKey) throw new OpeningProviderError("PROVIDER_REQUEST", "资料检索模型尚未配置密钥。");
  try { assertOpeningProviderEndpoint(config.baseUrl); }
  catch { throw new OpeningProviderError("PROVIDER_REQUEST", "资料检索模型地址不可用。"); }
  return {
    async embed(inputs: string[], callerSignal?: AbortSignal): Promise<EmbeddingResult> {
      validateInputs(inputs);
      if (callerSignal?.aborted) throw new OpeningProviderError("PROVIDER_REQUEST", "资料检索已取消。");
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      callerSignal?.addEventListener("abort", onAbort, { once: true });
      const timer = setTimeout(onAbort, options.timeoutMs ?? 60_000);
      let sent = false;
      try {
        sent = true;
        const response = await (options.fetchImpl ?? fetchOpeningProvider)(`${config.baseUrl.replace(/\/+$/, "")}/embeddings`, {
          method: "POST", signal: controller.signal, redirect: "error",
          headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: config.modelName, input: inputs, encoding_format: "float",
            ...(config.requestDimensions === false ? {} : { dimensions: config.dimensions }) }),
        });
        if (!response.ok) {
          await response.body?.cancel();
          const failure = classifyProviderFailure(response.status);
          throw new OpeningProviderError(failure.code, "资料检索模型请求失败。", failure.retryable, true);
        }
        let body: unknown;
        try { body = await response.json(); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          throw new OpeningProviderError("PROVIDER_RESPONSE", "资料检索模型返回了无效内容。", false, true);
        }
        return parseResult(body, inputs.length, config.dimensions, response.headers.get("x-request-id"));
      } catch (error) {
        if (error instanceof OpeningProviderError) throw error;
        if (error instanceof OpeningProviderEndpointError) throw new OpeningProviderError("PROVIDER_REQUEST", "资料检索模型地址不可用。", false, sent);
        if (callerSignal?.aborted) throw new OpeningProviderError("PROVIDER_ABORTED", "资料检索已取消。", false, sent);
        if (controller.signal.aborted) throw new OpeningProviderError("PROVIDER_TIMEOUT", "资料检索模型请求超时。", true, sent);
        throw new OpeningProviderError("PROVIDER_NETWORK", "资料检索模型连接失败。", true, sent);
      } finally {
        clearTimeout(timer);
        callerSignal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

function validateInputs(inputs: string[]): number {
  if (!inputs.length || inputs.length > 32 || inputs.some(text => !text.trim() || Buffer.byteLength(text, "utf8") > 8192)) {
    throw new OpeningProviderError("PROVIDER_REQUEST", "资料检索每批需要 1–32 段非空文本，每段最多 8192 字节。");
  }
  return inputs.reduce((sum, text) => sum + Buffer.byteLength(text, "utf8"), 0);
}

/** Vectors stay outside the text response contract; only the usage receipt enters the shared ledger. */
export async function runBudgetedEmbedding(options: {
  config: EmbeddingModel; inputs: string[]; budget: BudgetedRepository; operationId: string;
  parentBudget?: ParentInteractionBudget;
  beforeSend?: () => Promise<void>; persistResult?: (result: EmbeddingResult, receipt: EmbeddingReceipt) => Promise<void>;
  resultRef?: string; signal?: AbortSignal; fetchImpl?: OpeningFetch; timeoutMs?: number;
}): Promise<EmbeddingResult> {
  const bytes = validateInputs(options.inputs);
  const provider = createOpeningEmbeddingProvider(options.config, { fetchImpl: options.fetchImpl, timeoutMs: options.timeoutMs });
  const free = options.config.billing === "free_tier";
  const price = options.config.inputCentsPerMillion;
  let result: EmbeddingResult | undefined;
  const input: ProviderInput = { instruction: "Embed supplied text.", text: "", chunks: [], mode: "explain",
    maxOutputTokens: 1, mediaCapability: "text_only", imageParts: [] };
  await runBudgetedCall({
    budget: options.budget, input, requestId: options.operationId, operationId: options.operationId, parentBudget: options.parentBudget,
    purpose: "material-embedding", resultRef: options.resultRef, signal: options.signal, beforeSend: options.beforeSend,
    modelSnapshot: { id: "embedding", providerId: "embedding", modelName: options.config.modelName,
      inputCentsPerMillion: price, outputCentsPerMillion: 0 },
    reservedCents: free ? 0 : Math.max(1, Math.ceil(bytes * price / 1_000_000)),
    actualCents: output => free ? 0 : Math.ceil(output.inputTokens! * price / 1_000_000),
    ...(free ? { requestCapPerDay: options.config.dailyRequestCap ?? undefined } : {}),
    provider: { async complete(_input, signal) {
      result = await provider.embed(options.inputs, signal);
      return { text: "", citedChunkIds: [], candidates: [], requestId: result.requestId, inputTokens: result.inputTokens, outputTokens: 0 };
    } },
    persistResult: options.persistResult ? async (_output, receipt) => options.persistResult!(result!, receipt) : undefined,
  });
  return result!;
}
