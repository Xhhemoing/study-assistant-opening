import { getVerifiedSessionIdentity, type SessionIdentity } from "../../auth/session-identity";
import { UploadUserError } from "./upload-error";

const mismatch = "请切回原账户和学习空间后重试，原件仍在本地。";

export function uploadIdentityHeaders(identity: SessionIdentity | null | undefined): Record<string, string> {
  if (!identity?.id || !identity.workspaceId) throw new UploadUserError(mismatch);
  return { "x-upload-user-id": identity.id, "x-upload-workspace-id": identity.workspaceId };
}

/** Check current cookies before reading a File; authenticated HTTP boundaries also compare. */
export async function verifyUploadIdentity(identity: SessionIdentity | null): Promise<void> {
  uploadIdentityHeaders(identity);
  const local = getVerifiedSessionIdentity();
  if (!local || local.id !== identity!.id || local.workspaceId !== identity!.workspaceId) throw new UploadUserError(mismatch);
  const response = await fetch("/api/auth/me", { cache: "no-store" });
  if (!response.ok) throw new UploadUserError(mismatch);
  const body: unknown = await response.json();
  const user = (body as { user?: SessionIdentity } | null)?.user;
  if (user?.id !== identity!.id || user?.workspaceId !== identity!.workspaceId) throw new UploadUserError(mismatch);
}