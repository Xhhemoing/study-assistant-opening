import type { OpeningReservationModel, ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { hasMediaInput, mediaInputCostBound } from "./parent-interaction-budget";
import { OpeningModelRoutingError } from "./model-routing-error";
import { openingProviderRequestBody } from "./provider-request";
import { actualCentsForOutput, reservationCentsForInput } from "./usage";

export type ReservationTerms = {
  reservedCents: number;
  actualCents: (output: ProviderOutput) => number;
  requestCapPerDay?: number;
};

/**
 * How one call is reserved and settled. Paid models reserve the estimated token
 * cost (at least the floor); free-tier models reserve zero under their request cap.
 */
export function reservationTerms(model: OpeningReservationModel, input: ProviderInput, floorCents = 1): ReservationTerms {
  if (model.billing === "free_tier") {
    if (!model.dailyRequestCap) {
      throw new OpeningModelRoutingError("免费额度模型缺少每日请求上限，请到设置补全。");
    }
    return { reservedCents: 0, actualCents: () => 0, requestCapPerDay: model.dailyRequestCap };
  }
  const media = hasMediaInput(input);
  const bound = media ? mediaInputCostBound(model) ?? mediaInputCostBound(model.modelSnapshot) : null;
  const rates = { inputCentsPerMillion: bound ? Math.max(bound.mediaInputCentsPerMillion, model.inputCentsPerMillion) : model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion };
  // Encoded media bytes are transport, not text tokens. A verified provider
  // context limit supplies the media bound; all textual frames remain priced.
  const pricedInput = media ? { ...input, imageParts: input.imageParts.map(part => ({ ...part, data: "" })),
    ...(input.audioParts ? { audioParts: input.audioParts.map(part => ({ ...part, data: "" })) } : {}) } : input;
  const textReservation = reservationCentsForInput(JSON.stringify(openingProviderRequestBody(pricedInput, { model: model.modelSnapshot.modelName, answerStyle: true })), input.maxOutputTokens, rates);
  const mediaReservation = bound ? Math.ceil(bound.mediaInputTokenUpperBound * rates.inputCentsPerMillion / 1_000_000) : 0;
  return {
    reservedCents: Math.max(floorCents, textReservation + mediaReservation),
    actualCents: (output) => actualCentsForOutput(output, rates),
  };
}
