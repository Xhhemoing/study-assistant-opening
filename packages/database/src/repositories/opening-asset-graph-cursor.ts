import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import {
  assetGraphNodeIdSchema,
  assetGraphRelationSchema,
  assetGraphRootKindSchema,
  uuidSchema,
  type AssetGraphQuery,
  type AssetGraphRelation,
  type AssetGraphRootKind,
  type Scope,
} from "@aistudy/contracts";

export type OpeningAssetGraphErrorCode = "VALIDATION" | "NOT_FOUND" | "CURSOR_STALE" | "CONFLICT";

export class OpeningAssetGraphError extends Error {
  constructor(
    readonly code: OpeningAssetGraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "OpeningAssetGraphError";
  }
}

export const ASSET_GRAPH_NOT_FOUND_MESSAGE = "请求的资源不可用。";
export const ASSET_GRAPH_CURSOR_STALE_MESSAGE = "分页上下文已失效，请从本次查询的第一页重新读取。";

export type OpeningAssetGraphCursorAnchor =
  | { op: "roots"; kind: AssetGraphRootKind; id: string }
  | { op: "neighbors"; relation: AssetGraphRelation; edgeId: string };

export type OpeningAssetGraphCursorPayload = {
  v: 1;
  workspaceId: string;
  ownerUserId: string;
  privacyEpoch: number;
  queryDigest: string;
  scopeFingerprint: string;
  anchor: OpeningAssetGraphCursorAnchor;
};

const cursorAnchorSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("roots"),
      kind: assetGraphRootKindSchema,
      id: assetGraphNodeIdSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("neighbors"),
      relation: assetGraphRelationSchema,
      edgeId: z.string().min(1).max(512),
    })
    .strict(),
]);

const cursorPayloadSchema = z
  .object({
    v: z.literal(1),
    workspaceId: uuidSchema,
    ownerUserId: uuidSchema,
    privacyEpoch: z.number().int().nonnegative(),
    queryDigest: z.string().regex(/^[a-f0-9]{64}$/),
    scopeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    anchor: cursorAnchorSchema,
  })
  .strict();

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const FALLBACK_SECRET = randomBytes(32);

function isNonEmptySecret(value: string | Uint8Array | undefined): value is string | Uint8Array {
  if (value === undefined) return false;
  return typeof value === "string" ? value.length > 0 : value.byteLength > 0;
}

/** Resolve the cursor HMAC secret: explicit option -> non-empty AUTH_SECRET -> process-local random secret. */
export function resolveCursorSecret(explicit?: string | Uint8Array): string | Uint8Array {
  if (isNonEmptySecret(explicit)) return explicit;
  const envSecret = process.env.AUTH_SECRET;
  if (typeof envSecret === "string" && envSecret.length > 0) return envSecret;
  return FALLBACK_SECRET;
}

/** Compute the SHA-256 query digest binding operation, context, lens, focus, direction, filters, and summary flag. */
export function computeAssetGraphQueryDigest(query: AssetGraphQuery): string {
  const canonical = {
    op: query.op,
    context:
      query.context.kind === "workspace"
        ? { kind: "workspace" }
        : { kind: query.context.kind, id: query.context.id },
    lens: query.lens,
    includeKnowledgeEdgeDetails: query.includeKnowledgeEdgeDetails === true ? true : undefined,
    focus: query.op === "roots" ? null : query.focus,
    direction: query.op === "neighbors" ? query.direction : null,
    kinds: query.op === "roots" && query.kinds ? [...query.kinds].sort() : null,
    q: query.op === "roots" ? (query.q ?? null) : null,
    relations: query.op === "neighbors" && query.relations ? [...query.relations].sort() : null,
    includeSummary: query.op !== "detail" ? Boolean(query.include?.includes("summary")) : false,
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** Hash canonicalized visible-scope metadata into a deterministic SHA-256 hex fingerprint. */
export function hashAssetGraphScopeFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

/** Encode and HMAC-SHA256 sign a keyset cursor payload. */
export function encodeAssetGraphCursor(
  payload: OpeningAssetGraphCursorPayload,
  secret: string | Uint8Array,
): string {
  const validated = cursorPayloadSchema.parse(payload);
  const encodedPayload = Buffer.from(JSON.stringify(validated), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

/** Verify HMAC-SHA256 signature and contextual bindings, throwing CURSOR_STALE on any mismatch. */
export function decodeAssetGraphCursor(
  cursor: string,
  expected: {
    scope: Scope;
    privacyEpoch: number;
    queryDigest: string;
    scopeFingerprint: string;
    op: "roots" | "neighbors";
  },
  secret: string | Uint8Array,
): OpeningAssetGraphCursorAnchor {
  const firstDot = cursor.indexOf(".");
  if (firstDot <= 0 || firstDot === cursor.length - 1 || cursor.indexOf(".", firstDot + 1) !== -1) {
    throw new OpeningAssetGraphError("CURSOR_STALE", ASSET_GRAPH_CURSOR_STALE_MESSAGE);
  }
  const encodedPayload = cursor.slice(0, firstDot);
  const encodedSignature = cursor.slice(firstDot + 1);
  if (!BASE64URL_RE.test(encodedPayload) || !BASE64URL_RE.test(encodedSignature)) {
    throw new OpeningAssetGraphError("CURSOR_STALE", ASSET_GRAPH_CURSOR_STALE_MESSAGE);
  }
  const expectedSignature = createHmac("sha256", secret).update(encodedPayload).digest();
  const actualSignature = Buffer.from(encodedSignature, "base64url");
  if (
    actualSignature.length !== expectedSignature.length ||
    !timingSafeEqual(actualSignature, expectedSignature) ||
    actualSignature.toString("base64url") !== encodedSignature
  ) {
    throw new OpeningAssetGraphError("CURSOR_STALE", ASSET_GRAPH_CURSOR_STALE_MESSAGE);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    throw new OpeningAssetGraphError("CURSOR_STALE", ASSET_GRAPH_CURSOR_STALE_MESSAGE);
  }
  const parsed = cursorPayloadSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new OpeningAssetGraphError("CURSOR_STALE", ASSET_GRAPH_CURSOR_STALE_MESSAGE);
  }
  const data = parsed.data;
  if (
    data.workspaceId !== expected.scope.workspaceId ||
    data.ownerUserId !== expected.scope.ownerUserId ||
    data.privacyEpoch !== expected.privacyEpoch ||
    data.queryDigest !== expected.queryDigest ||
    data.scopeFingerprint !== expected.scopeFingerprint ||
    data.anchor.op !== expected.op
  ) {
    throw new OpeningAssetGraphError("CURSOR_STALE", ASSET_GRAPH_CURSOR_STALE_MESSAGE);
  }
  return data.anchor;
}
