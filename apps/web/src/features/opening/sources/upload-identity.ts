import type { Principal } from "../../../lib/authorization";
import { ApiError } from "../../auth/service";
import { z } from "zod";

const identityId = z.string().uuid();

/** A match condition, never an authorization scope. Call after authentication. */
export function assertUploadIdentity(request: Request, principal: Principal): void {
  // Legacy non-UI callers retain principal-only authorization. Current UI requires both headers.
  if (!request.headers.has("x-upload-user-id") && !request.headers.has("x-upload-workspace-id")) return;
  const user = identityId.safeParse(request.headers.get("x-upload-user-id"));
  const workspace = identityId.safeParse(request.headers.get("x-upload-workspace-id"));
  if (!user.success || !workspace.success) throw new ApiError("VALIDATION", "上传缺少有效的原账户身份，请重新验证。", 400);
  if (user.data !== principal.userId || workspace.data !== principal.workspaceId) {
    throw new ApiError("CONFLICT", "请切回原账户和学习空间后重试，原件仍在本地。", 409);
  }
}