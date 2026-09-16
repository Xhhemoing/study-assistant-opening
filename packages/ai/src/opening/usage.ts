import type { ProviderOutput } from "@aistudy/contracts";

export type OpeningUsage = {
  inputTokens: number;
  outputTokens: number;
  estimated: boolean;
};

export type OpeningPricing = {
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
};

export function extractUsage(
  usage: { input_tokens?: unknown; output_tokens?: unknown } | undefined,
  text: string,
  inputTokensFallback: number,
): OpeningUsage {
  const inputTokens = typeof usage?.input_tokens === "number"
    ? usage.input_tokens
    : inputTokensFallback;
  const outputTokens = typeof usage?.output_tokens === "number"
    ? usage.output_tokens
    : Math.max(1, Math.ceil(text.length / 4));
  return {
    inputTokens,
    outputTokens,
    estimated: usage?.input_tokens === undefined || usage?.output_tokens === undefined,
  };
}

export function estimateUsage(
  usage: OpeningUsage,
  pricing: OpeningPricing,
): number {
  return Math.ceil(
    (usage.inputTokens * pricing.inputCentsPerMillion
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
      },
    output.text,
    0,
  );
}
