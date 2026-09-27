import { usageFromOutput } from "@aistudy/ai";

type Rates = { inputCentsPerMillion: number; outputCentsPerMillion: number };

/** Local cost bound. Not a vendor billing guarantee. */
export function tutorReservationCents(serializedInput: string, maxOutputTokens: number, rates: Rates): number {
  const inputTokens = Buffer.byteLength(serializedInput, "utf8") + 4096;
  return Math.ceil((inputTokens * rates.inputCentsPerMillion + maxOutputTokens * rates.outputCentsPerMillion) / 1_000_000);
}

export function tutorActualCents(output: unknown, rates: Rates): number {
  const usage = usageFromOutput(output as never);
  return Math.ceil((usage.inputTokens * rates.inputCentsPerMillion + usage.outputTokens * rates.outputCentsPerMillion) / 1_000_000);
}
