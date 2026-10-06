import { createHash } from "node:crypto";
import type { Sql } from "postgres";
import { z } from "zod";
import {
  importIdentitySchema,
  sourceMimeSchema,
  uploadInputSchema,
  type ImportIdentity,
  type SourceMime,
} from "@aistudy/contracts";
import {
  createOpeningConnectionsRepository,
  createOpeningImportsRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceRepository,
  OpeningConnectionError,
  OpeningSourceError,
} from "@aistudy/database";
import {
  buildDingTalkCallbackResponse,
  DingTalkClientError,
  isFreshDingTalkEventTimestamp,
  verifyAndDecryptDingTalkEvent,
} from "../../../../../worker/src/connectors/dingtalk-client";
import { canReadDingTalkResource } from "../../../../../worker/src/connectors/dingtalk-policy";
import { importIdentityKey } from "../../../../../worker/src/connectors/import-identity";

export const MAX_DINGTALK_EVENT_BYTES = 64 * 1024;
export const DINGTALK_EVENT_TIMESTAMP_MAX_AGE_SECONDS = 300;
export const MAX_DINGTALK_ATTACHMENT_BYTES = 20 * 1024 * 1024;

const callbackConnectionSchema = z.object({
  workspaceId: z.string().uuid(),
  ownerUserId: z.string().uuid(),
  connectionId: z.string().uuid(),
}).strict();
const callbackConnectionMapSchema = z.record(z.string(), callbackConnectionSchema);

export type DingTalkCallbackConnection = z.infer<typeof callbackConnectionSchema>;

export type DingTalkCallbackInput = {
  signature: string;
  timestamp: string;
  nonce: string;
  encryptedBody: string;
  now?: () => number;
};

export type DingTalkCallbackDeps = {
  sql: Sql;
  now?: () => number;
  download?: (url: URL) => Promise<Uint8Array>;
  uploadStaging: (input: { key: string; bytes: Uint8Array; mime: string }) => Promise<void>;
  uploadFinal: (input: { key: string; bytes: Uint8Array; mime: string }) => Promise<void>;
};

export type DingTalkCallbackResult = {
  eventId: string;
  duplicate: boolean;
  imported: number;
  sourceId: string | null;
  receiptId: string | null;
};

export type DingTalkCallbackResponse = {
  signature: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
};

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim() ?? "";
  if (!value) throw new DingTalkClientError("INVALID_CONFIG", `${name} is not configured`);
  return value;
}

function callbackConnections(): Record<string, DingTalkCallbackConnection> {
  const raw = requiredEnv("OPENING_DINGTALK_CALLBACK_CONNECTIONS");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DingTalkClientError("INVALID_CONFIG", "OPENING_DINGTALK_CALLBACK_CONNECTIONS is invalid");
  }
  return callbackConnectionMapSchema.parse(parsed);
}

function responseConfig() {
  return {
    token: requiredEnv("OPENING_DINGTALK_CALLBACK_TOKEN"),
    encodingAesKey: requiredEnv("OPENING_DINGTALK_ENCODING_AES_KEY"),
    corpIdOrKey: requiredEnv("OPENING_DINGTALK_CORP_ID"),
  };
}

function safeFilename(name: unknown): string {
  const value = typeof name === "string" ? name : "";
  return value.split(/[\\/]/).filter(Boolean).at(-1)?.slice(0, 180) || "attachment";
}

function allowedDownloadHosts(): string[] {
  const raw = process.env.OPENING_DINGTALK_ALLOWED_DOWNLOAD_HOSTS?.trim() ?? "";
  return raw.split(",").map(value => value.trim().toLowerCase()).filter(Boolean);
}

/**
 * Route a verified callback through an administrator-owned CorpId mapping.
 * The callback request itself carries no Opening workspace or owner identity.
 */
