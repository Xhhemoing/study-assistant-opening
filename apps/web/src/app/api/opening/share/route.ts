import {
  ApiError,
  jsonError,
  mapDomainError,
} from "../../../../features/auth/service";
import { readOpeningRawBody } from "../../../../features/opening/request-body";
import { requireOpeningScope } from "../../../../features/opening/runtime";
import { SHARE_MINT_MAX_BODY_BYTES } from "../../../../features/opening/share/schema";
import {
  SharePitfallNotFoundError,
  ShareTokenConfigError,
  ShareTokenValidationError,
  mintPitfallShareTokenById,
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
 * Mint a stateless HMAC-SHA256 pitfall share token from the server-authoritative
 * catalog. Clients may only specify `{ pitfallId, expiresInSeconds? }`; copy and
 * cohort statistics are never accepted from the request body.
 */
export async function POST(request: Request): Promise<Response> {
  try {
    await requireOpeningScope(request);
    const body = await readShareMintJsonBody(request);
    const signed = mintPitfallShareTokenById(body);

    return Response.json(
      {
        pitfallId: signed.pitfallId,
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
    if (error instanceof SharePitfallNotFoundError) {
      return jsonError(new ApiError("NOT_FOUND", error.message, 404));
    }
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
