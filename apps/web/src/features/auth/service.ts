import {
  createCourseMembershipRepository,
  createIdentityRepository,
  createLibraryRepository,
  createSqlClient,
  CourseMembershipError,
  IdentityError,
  LibraryError,
  type CourseMembershipRepository,
  type IdentityRepository,
  type LibraryRepository,
} from "@aistudy/database";
import {
  loginRequestSchema,
  registerRequestSchema,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
import {
  AuthorizationError,
  assertAuthorized,
  boundWorkspaceId,
  type Principal,
} from "../../lib/authorization";
import { hashPassword, verifyPassword } from "../../lib/password";
import { createSessionService, type SessionService } from "../../lib/session";

export type AuthRuntime = {
  sql: Sql;
  identity: IdentityRepository;
  library: LibraryRepository;
  courses: CourseMembershipRepository;
  sessions: SessionService;
  authCookieName: string;
  sessionTtlSeconds: number;
  close: () => Promise<void>;
};

export function createAuthRuntime(input: {
  databaseUrl: string;
  authSecret: string;
  sessionTtlSeconds: number;
  authCookieName: string;
}): AuthRuntime {
  const sql = createSqlClient(input.databaseUrl);
  const identity = createIdentityRepository(sql);
  const library = createLibraryRepository(sql);
  const courses = createCourseMembershipRepository(sql);
  const sessions = createSessionService({
    sql,
    authSecret: input.authSecret,
    sessionTtlSeconds: input.sessionTtlSeconds,
    identity,
  });
  return {
    sql,
    identity,
    library,
    courses,
    sessions,
    authCookieName: input.authCookieName,
    sessionTtlSeconds: input.sessionTtlSeconds,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "WORKSPACE_FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "INVALID_CREDENTIALS";

export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;

  constructor(code: ApiErrorCode, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export function jsonError(error: ApiError): Response {
  return Response.json(
    { error: { code: error.code, message: error.message } },
    { status: error.status },
  );
}

export function mapDomainError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof AuthorizationError) {
    return new ApiError(
      error.code,
      error.message,
      error.code === "UNAUTHENTICATED" ? 401 : 403,
    );
  }
  if (error instanceof IdentityError) {
    if (error.code === "CONFLICT") {
      return new ApiError("CONFLICT", error.message, 409);
    }
    if (error.code === "VALIDATION") {
      return new ApiError("VALIDATION", error.message, 400);
    }
    if (error.code === "NOT_FOUND") {
      return new ApiError("NOT_FOUND", error.message, 404);
    }
  }
  if (error instanceof LibraryError || error instanceof CourseMembershipError) {
    if (error.code === "WORKSPACE_MISMATCH" || error.code === "CROSS_WORKSPACE_REFERENCE") {
      return new ApiError("WORKSPACE_FORBIDDEN", error.message, 403);
    }
    if (error.code === "NOT_FOUND") {
      return new ApiError("NOT_FOUND", error.message, 404);
    }
    if (error.code === "VALIDATION") {
      return new ApiError("VALIDATION", error.message, 400);
    }
    if (error.code === "CONFLICT" || error.code === "DUPLICATE_MEMBERSHIP") {
      return new ApiError("CONFLICT", error.message, 409);
    }
  }
  if (error instanceof Error && error.name === "ZodError") {
    return new ApiError("VALIDATION", "Invalid request body", 400);
  }
  // Zod v4 issues may not set name consistently depending on bundling.
  if (
    error &&
    typeof error === "object" &&
    "issues" in error &&
    Array.isArray((error as { issues: unknown }).issues)
  ) {
    return new ApiError("VALIDATION", "Invalid request body", 400);
  }
  const message =
    error instanceof Error ? error.message : "Unexpected error";
  return new ApiError("VALIDATION", message, 500);
}

export async function registerUser(
  runtime: AuthRuntime,
  body: unknown,
): Promise<{
  user: {
    id: string;
    email: string;
    displayName: string;
    workspaceId: string;
  };
  token: string;
  expiresAt: Date;
}> {
  const parsed = registerRequestSchema.parse(body);
  const passwordHash = await hashPassword(parsed.password);
  const created = await runtime.identity.createUserWithWorkspace({
    email: parsed.email,
    displayName: parsed.displayName,
    passwordHash,
  });
  const issued = await runtime.sessions.issue({
    userId: created.user.id,
    workspaceId: created.workspace.id,
  });
  return {
    user: {
      id: created.user.id,
      email: created.user.email,
      displayName: created.user.displayName,
      workspaceId: created.workspace.id,
    },
    token: issued.token,
    expiresAt: issued.expiresAt,
  };
}

export async function loginUser(
  runtime: AuthRuntime,
  body: unknown,
): Promise<{
  user: {
    id: string;
    email: string;
    displayName: string;
    workspaceId: string;
  };
  token: string;
  expiresAt: Date;
}> {
  const parsed = loginRequestSchema.parse(body);
  const user = await runtime.identity.findUserByEmail(parsed.email);
  if (!user || user.disabledAt) {
    throw new ApiError("INVALID_CREDENTIALS", "Invalid credentials", 401);
  }
  const ok = await verifyPassword(parsed.password, user.passwordHash);
  if (!ok) {
    throw new ApiError("INVALID_CREDENTIALS", "Invalid credentials", 401);
  }
  const workspace = await runtime.identity.getWorkspaceForUser(user.id);
  const issued = await runtime.sessions.issue({
    userId: user.id,
    workspaceId: workspace.id,
  });
  return {
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      workspaceId: workspace.id,
    },
    token: issued.token,
    expiresAt: issued.expiresAt,
  };
}

export async function logoutUser(
  runtime: AuthRuntime,
  principal: Principal | null,
): Promise<void> {
  if (principal) {
    await runtime.sessions.revoke(principal.sessionId);
  }
}

export function sessionCookieHeader(
  runtime: AuthRuntime,
  token: string,
  expiresAt: Date,
): string {
  const parts = [
    `${runtime.authCookieName}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (process.env.NODE_ENV === "production") {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function clearSessionCookieHeader(runtime: AuthRuntime): string {
  return `${runtime.authCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(
  cookieHeader: string | null,
  name: string,
): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return undefined;
}

export async function resolvePrincipal(
  runtime: AuthRuntime,
  request: Request,
): Promise<Principal | null> {
  const cookie = readCookie(
    request.headers.get("cookie"),
    runtime.authCookieName,
  );
  return runtime.sessions.resolve(cookie);
}

export async function requirePrincipal(
  runtime: AuthRuntime,
  request: Request,
): Promise<Principal> {
  const principal = await resolvePrincipal(runtime, request);
  if (!principal) {
    throw new ApiError("UNAUTHENTICATED", "Authentication required", 401);
  }
  return principal;
}

/** Document helpers — always bind principal workspace. */
export async function createDocumentForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: {
    title: string;
    blocks: Array<{ id: string; type: string; content: Record<string, unknown> }>;
    lifecycle?: "scratch" | "candidate" | "confirmed" | "published" | "archived" | "discarded";
    workspaceId?: string;
  },
) {
  // Ignore client workspaceId — force personal workspace.
  void body.workspaceId;
  const workspaceId = boundWorkspaceId(principal);
  assertAuthorized(principal, "document.create", {
    type: "document",
    workspaceId,
  });
  return runtime.library.createDocument({
    workspaceId,
    title: body.title,
    blocks: body.blocks,
    lifecycle: body.lifecycle,
  });
}

export async function getDocumentForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
) {
  try {
    const doc = await runtime.library.getDocument({
      workspaceId: principal.workspaceId,
      documentId,
    });
    assertAuthorized(principal, "document.read", {
      type: "document",
      workspaceId: doc.workspaceId,
      documentId: doc.id,
    });
    return doc;
  } catch (error) {
    if (error instanceof LibraryError && error.code === "WORKSPACE_MISMATCH") {
      // Document exists elsewhere → 403
      throw new ApiError(
        "WORKSPACE_FORBIDDEN",
        "Access to another workspace is forbidden",
        403,
      );
    }
    throw error;
  }
}

export async function updateDocumentForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  body: {
    title?: string;
    blocks: Array<{ id: string; type: string; content: Record<string, unknown> }>;
    reason?: string;
  },
) {
  // Probe ownership first for proper 403 vs 404.
  await getDocumentForPrincipal(runtime, principal, documentId);
  return runtime.library.updateDocument({
    workspaceId: principal.workspaceId,
    documentId,
    title: body.title,
    blocks: body.blocks,
    reason: body.reason,
  });
}

