import type { ProviderOutput } from "@aistudy/contracts";

export type OpeningUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  estimated: boolean;
};

export type OpeningPricing = {
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
  cachedInputCentsPerMillion?: number;
};

export type ParsedProviderUsage = {
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
};

function parseOptionalNonNegativeSafeInt(value: unknown): { ok: true; value: number | null } | { ok: false } {
  if (value == null) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return { ok: false };
  return { ok: true, value };
}

/**
 * Strictly parse OpenAI-compatible usage payloads, extracting cached prompt tokens from
 * `prompt_tokens_details.cached_tokens`, `prompt_cache_hit_tokens`, or `cache_read_input_tokens`.
 * Clamps cached tokens to `<= inputTokens` when `inputTokens` is present unless `options.clamp === false`.
 * Returns `null` when any present usage field is malformed.
 */
export function parseProviderUsage(
  rawUsage: unknown,
  options?: { clamp?: boolean },
): ParsedProviderUsage | null {
  if (rawUsage == null) {
    return { inputTokens: null, outputTokens: null, cachedInputTokens: null };
  }
  if (typeof rawUsage !== "object" || Array.isArray(rawUsage)) {
    return null;
  }
  const usage = rawUsage as Record<string, unknown>;
  const input = parseOptionalNonNegativeSafeInt(usage.prompt_tokens);
  const output = parseOptionalNonNegativeSafeInt(usage.completion_tokens);
  if (!input.ok || !output.ok) return null;

  const detailsRaw = usage.prompt_tokens_details;
  if (detailsRaw != null && (typeof detailsRaw !== "object" || Array.isArray(detailsRaw))) {
    return null;
  }
  const details = detailsRaw as Record<string, unknown> | null | undefined;
  const detailsCached = parseOptionalNonNegativeSafeInt(details?.cached_tokens);
  const hitCached = parseOptionalNonNegativeSafeInt(usage.prompt_cache_hit_tokens);
  const readCached = parseOptionalNonNegativeSafeInt(usage.cache_read_input_tokens);
  if (!detailsCached.ok || !hitCached.ok || !readCached.ok) return null;

  const shouldClamp = options?.clamp !== false;
  const rawCached = detailsCached.value ?? hitCached.value ?? readCached.value;
  const cachedInputTokens = rawCached === null
    ? null
    : shouldClamp && input.value !== null
      ? Math.min(rawCached, input.value)
      : rawCached;

  return {
    inputTokens: input.value,
    outputTokens: output.value,
    cachedInputTokens,
  };
}

function clampCachedTokens(inputTokens: number, cachedInputTokens: number | undefined): number {
  if (typeof cachedInputTokens !== "number" || !Number.isFinite(cachedInputTokens)) return 0;
  return Math.min(Math.max(0, inputTokens), Math.max(0, cachedInputTokens));
}

export function extractUsage(
  usage: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    cached_input_tokens?: unknown;
    prompt_tokens_details?: unknown;
    prompt_cache_hit_tokens?: unknown;
    cache_read_input_tokens?: unknown;
  } | undefined,
  text: string,
  inputTokensFallback: number,
): OpeningUsage {
  const inputTokens = typeof usage?.input_tokens === "number"
    ? usage.input_tokens
    : inputTokensFallback;
  const outputTokens = typeof usage?.output_tokens === "number"
    ? usage.output_tokens
    : Math.max(1, Math.ceil(text.length / 4));
  const details = usage?.prompt_tokens_details && typeof usage.prompt_tokens_details === "object" && !Array.isArray(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details as Record<string, unknown>
    : undefined;
  const rawCached = [
    usage?.cached_input_tokens,
    details?.cached_tokens,
    usage?.prompt_cache_hit_tokens,
    usage?.cache_read_input_tokens,
  ].find((candidate): candidate is number => typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0);
  return {
    inputTokens,
    outputTokens,
    ...(rawCached !== undefined ? { cachedInputTokens: clampCachedTokens(inputTokens, rawCached) } : {}),
    estimated: usage?.input_tokens === undefined || usage?.output_tokens === undefined,
  };
}

export function estimateUsage(
  usage: OpeningUsage,
  pricing: OpeningPricing,
): number {
  const cachedRate = pricing.cachedInputCentsPerMillion ?? pricing.inputCentsPerMillion;
  if (cachedRate === pricing.inputCentsPerMillion) {
    return Math.ceil(
      (usage.inputTokens * pricing.inputCentsPerMillion
        + usage.outputTokens * pricing.outputCentsPerMillion) / 1_000_000,
    );
  }
  const cached = clampCachedTokens(usage.inputTokens, usage.cachedInputTokens);
  const uncached = usage.inputTokens - cached;
  return Math.ceil(
    (uncached * pricing.inputCentsPerMillion
      + cached * cachedRate
      + usage.outputTokens * pricing.outputCentsPerMillion) / 1_000_000,
  );
}

export function usageFromOutput(output: ProviderOutput): OpeningUsage {
  return extractUsage(
    output.inputTokens === null || output.outputTokens === null
      ? undefined
      : {
        input_tokens: output.inputTokens,
        output_tokens: output.outputTokens,
        ...(output.cachedInputTokens != null ? { cached_input_tokens: output.cachedInputTokens } : {}),
      },
    output.text,
    0,
  );
}

type TokenRates = OpeningPricing;

/** Local cost bound for a reservation. Not a vendor billing guarantee. */
export function reservationCentsForInput(serializedInput: string, maxOutputTokens: number, rates: TokenRates): number {
  const inputTokens = new TextEncoder().encode(serializedInput).length + 4096;
  return Math.ceil((inputTokens * rates.inputCentsPerMillion + maxOutputTokens * rates.outputCentsPerMillion) / 1_000_000);
}

export function actualCentsForOutput(output: ProviderOutput, rates: TokenRates): number {
  return estimateUsage(usageFromOutput(output), rates);
}
