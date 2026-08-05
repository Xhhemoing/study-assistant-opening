import { EnvValidationError } from "@aistudy/config";
import {
  createCourseMembershipRepository,
  createExplorationRepository,
  createPromotionRepository,
  createRevisionProposalRepository,
  createIdentityRepository,
  createLibraryRepository,
  createSqlClient,
  createWorkspacePreferencesRepository,
  CourseMembershipError,
  ExplorationRepositoryError,
  IdentityError,
  LibraryError,
  WorkspacePreferencesError,
  PromotionRepositoryError,
  RevisionProposalRepositoryError,
  type RevisionProposalRepository,
  type CourseMembershipRepository,
  type ExplorationRepository,
  type PromotionRepository,
  type IdentityRepository,
  type LibraryRepository,
  type WorkspacePreferencesRepository,
} from "@aistudy/database";
import {
  createDocumentRelationRequestSchema,
  documentTagsUpdateSchema,
  documentPropertiesResponseSchema,
  indexDocumentLinksRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  searchRequestSchema,
  workspacePreferenceUpdateSchema,
  normalizeDocumentTags,
  updateDocumentRelationRequestSchema,
  createPromotionRequestSchema,
  createRevisionProposalRequestSchema,
  revisionProposalReviewRequestSchema,
  revisionProposalResolveRequestSchema,
  type DocumentPropertiesResponse,
  type KnowledgeLink,
  type ManagedRelation,
  type SearchHit,
} from "@aistudy/contracts";
import { rankResults, type SearchDoc } from "@aistudy/domain";
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
  preferences: WorkspacePreferencesRepository;
  explorations: ExplorationRepository;
  promotions: PromotionRepository;
  revisionProposals: RevisionProposalRepository;
  sessions: SessionService;
  authCookieName: string;
  sessionCookieSecure: boolean;
  sessionTtlSeconds: number;
  close: () => Promise<void>;
};

export function createAuthRuntime(input: {
  databaseUrl: string;
  authSecret: string;
  sessionCookieSecure: boolean;
  sessionTtlSeconds: number;
  authCookieName: string;
}): AuthRuntime {
  const sql = createSqlClient(input.databaseUrl);
  const identity = createIdentityRepository(sql);
  const library = createLibraryRepository(sql);
  const courses = createCourseMembershipRepository(sql);
  const preferences = createWorkspacePreferencesRepository(sql);
  const explorations = createExplorationRepository(sql);
  const promotions = createPromotionRepository(sql);
  const revisionProposals = createRevisionProposalRepository(sql);
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
    preferences,
    explorations,
    promotions,
    revisionProposals,
    sessions,
    authCookieName: input.authCookieName,
    sessionCookieSecure: input.sessionCookieSecure,
    sessionTtlSeconds: input.sessionTtlSeconds,
    close: async () => {
      await sql.end({ timeout: 5 });
    },
  };
}

export async function listPromotionsForPrincipal(runtime: AuthRuntime, principal: Principal, explorationId: string) {
  return runtime.promotions.list({ workspaceId: boundWorkspaceId(principal), explorationId });
}

export async function listRevisionProposalsForPrincipal(runtime: AuthRuntime, principal: Principal, documentId: string) {
  await getDocumentForPrincipal(runtime, principal, documentId);
  return runtime.revisionProposals.list({ workspaceId: boundWorkspaceId(principal), documentId });
}

export async function getRevisionProposalForPrincipal(runtime: AuthRuntime, principal: Principal, proposalId: string) {
  const proposal = await runtime.revisionProposals.get({ workspaceId: boundWorkspaceId(principal), proposalId });
  if (proposal.workspaceId !== boundWorkspaceId(principal)) {
    throw new ApiError("WORKSPACE_FORBIDDEN", "Access to another workspace is forbidden", 403);
  }
  return proposal;
}

export async function createRevisionProposalForPrincipal(runtime: AuthRuntime, principal: Principal, documentId: string, body: unknown) {
  const parsed = createRevisionProposalRequestSchema.parse(body);
  const document = await getDocumentForPrincipal(runtime, principal, documentId);
  const provenance = {
    ...parsed.provenance,
    actorUserId: principal.userId,
    sourceRevisionNumber: document.currentRevisionNumber,
  };
  return runtime.revisionProposals.create({
    workspaceId: boundWorkspaceId(principal),
    documentId,
    baseRevisionNumber: document.currentRevisionNumber,
    proposedTitle: parsed.proposedTitle,
    proposedBlocks: parsed.proposedBlocks,
    source: parsed.source,
    supportState: parsed.supportState,
    provenance,
  });
}

