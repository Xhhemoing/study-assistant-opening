import { z } from "zod";
import { ApiError, jsonError, mapDomainError } from "../../../../../features/auth/service";
import { allowsPublicTryChallenge } from "../../../../../features/opening/access-policy";
import {
  issueTryMisconceptionReceipt, readMisconceptionRequest, redeemSignedTryMisconceptionReceipt, tryMisconceptionReceiptMaxLength,
} from "../../../../../features/opening/public-try/v3-try-misconception-handoff";
import { requireOpeningScope } from "../../../../../features/opening/runtime";
import { assertAuthorized } from "../../../../../lib/authorization";

const redemption = z.object({ receipt: z.string().min(1).max(tryMisconceptionReceiptMaxLength) }).strict();
const headers = { "Cache-Control": "no-store" };

export async function PUT(request: Request): Promise<Response> {
  try {
    if (!allowsPublicTryChallenge()) throw new ApiError("NOT_FOUND", "体验挑战暂未开放。", 404);
    const receipt = issueTryMisconceptionReceipt(await readMisconceptionRequest(request));
    return Response.json({ receipt }, { status: receipt ? 201 : 200, headers });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { sql, scope, principal } = await requireOpeningScope(request);
    assertAuthorized(principal, "memory.propose", { type: "workspace", workspaceId: scope.workspaceId });
    const { receipt } = redemption.parse(await readMisconceptionRequest(request));
    const result = await redeemSignedTryMisconceptionReceipt(sql, scope, receipt);
    return Response.json(result, { status: result.replayed ? 200 : 201, headers });
  } catch (error) {
    return jsonError(mapDomainError(error));
  }
}
