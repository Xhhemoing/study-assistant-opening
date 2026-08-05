import {
  createPromotionRequestSchema,
  promotionResponseSchema,
  promotionsResponseSchema,
  type CreatePromotionRequest,
} from "@aistudy/contracts";
async function call(path: string, init?: RequestInit) {
  const response = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  if (!response.ok)
    throw new Error(body.error?.message ?? "Promotion request failed");
  return body;
}
export const PromotionApi = {
  async list(explorationId: string) {
    return promotionsResponseSchema.parse(
      await call(`/api/explorations/${explorationId}/promotions`),
    ).promotions;
  },
  async create(explorationId: string, input: CreatePromotionRequest) {
    const parsed = createPromotionRequestSchema.parse(input);
    return promotionResponseSchema.parse(
      await call(`/api/explorations/${explorationId}/promotions`, {
        method: "POST",
        body: JSON.stringify(parsed),
      }),
    ).promotion;
  },
  async accept(id: string) {
    return promotionResponseSchema.parse(
      await call(`/api/promotions/${id}/accept`, { method: "POST" }),
    ).promotion;
  },
  async reject(id: string) {
    return promotionResponseSchema.parse(
      await call(`/api/promotions/${id}/reject`, { method: "POST" }),
    ).promotion;
  },
};