export async function reviewRevisionProposalForPrincipal(runtime: AuthRuntime, principal: Principal, proposalId: string, body: unknown) {
  const parsed = revisionProposalReviewRequestSchema.parse(body);
  return runtime.revisionProposals.review({
    workspaceId: boundWorkspaceId(principal),
    proposalId,
    action: parsed.action,
    selectedProposalBlockIds: parsed.selectedProposalBlockIds,
    actorUserId: principal.userId,
  });
}

export async function resolveRevisionProposalForPrincipal(runtime: AuthRuntime, principal: Principal, proposalId: string, body: unknown) {
  const parsed = revisionProposalResolveRequestSchema.parse(body);
  return runtime.revisionProposals.resolveConflict({
    workspaceId: boundWorkspaceId(principal),
    proposalId,
    action: parsed.action,
    selectedProposalBlockIds: parsed.selectedProposalBlockIds,
    expectedCurrentRevisionNumber: parsed.expectedCurrentRevisionNumber,
    actorUserId: principal.userId,
  });
}

export async function createPromotionForPrincipal(runtime: AuthRuntime, principal: Principal, explorationId: string, body: unknown) {
  const parsed = createPromotionRequestSchema.parse(body);
  return runtime.promotions.create({ workspaceId: boundWorkspaceId(principal), explorationId, ...parsed });
}

export async function acceptPromotionForPrincipal(runtime: AuthRuntime, principal: Principal, promotionId: string) {
  return runtime.promotions.accept({ workspaceId: boundWorkspaceId(principal), promotionId });
}

export async function rejectPromotionForPrincipal(runtime: AuthRuntime, principal: Principal, promotionId: string) {
  return runtime.promotions.reject({ workspaceId: boundWorkspaceId(principal), promotionId });
}

export async function getDocumentPromotionSourceForPrincipal(runtime: AuthRuntime, principal: Principal, documentId: string) {
  return runtime.promotions.getByDocumentTarget({ workspaceId: boundWorkspaceId(principal), documentId });
}

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "WORKSPACE_FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "INVALID_CREDENTIALS"
  | "CONFIGURATION";

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
  if (error instanceof EnvValidationError) {
    return new ApiError(
      "CONFIGURATION",
      "服务暂不可用，请检查服务器配置。",
      503,
    );
  }
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
  if (
    error instanceof LibraryError
    || error instanceof CourseMembershipError
    || error instanceof WorkspacePreferencesError
    || error instanceof ExplorationRepositoryError
    || error instanceof PromotionRepositoryError
    || error instanceof RevisionProposalRepositoryError
  ) {
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
    if (error.code === "INVALID_TRANSITION") {
      return new ApiError("CONFLICT", error.message, 409);
    }
  }
  if (error instanceof SyntaxError) {
    return new ApiError("VALIDATION", "Invalid JSON request body", 400);
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
  if (runtime.sessionCookieSecure) {
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

export async function getWorkspacePreferenceForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
) {
  const workspaceId = boundWorkspaceId(principal);
  assertAuthorized(principal, "workspace.preference.read", {
    type: "workspace",
    workspaceId,
  });
  return runtime.preferences.getDefaultEntry(workspaceId);
}

export async function setWorkspacePreferenceForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  body: unknown,
) {
  const parsed = workspacePreferenceUpdateSchema.parse(body);
  const workspaceId = boundWorkspaceId(principal);
  assertAuthorized(principal, "workspace.preference.update", {
    type: "workspace",
    workspaceId,
  });
  const preference = await runtime.preferences.setDefaultEntry(
    workspaceId,
    parsed.defaultEntry,
  );
  return preference.defaultEntry;
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

export async function listDocumentsForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
) {
  assertAuthorized(principal, "document.read", {
    type: "document",
    workspaceId: principal.workspaceId,
  });
  return runtime.library.listDocuments({ workspaceId: principal.workspaceId });
}