export async function receiveDingTalkCallback(
  input: DingTalkCallbackInput,
  deps: DingTalkCallbackDeps,
): Promise<DingTalkCallbackResult> {
  const now = deps.now ?? (() => Date.now());
  if (!isFreshDingTalkEventTimestamp(input.timestamp, DINGTALK_EVENT_TIMESTAMP_MAX_AGE_SECONDS, now)) {
    throw new DingTalkClientError("FORMAT", "callback timestamp is stale");
  }

  const config = responseConfig();
  const event = verifyAndDecryptDingTalkEvent({
    ...config,
    signature: input.signature,
    timestamp: input.timestamp,
    nonce: input.nonce,
    encryptedBody: input.encryptedBody,
  });
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new DingTalkClientError("FORMAT", "callback event must be an object");
  }
  const record = event as Record<string, unknown>;
  const eventId = typeof record.eventId === "string" && record.eventId.length >= 1 && record.eventId.length <= 500
    ? record.eventId
    : "";
  if (!eventId) throw new DingTalkClientError("FORMAT", "callback eventId is missing");

  const routing = callbackConnections()[config.corpIdOrKey];
  if (!routing) throw new DingTalkClientError("INVALID_CONFIG", "callback routing is not configured");

  const [connection] = await deps.sql`
    SELECT c.workspace_id, c.owner_user_id, c.kind, c.state, c.version, c.allowed_scopes
    FROM opening_connections c
    JOIN workspaces w ON w.id = c.workspace_id
    WHERE c.id = ${routing.connectionId}
      AND c.workspace_id = ${routing.workspaceId}
      AND c.owner_user_id = ${routing.ownerUserId}
      AND w.owner_user_id = ${routing.ownerUserId}
    FOR UPDATE
    LIMIT 1
  `;
  if (!connection) throw new OpeningConnectionError("NOT_FOUND", "connection not found");
  if (connection.kind !== "dingtalk" || connection.state === "revoked") {
    throw new OpeningConnectionError("CONFLICT", "connection cannot receive callbacks");
  }

  const grantedScopes = (connection.allowed_scopes as string[] | null) ?? [];
  const requiredScope = typeof record.requiredScope === "string" ? record.requiredScope : "";
  if (!requiredScope || !grantedScopes.some(_ => canReadDingTalkResource(requiredScope, grantedScopes))) {
    throw new DingTalkClientError("FORMAT", "callback is not authorized by connection scopes");
  }

  const identity: ImportIdentity = importIdentitySchema.parse({
    connectionId: routing.connectionId,
    container: "dingtalk-callback",
    generation: "callback",
    remoteId: eventId,
  });
  const identityKey = importIdentityKey(identity);
  const [existingReceipt] = await deps.sql`
    SELECT id
    FROM opening_import_receipts
    WHERE workspace_id = ${routing.workspaceId}
      AND connection_id = ${routing.connectionId}
      AND identity_key = ${identityKey}
    FOR UPDATE
    LIMIT 1
  `;
  if (existingReceipt) {
    return { eventId, duplicate: true, imported: 0, sourceId: null, receiptId: String(existingReceipt.id) };
  }

  let bytes = new Uint8Array();
  let mime: SourceMime = "text/markdown";
  let name = `dingtalk-event-${eventId}.md`;
  const rawAttachment = record.attachment;
  if (rawAttachment === undefined || rawAttachment === null) {
    const markdown = typeof record.content === "string" && record.content.trim()
      ? record.content
      : `# DingTalk event\n\n\`\`\`json\n${JSON.stringify(record, null, 2)}\n\`\`\``;
    bytes = new TextEncoder().encode(markdown);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DINGTALK_EVENT_BYTES) {
      throw new DingTalkClientError("FORMAT", "callback payload exceeds size limit");
    }
  } else {
    if (!rawAttachment || typeof rawAttachment !== "object" || Array.isArray(rawAttachment)) {
      throw new DingTalkClientError("FORMAT", "callback attachment is invalid");
    }
    const attachment = rawAttachment as Record<string, unknown>;
    const rawUrl = typeof attachment.url === "string" ? attachment.url : "";
    if (!rawUrl) throw new DingTalkClientError("FORMAT", "verified attachment URL is missing");
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !allowedDownloadHosts().includes(url.hostname.toLowerCase())) {
      throw new DingTalkClientError("FORMAT", "attachment host is not authorized");
    }
    if (!deps.download) throw new DingTalkClientError("FORMAT", "restricted downloader is unavailable");
    mime = sourceMimeSchema.parse(typeof attachment.mime === "string" ? attachment.mime : "");
    name = safeFilename(attachment.name);
    bytes = await deps.download(url);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_DINGTALK_ATTACHMENT_BYTES) {
      throw new DingTalkClientError("FORMAT", "attachment exceeds size limit");
    }
  }

  const sources = createOpeningSourceRepository(deps.sql);
  const imports = createOpeningImportsRepository(deps.sql);
  const privacy = createOpeningPrivacyRepository(deps.sql);
  const connections = createOpeningConnectionsRepository(deps.sql);
  const scope = {
    workspaceId: routing.workspaceId,
    ownerUserId: routing.ownerUserId,
  };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const source = await sources.create(scope, uploadInputSchema.parse({
    name,
    mime,
    bytes: bytes.byteLength,
    sha256,
  }));
  const stagingKey = `opening/staging/${source.id}`;
  const finalKey = `opening/sources/${source.id}/v${source.version}`;
  await deps.uploadStaging({ key: stagingKey, bytes, mime });
  const privacyEpoch = await privacy.getWorkspaceEpoch(scope);
  await sources.completeWithParseJob(scope, source.id, {
    key: finalKey,
    payload: { sourceId: source.id, sourceVersion: source.version },
    privacyEpoch,
    actual: { bytes: bytes.byteLength, sha256, mime },
    beforeComplete: () => deps.uploadFinal({ key: finalKey, bytes, mime }),
  });
  const receipt = await imports.commit(scope, {
    connectionVersion: Number(connection.version),
    identity,
    sourceId: source.id,
  });
  await connections.get(scope, routing.connectionId);
  return {
    eventId,
    duplicate: receipt.duplicate,
    imported: receipt.duplicate ? 0 : 1,
    sourceId: source.id,
    receiptId: receipt.id,
  };
}

/** Build DingTalk's encrypted acknowledgement only after processing succeeds. */
export function encryptedDingTalkSuccess(timestamp: string, nonce: string): DingTalkCallbackResponse {
  return buildDingTalkCallbackResponse({ ...responseConfig(), timestamp, nonce });
}

export type DingTalkStorageDeps = {
  uploadStaging: DingTalkCallbackDeps["uploadStaging"];
  uploadFinal: DingTalkCallbackDeps["uploadFinal"];
};

export function createDingTalkCallbackHttpService(
  sql: Sql,
  storage: DingTalkStorageDeps,
) {
  return {
    callback(input: DingTalkCallbackInput) {
      return receiveDingTalkCallback(input, { sql, ...storage });
    },
    success(timestamp: string, nonce: string) {
      return encryptedDingTalkSuccess(timestamp, nonce);
    },
  };
}

export {
  DingTalkClientError,
  OpeningConnectionError,
  OpeningSourceError,
};



