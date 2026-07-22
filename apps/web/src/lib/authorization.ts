export type Principal = {
  userId: string;
  workspaceId: string;
  sessionId: string;
};

export type AuthzResource =
  | { type: "workspace"; workspaceId: string }
  | { type: "document"; workspaceId: string; documentId?: string }
  | { type: "revision"; workspaceId: string; documentId: string }
  | { type: "course"; workspaceId: string; courseId?: string }
  | { type: "membership"; workspaceId: string; courseId: string };

export type AuthzDecision =
  | { allow: true }
  | { allow: false; code: "UNAUTHENTICATED" | "WORKSPACE_FORBIDDEN"; message: string };

/**
 * Pure authorization for Phase 1 personal workspaces.
 * Client-supplied workspace ids are never trusted by callers — they pass the
 * resource's resolved workspace and compare to principal.workspaceId.
 */
export function authorize(
  principal: Principal | null,
  _action: string,
  resource: AuthzResource,
): AuthzDecision {
  if (!principal) {
    return {
      allow: false,
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    };
  }
  if (resource.workspaceId !== principal.workspaceId) {
    return {
      allow: false,
      code: "WORKSPACE_FORBIDDEN",
      message: "Access to another workspace is forbidden",
    };
  }
  return { allow: true };
}

/** Force all writes into the caller's personal workspace. */
export function boundWorkspaceId(principal: Principal): string {
  return principal.workspaceId;
}

export function assertAuthorized(
  principal: Principal | null,
  action: string,
  resource: AuthzResource,
): Principal {
  const decision = authorize(principal, action, resource);
  if (!decision.allow) {
    throw new AuthorizationError(decision.code, decision.message);
  }
  return principal!;
}

export class AuthorizationError extends Error {
  readonly code: "UNAUTHENTICATED" | "WORKSPACE_FORBIDDEN";

  constructor(
    code: "UNAUTHENTICATED" | "WORKSPACE_FORBIDDEN",
    message: string,
  ) {
    super(message);
    this.name = "AuthorizationError";
    this.code = code;
  }
}
