import { describe, expect, it } from "vitest";
import {
  assertObjectAccess,
  createSessionToken,
  verifySessionToken,
} from "./session";

describe("session authentication and object-level authorization", () => {
  const secret = "spike-test-secret-at-least-32-chars!!";

  it("verifies a signed session and denies access to another user's resource", async () => {
    const token = await createSessionToken(
      { sub: "user-a", workspaceId: "ws-1" },
      secret,
    );

    const session = await verifySessionToken(token, secret);
    expect(session).toEqual({ sub: "user-a", workspaceId: "ws-1" });

    expect(() => assertObjectAccess(session, "user-a")).not.toThrow();
    expect(() => assertObjectAccess(session, "user-b")).toThrow("forbidden");
  });
});