export async function listRevisionsForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
) {
  await getDocumentForPrincipal(runtime, principal, documentId);
  assertAuthorized(principal, "revision.list", {
    type: "revision",
    workspaceId: principal.workspaceId,
    documentId,
  });
  return runtime.library.listRevisions({
    workspaceId: principal.workspaceId,
    documentId,
  });
}

export async function createCourseForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: { title: string; slug: string; description?: string },
) {
  const workspaceId = boundWorkspaceId(principal);
  assertAuthorized(principal, "course.create", {
    type: "course",
    workspaceId,
  });
  return runtime.courses.createCourse({
    workspaceId,
    title: body.title,
    slug: body.slug,
    description: body.description,
  });
}

export async function addMembershipForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  courseId: string,
  body: {
    assetType: "document";
    assetId: string;
    role: "core" | "optional" | "reference" | "archive";
    sortOrder?: number;
    visibility: "private" | "course" | "public";
  },
) {
  assertAuthorized(principal, "membership.create", {
    type: "membership",
    workspaceId: principal.workspaceId,
    courseId,
  });
  return runtime.courses.addAssetMembership({
    workspaceId: principal.workspaceId,
    courseId,
    assetType: body.assetType,
    assetId: body.assetId,
    role: body.role,
    sortOrder: body.sortOrder,
    visibility: body.visibility,
  });
}

export async function listCourseAssetsForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  courseId: string,
) {
  try {
    const course = await runtime.courses.getCourse({
      workspaceId: principal.workspaceId,
      courseId,
    });
    assertAuthorized(principal, "course.read", {
      type: "course",
      workspaceId: course.workspaceId,
      courseId: course.id,
    });
    return runtime.courses.listCourseAssets({
      workspaceId: principal.workspaceId,
      courseId,
    });
  } catch (error) {
    if (
      error instanceof CourseMembershipError &&
      error.code === "WORKSPACE_MISMATCH"
    ) {
      throw new ApiError(
        "WORKSPACE_FORBIDDEN",
        "Access to another workspace is forbidden",
        403,
      );
    }
    throw error;
  }
}