function summaryText(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    const text = value.map(summaryText).filter(Boolean).join(" ").trim();
    return text || null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const parts = Object.entries(record)
    .filter(([key]) => key !== "id" && key !== "type")
    .map(([, child]) => summaryText(child))
    .filter((child): child is string => Boolean(child));
  const text = parts.join(" ").trim();
  return text || null;
}

async function enrichKnowledgeEndpoint(
  runtime: AuthRuntime,
  workspaceId: string,
  type: "document" | "block",
  id: string,
) {
  try {
    if (type === "document") {
      const document = await runtime.library.getDocument({
        workspaceId,
        documentId: id,
        includeDeleted: true,
      });
      if (document.deletedAt) {
        return { type, id, documentId: document.id, title: null, text: null, status: "broken" as const };
      }
      return { type, id, documentId: document.id, title: document.title, text: null, status: "available" as const };
    }
    const block = await runtime.library.getBlock({
      workspaceId,
      blockId: id,
      includeDeleted: true,
    });
    if (block.document.deletedAt) {
      return { type, id, documentId: block.document.id, title: null, text: null, status: "broken" as const };
    }
    return {
      type,
      id,
      documentId: block.document.id,
      title: block.document.title,
      text: summaryText(block.content),
      status: "available" as const,
    };
  } catch (error) {
    if (error instanceof LibraryError && error.code === "WORKSPACE_MISMATCH") {
      throw new ApiError("WORKSPACE_FORBIDDEN", "Access to another workspace is forbidden", 403);
    }
    if (error instanceof LibraryError && error.code === "NOT_FOUND") {
      return { type, id, documentId: null, title: null, text: null, status: "broken" as const };
    }
    throw error;
  }
}

export async function listKnowledgeLinksForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
): Promise<KnowledgeLink[]> {
  const hostDocument = await getDocumentForPrincipal(runtime, principal, documentId);
  assertAuthorized(principal, "document.read", {
    type: "document",
    workspaceId: principal.workspaceId,
    documentId,
  });
  const relationSets = await Promise.all([
    runtime.library.listRelations({
      workspaceId: principal.workspaceId,
      subjectType: "document",
      subjectId: documentId,
    }),
    ...hostDocument.blocks.map((block) => runtime.library.listRelations({
      workspaceId: principal.workspaceId,
      subjectType: "block",
      subjectId: block.id,
    })),
  ]);
  const relations = [...new Map(
    relationSets.flat().map((relation) => [relation.id, relation]),
  ).values()];
  const hostBlockIds = new Set(hostDocument.blocks.map((block) => block.id));
  const links = await Promise.all(relations.map(async (relation) => ({
    id: relation.id,
    relationType: relation.relationType as KnowledgeLink["relationType"],
    isIncoming: relation.toType === "document"
      ? relation.toId === documentId
      : hostBlockIds.has(relation.toId),
    from: await enrichKnowledgeEndpoint(runtime, principal.workspaceId, relation.fromType, relation.fromId),
    to: await enrichKnowledgeEndpoint(runtime, principal.workspaceId, relation.toType, relation.toId),
    createdAt: relation.createdAt.toISOString(),
  })));
  return links;
}

function relationToManagedLink(
  runtime: AuthRuntime,
  workspaceId: string,
  relation: {
    id: string;
    relationType: string;
    fromType: "document" | "block";
    fromId: string;
    toType: "document" | "block";
    toId: string;
    createdAt: Date;
  },
): Promise<ManagedRelation> {
  return Promise.all([
    enrichKnowledgeEndpoint(runtime, workspaceId, relation.fromType, relation.fromId),
    enrichKnowledgeEndpoint(runtime, workspaceId, relation.toType, relation.toId),
  ]).then(([from, to]) => ({
    id: relation.id,
    relationType: relation.relationType as ManagedRelation["relationType"],
    from,
    to,
    createdAt: relation.createdAt.toISOString(),
  }));
}

