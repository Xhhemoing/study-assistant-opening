import type { ImapCursor, ImapSetupInput } from "@aistudy/contracts";
import { loadWorkerEnv } from "@aistudy/config";
import {
  createOpeningImportsRepository,
  createSqlClient,
  decryptConnectionCredential,
  OpeningS3,
} from "@aistudy/database";
import { createApprovedImapClient } from "../connectors/imap-endpoint";
import { DEFAULT_IMAP_SYNC_DURATION_MS, runWithSyncDeadline, syncMailbox } from "../connectors/imap-sync";

export type SyncMailInput = { connectionId: string };

export type SyncMailResult = {
  imported: number;
  skipped: number;
  cursor: ImapCursor;
};

async function loadMailConnection(sql: ReturnType<typeof createSqlClient>, connectionId: string) {
  const [row] = await sql`
    SELECT c.*
    FROM opening_connections c
    JOIN workspaces w ON w.id = c.workspace_id AND w.owner_user_id = c.owner_user_id
    WHERE c.id = ${connectionId} AND c.kind = 'imap' AND c.state <> 'revoked'
    LIMIT 1
  `;
  if (!row) throw new Error("imap connection not found");
  const scope = { workspaceId: String(row.workspace_id), ownerUserId: String(row.owner_user_id) };
  const [credential] = await sql`
    SELECT key_id, nonce, ciphertext, auth_tag, payload_hash
    FROM opening_connection_credentials
    WHERE connection_id = ${connectionId} AND workspace_id = ${scope.workspaceId}
    LIMIT 1
  `;
  if (!credential) throw new Error("imap credential is missing");
  const secret = decryptConnectionCredential({
    workspaceId: scope.workspaceId,
    connectionId,
    keyId: String(credential.key_id),
    nonce: credential.nonce as Buffer,
    ciphertext: credential.ciphertext as Buffer,
    authTag: credential.auth_tag as Buffer,
    payloadHash: credential.payload_hash as string,
  });
  const client = await createApprovedImapClient({
    host: String(row.host), port: Number(row.port), tlsMode: String(row.tls_mode),
  }, { user: String(row.username), pass: secret });
  const folders = (row.folders as ImapSetupInput["folders"]) ?? [];
  return { client, scope, folder: folders[0], version: Number(row.version), since: new Date(String(row.since_at)) };
}

export function createSyncMailHandler(sql = createSqlClient(loadWorkerEnv().databaseUrl)) {
  const imports = createOpeningImportsRepository(sql);
  const storage = new OpeningS3(loadWorkerEnv().s3);

  return async function syncMail({ connectionId }: SyncMailInput): Promise<SyncMailResult> {
    const { client, scope, folder, version, since } = await loadMailConnection(sql, connectionId);
    try {
      if (!folder) throw new Error("imap connection has no selected folder");
      const cursor = await imports.readImapCursor(scope, connectionId, folder);
      const deadlineMs = Date.now() + DEFAULT_IMAP_SYNC_DURATION_MS;
      const closeClient = () => client.close();
      await runWithSyncDeadline(() => client.connect(), {
        phase: "connect",
        deadlineMs,
        now: Date.now,
        client,
        onDeadlineAbort: closeClient,
      });
      return await syncMailbox({
        scope, connectionId, connectionVersion: version, folder, cursor, since, client, imports,
        deadlineMs,
        onDeadlineAbort: closeClient,
        storage: {
          upload: ({ key, bytes, mime, signal }) =>
            storage.putObject(key, bytes, { mime, ...(signal ? { signal } : {}) }),
          remove: key => storage.deleteObject(key),
        },
      });
    } finally {
      client.close();
    }
  };
}

export type CheckMailResult = { ok: true; kind: "imap" };

/** Read-only connectivity and folder check through the same approved dialer. */
export function createCheckMailHandler(sql = createSqlClient(loadWorkerEnv().databaseUrl)) {
  return async function checkMail({ connectionId }: SyncMailInput): Promise<CheckMailResult> {
    const { client, folder } = await loadMailConnection(sql, connectionId);
    try {
      const deadlineMs = Date.now() + DEFAULT_IMAP_SYNC_DURATION_MS;
      const closeClient = () => client.close();
      await runWithSyncDeadline(() => client.connect(), {
        phase: "connect",
        deadlineMs,
        now: Date.now,
        client,
        onDeadlineAbort: closeClient,
      });
      if (folder) {
        await runWithSyncDeadline(() => client.mailboxOpen(folder, { readOnly: true }), {
          phase: "mailboxOpen",
          deadlineMs,
          now: Date.now,
          client,
          onDeadlineAbort: closeClient,
        });
      } else {
        await runWithSyncDeadline(() => client.list(), {
          phase: "list",
          deadlineMs,
          now: Date.now,
          client,
          onDeadlineAbort: closeClient,
        });
      }
      await runWithSyncDeadline(() => client.logout(), {
        phase: "logout",
        deadlineMs,
        now: Date.now,
        client,
        onDeadlineAbort: closeClient,
      }).catch(() => undefined);
      return { ok: true, kind: "imap" };
    } finally {
      client.close();
    }
  };
}
