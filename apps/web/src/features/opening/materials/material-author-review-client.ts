import { uuidSchema } from "@aistudy/contracts";

/** Host-provided selection only. Neither actorKey nor accessEpoch grants access. */
export type MaterialAuthorSelector = {
  actorKey: string;
  courseId: string;
  sourceId: string;
  version: number;
  accessEpoch: string | number;
};

export type MaterialAuthorReviewUnavailable = {
  status: "unavailable";
  reason: "manifest_reader_disabled";
  authorReview: null;
  contents: [];
  publishable: false;
};

export type MaterialAuthorReviewFailure =
  | "invalid_selection" | "session" | "not_found" | "stale"
  | "unavailable" | "invalid_response" | "network";

export class MaterialAuthorReviewError extends Error {
  constructor(readonly code: MaterialAuthorReviewFailure) {
    // Do not retain response text, URLs, thrown messages or a raw error cause.
    super("Material author review unavailable");
    this.name = "MaterialAuthorReviewError";
  }
}

const fields = ["status", "reason", "authorReview", "contents", "publishable"];
function parseUnavailable(raw: unknown): MaterialAuthorReviewUnavailable {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
    || Object.keys(raw).length !== fields.length
    || !Object.keys(raw).every(key => fields.includes(key))) {
    throw new MaterialAuthorReviewError("invalid_response");
  }
  const value = raw as Record<string, unknown>;
  if (value.status !== "unavailable" || value.reason !== "manifest_reader_disabled"
    || value.authorReview !== null || !Array.isArray(value.contents)
    || value.contents.length !== 0 || value.publishable !== false) {
    throw new MaterialAuthorReviewError("invalid_response");
  }
  return { status: "unavailable", reason: "manifest_reader_disabled",
    authorReview: null, contents: [], publishable: false };
}

/** Explicit transport injection: no default/global fetch, alternate endpoint or
 * authority parameters. The real GET remains the authentication boundary. */
export async function fetchMaterialAuthorReview(
  selector: MaterialAuthorSelector,
  options: { fetch: typeof fetch; signal: AbortSignal },
): Promise<MaterialAuthorReviewUnavailable> {
  if (!uuidSchema.safeParse(selector.courseId).success
    || !uuidSchema.safeParse(selector.sourceId).success
    || !Number.isSafeInteger(selector.version) || selector.version < 0
    || selector.version > 2_147_483_647) {
    throw new MaterialAuthorReviewError("invalid_selection");
  }
  const query = new URLSearchParams({ sourceId: selector.sourceId, version: String(selector.version) });
  let response: Response;
  try {
    response = await options.fetch(`/api/opening/courses/${selector.courseId}/material-author-review?${query}`, {
      method: "GET", mode: "same-origin", credentials: "same-origin",
      cache: "no-store", redirect: "error", signal: options.signal,
    });
  } catch {
    throw new MaterialAuthorReviewError("network");
  }
  if (response.status !== 200) {
    const code = response.status === 401 ? "session" : response.status === 404 ? "not_found"
      : response.status === 409 ? "stale" : "unavailable";
    throw new MaterialAuthorReviewError(code);
  }
  if (response.redirected) throw new MaterialAuthorReviewError("invalid_response");
  let raw: unknown;
  try { raw = await response.json(); }
  catch { throw new MaterialAuthorReviewError("invalid_response"); }
  return parseUnavailable(raw);
}
