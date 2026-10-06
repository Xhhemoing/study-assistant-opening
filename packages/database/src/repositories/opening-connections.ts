import { createHash, randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { ConnectionView, ImapSetupInput, Scope } from "@aistudy/contracts";

export class OpeningConnectionError extends Error {
  constructor(readonly code: "NOT_FOUND" | "CONFLICT", message: string) {
    super(message); this.name = "OpeningConnectionError";
  }
}
export type OpeningCredentialEnvelope = {
  keyId: string; nonce: Buffer; ciphertext: Buffer; authTag: Buffer; payloadHash: string;
};
type Row = Record<string, unknown>;
function view(row: Row): ConnectionView {
  return {
    id: String(row.id), version: Number(row.version), kind: row.kind as ConnectionView["kind"],
    label: String(row.label), state: row.state as ConnectionView["state"],
    allowedScopes: row.allowed_scopes as string[],
    lastSuccessAt: row.last_success_at ? new Date(row.last_success_at as string | Date).toISOString() : null,
    errorCode: row.error_code ? String(row.error_code) : null,
  };
}
async function lockOwner(tx: TransactionSql, scope: Scope) {
  const rows = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!rows.length) throw new OpeningConnectionError("NOT_FOUND", "workspace not found");
}
async function owned(tx: Sql | TransactionSql, scope: Scope, id: string) {
  const rows = await tx`SELECT c.* FROM opening_connections c JOIN workspaces w ON w.id=c.workspace_id
    WHERE c.id=${id} AND c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
      AND w.owner_user_id=${scope.ownerUserId}`;
  if (!rows.length) throw new OpeningConnectionError("NOT_FOUND", "connection not found");
  return rows[0]!;
}
async function replayCreate(tx: TransactionSql, scope: Scope, key: string, fingerprint: string) {
  const [row] = await tx`SELECT * FROM opening_connections WHERE workspace_id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} AND create_client_key=${key}`;
  if (row && row.create_payload_hash !== fingerprint) throw new OpeningConnectionError("CONFLICT", "client key input changed");
  return row ? view(row) : null;
}
function fingerprint(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export function createOpeningConnectionsRepository(sql: Sql) {
  return {
    async list(scope: Scope) {
      const rows = await sql`SELECT c.* FROM opening_connections c JOIN workspaces w ON w.id=c.workspace_id
        WHERE c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
          AND w.owner_user_id=${scope.ownerUserId} ORDER BY c.created_at,c.id`;
      return rows.map(view);
    },
    async get(scope: Scope, id: string) { return view(await owned(sql, scope, id)); },
    async createImap(scope: Scope, input: ImapSetupInput) {
      const hash = fingerprint(["imap", input.label, input.host, input.port, input.tlsMode,
        input.username, input.folders, input.since]);
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        const replay = await replayCreate(tx, scope, input.clientKey, hash);
        if (replay) return replay;
        const [row] = await tx`INSERT INTO opening_connections
          (id,workspace_id,owner_user_id,kind,label,host,port,tls_mode,username,folders,since_at,create_client_key,create_payload_hash)
          VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},'imap',${input.label},${input.host},
            ${input.port},${input.tlsMode},${input.username},${tx.json(input.folders)},${input.since},${input.clientKey},${hash}) RETURNING *`;
        return view(row!);
      });
    },
    async createDingtalk(scope: Scope, input: { label: string; requestedScopes: string[]; clientKey: string }) {
      const hash = fingerprint(["dingtalk", input.label, input.requestedScopes]);
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        const replay = await replayCreate(tx, scope, input.clientKey, hash);
        if (replay) return replay;
        const [row] = await tx`INSERT INTO opening_connections
          (id,workspace_id,owner_user_id,kind,label,requested_scopes,create_client_key,create_payload_hash)
          VALUES (${randomUUID()},${scope.workspaceId},${scope.ownerUserId},'dingtalk',${input.label},
            ${input.requestedScopes},${input.clientKey},${hash}) RETURNING *`;
        return view(row!);
      });
    },
    async putCredential(scope: Scope, id: string, encrypted: OpeningCredentialEnvelope, clientKey: string,
      matchesPrevious?: (storedFingerprint: string) => boolean) {
      await sql.begin(async tx => {
        await lockOwner(tx, scope);
        const connection = await owned(tx, scope, id);
        if (connection.state === "revoked") throw new OpeningConnectionError("CONFLICT", "connection is revoked");
        const [replay] = await tx`SELECT payload_hash FROM opening_connection_credential_requests
          WHERE connection_id=${id} AND client_key=${clientKey}`;
        if (replay) {
          if (replay.payload_hash !== encrypted.payloadHash && !matchesPrevious?.(String(replay.payload_hash))) {
            throw new OpeningConnectionError("CONFLICT", "client key input changed");
          }
          return;
        }
        await tx`INSERT INTO opening_connection_credentials
          (connection_id,workspace_id,key_id,nonce,ciphertext,auth_tag,client_key,payload_hash)
          VALUES (${id},${scope.workspaceId},${encrypted.keyId},${encrypted.nonce},${encrypted.ciphertext},
            ${encrypted.authTag},${clientKey},${encrypted.payloadHash})
          ON CONFLICT (connection_id) DO UPDATE SET key_id=EXCLUDED.key_id,nonce=EXCLUDED.nonce,
            ciphertext=EXCLUDED.ciphertext,auth_tag=EXCLUDED.auth_tag,client_key=EXCLUDED.client_key,
            payload_hash=EXCLUDED.payload_hash,updated_at=now()`;
        await tx`INSERT INTO opening_connection_credential_requests (connection_id,client_key,payload_hash)
          VALUES (${id},${clientKey},${encrypted.payloadHash})`;
        await tx`UPDATE opening_connections SET version=version+1,state='needs_authorization',
          allowed_scopes='{}',error_code=NULL,updated_at=now() WHERE id=${id}`;
      });
    },
    async revoke(scope: Scope, id: string, expectedVersion: number, clientKey: string) {
      return sql.begin(async tx => {
        await lockOwner(tx, scope);
        const connection = await owned(tx, scope, id);
        if (connection.revoke_client_key === clientKey && connection.revoked_from_version === expectedVersion) return view(connection);
        if (Number(connection.version) !== expectedVersion || connection.state === "revoked") {
          throw new OpeningConnectionError("CONFLICT", "connection version is stale or revoked");
        }
        await tx`DELETE FROM opening_connection_credentials WHERE connection_id=${id}`;
        await tx`DELETE FROM opening_connection_credential_requests WHERE connection_id=${id}`;
        await tx`UPDATE opening_jobs SET state='cancelled', updated_at=now()
          WHERE workspace_id=${scope.workspaceId} AND state='queued'
          AND payload->>'connectionId'=${id}`;
        const [row] = await tx`UPDATE opening_connections SET version=version+1,state='revoked',
          allowed_scopes='{}',revoke_client_key=${clientKey},revoked_from_version=${expectedVersion},updated_at=now()
          WHERE id=${id} RETURNING *`;
        return view(row!);
      });
    },
  };
}
