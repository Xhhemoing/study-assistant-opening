import { loadWorkerEnv } from "@aistudy/config";
import {
  createOpeningConnectionsRepository,
  createOpeningImportsRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceRepository,
  createSqlClient,
  type OpeningScope,
} from "@aistudy/database";
import type { OpeningImports, OpeningPrivacy, OpeningSources } from "../connectors/imap-sync";
import { canReadDingTalkResource } from "../connectors/dingtalk-policy";

export type SyncDingTalkInput = {
  workspaceId: string;
  ownerUserId: string;
  connectionId: string;
};

export type SyncDingTalkResult = {
  status: "needs_authorization" | "unsupported_history_read";
  imported: number;
  skipped: number;
  allowedScopes: string[];
};

export type SyncDingTalkDeps = {
  connections: ReturnType<typeof createOpeningConnectionsRepository>;
  imports: OpeningImports;
  sources: OpeningSources;
  privacy: OpeningPrivacy;
  getGrantedScopes: (connectionId: string) => Promise<string[]>;
  /** Intentionally absent: DingTalk provides no historical group-chat read API. */
  loadHistoricalMessages?: never;
};

export type CheckDingTalkResult = {
  ok: boolean;
  kind: "dingtalk";
  status: "needs_authorization" | "ready" | "unsupported_history_read";
  allowedScopes: string[];
};

export type CheckDingTalkDeps = {
  connections: ReturnType<typeof createOpeningConnectionsRepository>;
  getGrantedScopes: (connectionId: string) => Promise<string[]>;
};

const DINGTALK_READ_CAPABILITIES = ["messages.read", "events.read", "files.read"] as const;

/**
 * DingTalk has no historical group-chat read API. A sync request must not
 * infer history access from robot send permission or callback delivery.
 */
export async function syncDingTalk(
  deps: SyncDingTalkDeps,
  input: SyncDingTalkInput,
): Promise<SyncDingTalkResult> {
  const connection = await deps.connections.get(
    { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId },
    input.connectionId,
  );
  if (connection.kind !== "dingtalk" || connection.state === "revoked") {
    throw new Error("dingtalk connection not found");
  }

  const grantedScopes = await deps.getGrantedScopes(input.connectionId);
  const canRead = DINGTALK_READ_CAPABILITIES.some(requiredScope =>
    canReadDingTalkResource(requiredScope, grantedScopes),
  );
  if (connection.state === "needs_authorization" || grantedScopes.length === 0 || !canRead) {
    return { status: "needs_authorization", imported: 0, skipped: 0, allowedScopes: grantedScopes };
  }

  return { status: "unsupported_history_read", imported: 0, skipped: 0, allowedScopes: grantedScopes };
}


/**
 * Durable DingTalk connection check. Fail-closed and local only: never calls
 * remote DingTalk APIs. Authorized read capability reports honesty about the
 * missing history-read API instead of inventing a remote health probe.
 */
export async function checkDingTalk(
  deps: CheckDingTalkDeps,
  input: SyncDingTalkInput,
): Promise<CheckDingTalkResult> {
  const connection = await deps.connections.get(
    { workspaceId: input.workspaceId, ownerUserId: input.ownerUserId },
    input.connectionId,
  );
  if (connection.kind !== "dingtalk" || connection.state === "revoked") {
    throw new Error("dingtalk connection not found");
  }

  const grantedScopes = await deps.getGrantedScopes(input.connectionId);
  const canRead = DINGTALK_READ_CAPABILITIES.some(requiredScope =>
    canReadDingTalkResource(requiredScope, grantedScopes),
  );
  if (connection.state === "needs_authorization" || grantedScopes.length === 0 || !canRead) {
    return {
      ok: false,
      kind: "dingtalk",
      status: "needs_authorization",
      allowedScopes: grantedScopes,
    };
  }

  // History pull remains unsupported; "ready" means internal read capability is present
  // for callback/event ingestion, not that remote history sync works.
  return {
    ok: true,
    kind: "dingtalk",
    status: connection.state === "ready" ? "ready" : "unsupported_history_read",
    allowedScopes: grantedScopes,
  };
}

export function createSyncDingTalkHandler(sql = createSqlClient(loadWorkerEnv().databaseUrl)) {
  const connections = createOpeningConnectionsRepository(sql);
  const imports = createOpeningImportsRepository(sql);
  const sources = createOpeningSourceRepository(sql);
  const privacy = createOpeningPrivacyRepository(sql);
  return async function syncDingTalkJob(input: { connectionId: string }): Promise<SyncDingTalkResult> {
    const [row] = await sql`
      SELECT c.*, w.owner_user_id
      FROM opening_connections c
      JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = ${input.connectionId}
        AND c.kind = 'dingtalk'
        AND c.state <> 'revoked'
      LIMIT 1
    `;
    if (!row) throw new Error("dingtalk connection not found");
    const scope: OpeningScope = {
      workspaceId: String(row.workspace_id),
      ownerUserId: String(row.owner_user_id),
    };
    return syncDingTalk(
      {
        connections,
        imports,
        sources,
        privacy,
        getGrantedScopes: async connectionId => {
          const rows = await sql`SELECT allowed_scopes FROM opening_connections WHERE id = ${connectionId} LIMIT 1`;
          return (rows[0]?.allowed_scopes as string[] | undefined) ?? [];
        },
      },
      { ...scope, connectionId: input.connectionId },
    );
  };
}

export function createCheckDingTalkHandler(sql = createSqlClient(loadWorkerEnv().databaseUrl)) {
  const connections = createOpeningConnectionsRepository(sql);
  return async function checkDingTalkJob(input: { connectionId: string }): Promise<CheckDingTalkResult> {
    const [row] = await sql`
      SELECT c.*, w.owner_user_id
      FROM opening_connections c
      JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = ${input.connectionId}
        AND c.kind = 'dingtalk'
        AND c.state <> 'revoked'
      LIMIT 1
    `;
    if (!row) throw new Error("dingtalk connection not found");
    const scope: OpeningScope = {
      workspaceId: String(row.workspace_id),
      ownerUserId: String(row.owner_user_id),
    };
    return checkDingTalk(
      {
        connections,
        getGrantedScopes: async connectionId => {
          const rows = await sql`SELECT allowed_scopes FROM opening_connections WHERE id = ${connectionId} LIMIT 1`;
          return (rows[0]?.allowed_scopes as string[] | undefined) ?? [];
        },
      },
      { ...scope, connectionId: input.connectionId },
    );
  };
}

