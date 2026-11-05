import { vi } from "vitest";
import { publishVerifiedSessionIdentity } from "../../auth/session-identity";

export const uploadTestIdentity = { id: "11111111-1111-4111-8111-111111111111", workspaceId: "22222222-2222-4222-8222-222222222222" };

export function setupUploadIdentity() {
  if (typeof window === "undefined") vi.stubGlobal("window", Object.assign(new EventTarget(), { location: new URL("http://localhost/opening") }));
  const release = publishVerifiedSessionIdentity(uploadTestIdentity);
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ user: uploadTestIdentity })));
  return release;
}
