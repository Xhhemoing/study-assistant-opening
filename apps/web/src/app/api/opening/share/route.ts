import {
  ApiError,
  jsonError,
  mapDomainError,
} from "../../../../features/auth/service";
import { readOpeningRawBody } from "../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { SHARE_MINT_MAX_BODY_BYTES } from "../../../../features/opening/share/schema";
import {
  ShareTokenConfigError,
  ShareTokenValidationError,
  signPitfallShareToken,
} from "../../../../features/opening/share/token-codec";

async function readShareMintJsonBody(request: Request): Promise<unknown> {
  const raw = await readOpeningRawBody(request, SHARE_MINT_MAX_BODY_BYTES);
  if (raw.byteLength === 0) {
    throw new ApiError("VALIDATION", "JSON request body is required", 400);
  }
  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError("VALIDATION", "Invalid JSON request body", 400);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError("VALIDATION", "JSON object body is required", 400);
  }
  return parsed;
}

/**
 * Mint a stateless HMAC-SHA256 pitfall share token.
 * Requires an authenticated Opening scope and strictly strips/rejects personal
 * identifiers, raw scores/grades, and sub-threshold (n < 30) cohort trap rates.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await requireOpeningScope(request);
    const body = await readShareMintJsonBody(request);
    const signed = signPitfallShareToken(body);

    return Response.json(
      {
        token: signed.token,
        sharePath: signed.sharePath,
        expiresAt: signed.expiresAt,
      },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    void request.body?.cancel().catch(() => undefined);
    if (error instanceof ShareTokenValidationError) {
      return jsonError(new ApiError("VALIDATION", error.message, 400));
    }
    if (error instanceof ShareTokenConfigError) {
      return jsonError(
        new ApiError("CONFIGURATION", "Share token signing is not configured", 503),
      );
    }
    if (error instanceof ApiError) {
      return jsonError(error);
    }
    return jsonError(mapDomainError(error));
  }
}