async function requireOutgoingDocumentRelation(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  relationId: string,
) {
  try {
    const relation = await runtime.library.getRelation({
      workspaceId: principal.workspaceId,
      relationId,
    });
    if (relation.fromType !== "document" || relation.fromId !== documentId) {
      throw new LibraryError("NOT_FOUND", `Relation ${relationId} not found`);
    }
    return relation;
  } catch (error) {
    if (error instanceof LibraryError && error.code === "WORKSPACE_MISMATCH") {
      throw new LibraryError("NOT_FOUND", `Relation ${relationId} not found`);
    }
    throw error;
  }
}

export async function listManagedDocumentRelationsForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
): Promise<ManagedRelation[]> {
  await getDocumentForPrincipal(runtime, principal, documentId);
  const relations = await runtime.library.listRelations({
    workspaceId: principal.workspaceId,
    subjectType: "document",
    subjectId: documentId,
  });
  return Promise.all(relations
    .filter((relation) => relation.fromType === "document" && relation.fromId === documentId)
    .map((relation) => relationToManagedLink(runtime, principal.workspaceId, relation)));
}

export async function createDocumentRelationForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  body: unknown,
): Promise<ManagedRelation> {
  await getDocumentForPrincipal(runtime, principal, documentId);
  const parsed = createDocumentRelationRequestSchema.parse(body);
  if (parsed.to.type === "document" && parsed.to.id === documentId) {
    throw new LibraryError("VALIDATION", "A document cannot relate to itself");
  }
  const target = parsed.to.type === "document"
    ? await runtime.library.getDocument({ workspaceId: principal.workspaceId, documentId: parsed.to.id })
    : await runtime.library.getBlock({ workspaceId: principal.workspaceId, blockId: parsed.to.id });
  if (("deletedAt" in target ? target.deletedAt : target.document.deletedAt) !== null) {
    throw new LibraryError("NOT_FOUND", "Relation target is not available");
  }
  const relation = await runtime.library.createRelation({
    workspaceId: principal.workspaceId,
    fromType: "document",
    fromId: documentId,
    toType: parsed.to.type,
    toId: parsed.to.id,
    relationType: parsed.relationType,
  });
  return relationToManagedLink(runtime, principal.workspaceId, relation);
}

export async function updateDocumentRelationForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  relationId: string,
  body: unknown,
): Promise<ManagedRelation> {
  await getDocumentForPrincipal(runtime, principal, documentId);
  await requireOutgoingDocumentRelation(runtime, principal, documentId, relationId);
  const parsed = updateDocumentRelationRequestSchema.parse(body);
  const relation = await runtime.library.updateRelationType({
    workspaceId: principal.workspaceId,
    relationId,
    relationType: parsed.relationType,
  });
  return relationToManagedLink(runtime, principal.workspaceId, relation);
}

export async function deleteDocumentRelationForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  relationId: string,
): Promise<void> {
  await getDocumentForPrincipal(runtime, principal, documentId);
  await requireOutgoingDocumentRelation(runtime, principal, documentId, relationId);
  await runtime.library.deleteRelation({ workspaceId: principal.workspaceId, relationId });
}

export async function listDocumentPropertiesForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
): Promise<DocumentPropertiesResponse> {
  const document = await getDocumentForPrincipal(runtime, principal, documentId);
  const [documentProperties, blockProperties] = await Promise.all([
    runtime.library.listProperties({
      workspaceId: principal.workspaceId,
      subjectType: "document",
      subjectId: documentId,
    }),
    Promise.all(document.blocks.map(async (block) => ({
      block,
      properties: await runtime.library.listProperties({
        workspaceId: principal.workspaceId,
        subjectType: "block",
        subjectId: block.id,
      }),
    }))),
  ]);
  const propertyView = (property: { id: string; key: string; valueType: "string" | "number" | "boolean" | "json"; value: unknown; updatedAt: Date }) => ({
    id: property.id,
    key: property.key,
    valueType: property.valueType,
    value: property.value,
    updatedAt: property.updatedAt.toISOString(),
  });
  return documentPropertiesResponseSchema.parse({
    document: documentProperties.filter((property) => property.key !== "tags").map(propertyView),
    blocks: blockProperties
      .map(({ block, properties }) => ({
        blockId: block.id,
        blockType: block.type,
        text: summaryText(block.content),
        properties: properties.filter((property) => property.key !== "tags").map(propertyView),
      }))
      .filter((group) => group.properties.length > 0),
  });
}

