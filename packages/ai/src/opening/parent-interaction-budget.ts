export { assertParentInteractionBudget, DEFAULT_PARENT_INTERACTION_MAX_PROVIDER_CALLS, hasMediaInput, mediaInputCostBound, type ParentInteractionBudget } from "@aistudy/domain/opening/ai-policy";
export type { MediaInputCostBound } from "@aistudy/contracts";

/** All admitted bytes must satisfy the exact provider configuration used for the bound. */
export function mediaInputBytes(input: { imageParts?: Array<{ data: string }>; audioParts?: Array<{ data: string }> }): number {
  const parts = [...(input.imageParts ?? []).map(image => image.data.split(",")[1] ?? ""), ...(input.audioParts ?? []).map(audio => audio.data)];
  if (parts.some(data => !data || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))) throw new Error("invalid media encoding");
  return parts.reduce((bytes, data) => bytes + Buffer.byteLength(data, "base64"), 0);
}
