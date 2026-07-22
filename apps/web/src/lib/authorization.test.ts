import { describe, expect, it } from "vitest";
import {
  assertAuthorized,
  authorize,
  AuthorizationError,
  boundWorkspaceId,
  type Principal,
} from "./authorization";

const principal: Principal = {
  userId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  sessionId: "33333333-3333-4333-8333-333333333333",
};

describe("authorize", () => {
  it("denies unauthenticated callers", () => {
    const decision = authorize(null, "document.read", {
      type: "document",
      workspaceId: principal.workspaceId,
    });
    expect(decision).toEqual({
      allow: false,
      code: "UNAUTHENTICATED",
      message: expect.any(String),
    });
  });

  it("allows same-workspace access", () => {
    expect(
      authorize(principal, "document.read", {
        type: "document",
        workspaceId: principal.workspaceId,
        documentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      }),
    ).toEqual({ allow: true });
  });

  it("denies cross-workspace access", () => {
    const decision = authorize(principal, "document.read", {
      type: "document",
      workspaceId: "99999999-9999-4999-8999-999999999999",
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) {
      expect(decision.code).toBe("WORKSPACE_FORBIDDEN");
    }
  });

  it("assertAuthorized throws AuthorizationError", () => {
    expect(() =>
      assertAuthorized(null, "course.read", {
        type: "course",
        workspaceId: principal.workspaceId,
      }),
    ).toThrow(AuthorizationError);
  });

  it("boundWorkspaceId always returns principal workspace", () => {
    expect(boundWorkspaceId(principal)).toBe(principal.workspaceId);
  });
});