export async function indexDocumentLinksForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  body: unknown,
): Promise<{ indexed: number }> {
  const parsed = indexDocumentLinksRequestSchema.parse(body);
  await getDocumentForPrincipal(runtime, principal, documentId);
  const titles = [...new Set(parsed.targetTitles.map((title) => title.trim()))];
  const documents = await runtime.library.listDocuments({ workspaceId: principal.workspaceId });
  const byTitle = new Map(documents.map((document) => [document.title, document]));
  const targetDocumentIds = titles.flatMap((title) => {
    const target = byTitle.get(title);
    return !target || target.id === documentId || target.deletedAt ? [] : [target.id];
  });
  return runtime.library.syncWikiLinkRelations({
    workspaceId: principal.workspaceId,
    documentId,
    targetDocumentIds,
  });
}

export async function searchForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  query: string,
  limit?: number,
): Promise<{ hits: SearchHit[] }> {
  const parsed = searchRequestSchema.parse({ q: query, limit });
  const rows = await runtime.library.searchLibrary({
    workspaceId: principal.workspaceId,
    query: parsed.q,
    limit: parsed.limit,
  });
  const docs: SearchDoc[] = rows.map((row) => ({
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    tags: row.tags,
    lifecycle: row.lifecycle,
    courseMemberships: row.courseMemberships,
  }));
  const hits = rankResults(parsed.q, docs, parsed.limit ?? 20);
  return {
    hits: hits.filter((hit): hit is SearchHit =>
      hit.type === "document" || hit.type === "course",
    ),
  };
}

function normalizedTags(tags: string[]): string[] {
  try {
    return normalizeDocumentTags(tags);
  } catch (error) {
    throw new LibraryError(
      "VALIDATION",
      error instanceof Error ? error.message : "Invalid document tags",
    );
  }
}

export async function getDocumentTagsForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
): Promise<string[]> {
  await getDocumentForPrincipal(runtime, principal, documentId);
  const properties = await runtime.library.listProperties({
    workspaceId: principal.workspaceId,
    subjectType: "document",
    subjectId: documentId,
  });
  const property = properties.find((item) => item.key === "tags");
  if (!property) return [];
  if (property.valueType !== "json" || !Array.isArray(property.value) || !property.value.every((tag) => typeof tag === "string")) {
    throw new LibraryError("VALIDATION", "Document tags property has an invalid value");
  }
  return normalizedTags(property.value);
}

export async function setDocumentTagsForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  body: unknown,
): Promise<string[]> {
  await getDocumentForPrincipal(runtime, principal, documentId);
  const parsed = documentTagsUpdateSchema.parse(body);
  const tags = normalizedTags(parsed.tags);
  const property = await runtime.library.setProperty({
    workspaceId: principal.workspaceId,
    subjectType: "document",
    subjectId: documentId,
    key: "tags",
    valueType: "json",
    value: tags,
  });
  if (!Array.isArray(property.value) || !property.value.every((tag) => typeof tag === "string")) {
    throw new LibraryError("VALIDATION", "Document tags property has an invalid value");
  }
  return normalizedTags(property.value);
}

export async function updateDocumentForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  documentId: string,
  body: {
    title?: string;
    blocks: Array<{ id: string; type: string; content: Record<string, unknown> }>;
    expectedRevisionNumber: number;
    reason?: string;
  },
) {
  // Probe ownership first for proper 403 vs 404.
  await getDocumentForPrincipal(runtime, principal, documentId);
  return runtime.library.updateDocument({
    workspaceId: principal.workspaceId,
    documentId,
    expectedRevisionNumber: body.expectedRevisionNumber,
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

export async function listCoursesForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
) {
  assertAuthorized(principal, "course.read", {
    type: "course",
    workspaceId: principal.workspaceId,
  });
  return runtime.courses.listCourses({ workspaceId: principal.workspaceId });
}

export async function getCourseForPrincipal(
  runtime: AuthRuntime,
  principal: Principal,
  courseId: string,
) {
  const course = await runtime.courses.getCourse({
    workspaceId: principal.workspaceId,
    courseId,
  });
  assertAuthorized(principal, "course.read", {
    type: "course",
    workspaceId: course.workspaceId,
    courseId: course.id,
  });
  return course;
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
