import type { ActionDigest } from "@aistudy/contracts";

export type ActionDigestCardModel = {
  digest: ActionDigest | null;
  error: string;
  loading: boolean;
};

export function emptyActionDigest(): ActionDigest {
  return { primary: [], pendingConfirmationCount: 0 };
}

/** Pure helper: rejected suggestions never appear in primary. */
export function digestSurfacesPendingOnly(digest: ActionDigest): boolean {
  return digest.primary.every((c) => c.status === "pending");
}

export function reduceActionDigestCard(
  state: ActionDigestCardModel,
  event:
    | { type: "load_start" }
    | { type: "load_ok"; digest: ActionDigest }
    | { type: "load_fail"; message: string }
    | { type: "decide_ok"; digest: ActionDigest }
    | { type: "decide_fail"; message: string }
    | { type: "clear_error" },
): ActionDigestCardModel {
  switch (event.type) {
    case "load_start":
      return { ...state, loading: true, error: "" };
    case "load_ok":
    case "decide_ok":
      return { digest: event.digest, loading: false, error: "" };
    case "load_fail":
      return { ...state, loading: false, error: event.message };
    case "decide_fail":
      return { ...state, loading: false, error: event.message };
    case "clear_error":
      return { ...state, error: "" };
    default:
      return state;
  }
}
