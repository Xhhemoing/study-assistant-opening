import { randomUUID } from "node:crypto";
import { uuidSchema, type StudyExposureReceipt } from "@aistudy/contracts";

/** A client may replay its delivery UUID; it cannot choose the help classification. */
export function contentDeliveryReleaseKey(request: Request): string {
  const selected = request.headers.get("x-study-release-key");
  return selected === null ? randomUUID() : uuidSchema.parse(selected);
}
export function contentDeliveryHeaders(receipts: readonly StudyExposureReceipt[]): Record<string, string> {
  return { "Cache-Control": "private, no-store", "X-Study-Exposure-Receipts": receipts.map(receipt => receipt.id).join(",") };
}
