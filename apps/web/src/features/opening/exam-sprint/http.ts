import "server-only";
import { jsonError, mapDomainError } from "../../auth/service";
import { EXAM_SPRINT_EXPORT } from "./labels";

export async function examSprintResponse(run: () => Promise<unknown>, download = false): Promise<Response> {
  let response: Response;
  try {
    response = Response.json(await run());
    if (download) response.headers.set("Content-Disposition", `attachment; filename="${EXAM_SPRINT_EXPORT.filename}"`);
  } catch (error) {
    const mapped = mapDomainError(error);
    if (error instanceof Error && "businessCode" in error && error.businessCode === "EXAM_REVIEW_EPOCH_EXPIRED") {
      Object.assign(mapped, { businessCode: "EXAM_REVIEW_EPOCH_EXPIRED" });
    } else if (error instanceof Error && "examReceiptCommitted" in error && error.examReceiptCommitted === true) {
      Object.assign(mapped, { businessCode: "EXAM_RECEIPT_COMMITTED" });
    }
    response = jsonError(mapped);
  }
  response.headers.set("Cache-Control", "no-store");
  return response;
}
