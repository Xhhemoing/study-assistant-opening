import { createSessionFetch } from "../../auth/session-expiry";
import { OpeningApiError } from "../client/api";
import { parseOpeningResponse } from "../client/parse-response";
import { weakPointsSummarySchema } from "./weak-points-model";

export async function readWeakPoints(signal?: AbortSignal, transport: typeof fetch = fetch) {
  const response = await createSessionFetch(transport)("/api/opening/review/weak-points", { method: "GET", cache: "no-store", signal });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new OpeningApiError(response.status, "易错点暂时无法读取，请稍后重试。");
  return parseOpeningResponse(weakPointsSummarySchema, body);
}
