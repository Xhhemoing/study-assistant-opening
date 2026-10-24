"use client";
import { conceptPreviewRequestSchema, conceptPreviewResponseSchema, type ConceptPreviewRequest, type ConceptPreviewResponse } from "./preview-contract";
import { acknowledgeStudyExposure } from "../assistant/study-exposure-ack";

/** No persistent cache: each explicit intent rechecks current policy server-side. */
export async function requestConceptPreview(input: ConceptPreviewRequest, options: { signal?: AbortSignal } = {}): Promise<ConceptPreviewResponse> {
  const request = conceptPreviewRequestSchema.parse(input);
  const response = await fetch("/api/opening/concepts/preview", {
    method: "POST", headers: { "Content-Type": "application/json" }, credentials: "same-origin", cache: "no-store",
    body: JSON.stringify(request), signal: options.signal,
  });
  if (!response.ok) {
    let message = `Concept preview request failed (${response.status})`;
    try {
      const error: unknown = await response.json();
      if (error && typeof error === "object" && "error" in error) {
        const detail = error.error;
        if (typeof detail === "string") message = `${detail} (${response.status})`;
        else if (detail && typeof detail === "object" && "message" in detail && typeof detail.message === "string") message = `${detail.message} (${response.status})`;
      }
    } catch { /* Empty/invalid error bodies retain the HTTP status. */ }
    throw new Error(message);
  }
  const result = conceptPreviewResponseSchema.parse(await response.json());
  if (result.status === "available") {
    const { locator, selection } = result;
    if (locator.sourceId !== request.sourceId || locator.sourceVersion !== request.sourceVersion || locator.page !== request.page || result.term !== request.term ||
      selection.text !== (request.selection?.text ?? request.term) ||
      (request.selection?.start != null && (selection.start !== request.selection.start || selection.end !== request.selection.end)) ||
      result.exposureReceipts.some(receipt => !new RegExp(`^concept-preview:${request.clientKey}:[a-f0-9]{64}$`).test(receipt.releaseKey))) {
      throw new Error("Concept preview response does not match request");
    }
    // Deliberately independent of preview cancellation; failure never undoes release.
    for (const receipt of result.exposureReceipts) void acknowledgeStudyExposure(receipt).catch(() => undefined);
  }
  return result;
}
