import type { ImapCursor, ImapSetupInput } from "@aistudy/contracts";
import {
  createOpeningConnectionsRepository,
  createOpeningImportsRepository,
  createOpeningPrivacyRepository,
  createOpeningSourceRepository,
  createSqlClient,
  decryptConnectionCredential,
  OpeningS3,
} from "@aistudy/database";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { ImapFlow } from "imapflow";
import { loadWorkerEnv } from "@aistudy/config";
import { syncMailbox, type ImapSyncDeps } from "../connectors/imap-sync";

export type SyncMailInput = {
  connectionId: string;
};

export type SyncMailResult = {
  imported: number;
  skipped: number;
  cursor: ImapCursor;
};

function assertAllowedHost(host: string): void {
  const allowed = (process.env.OPENING_IMAP_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.includes(host.toLowerCase())) {
    throw new Error("IMAP host is not authorized");
  }
}

function toScope(row: Record<string, unknown>): ImapSyncDeps["scope"] {
  return {
    workspaceId: String(row.workspace_id),
    ownerUserId: String(row.owner_user_id),
  };
}

export function createSyncMailHandler(sql = createSqlClient(loadWorkerEnv().databaseUrl)) {
  const connections = createOpeningConnectionsRepository(sql);
  const imports = createOpeningImportsRepository(sql);
  const privacy = createOpeningPrivacyRepository(sql);
  const sources = createOpeningSourceRepository(sql);
  const storage = new OpeningS3(loadWorkerEnv().s3);

  return async function syncMail(input: SyncMailInput): Promise<SyncMailResult> {
    const [row] = await sql`
      SELECT c.*, w.owner_user_id
      FROM opening_connections c
      JOIN workspaces w ON w.id = c.workspace_id
      WHERE c.id = ${input.connectionId}
        AND c.kind = 'imap'
        AND c.state <> 'revoked'
      LIMIT 1
    `;
    if (!row) throw new Error("imap connection not found");
    assertAllowedHost(String(row.host));

    const [credential] = await sql`
      SELECT key_id, nonce, ciphertext, auth_tag, payload_hash
      FROM opening_connection_credentials
      WHERE connection_id = ${input.connectionId}
      LIMIT 1
    `;
    if (!credential) throw new Error("imap credential is missing");
    const secret = decryptConnectionCredential({
      workspaceId: String(row.workspace_id),
      connectionId: input.connectionId,
      keyId: String(credential.key_id),
      nonce: credential.nonce as Buffer,
      ciphertext: credential.ciphertext as Buffer,
      authTag: credential.auth_tag as Buffer,
      payloadHash: credential.payload_hash as string,
    });

    const client = new ImapFlow({
      host: String(row.host),
      port: Number(row.port),
      secure: String(row.tls_mode) === "implicit",
      auth: { user: String(row.username), pass: secret },
      tls: { rejectUnauthorized: true },
    });
    try {
      await client.connect();
    } catch (error) {
      await client.logout().catch(() => undefined);
      throw error;
    }

    const folders = (row.folders as ImapSetupInput["folders"]) ?? [];
    const folder = folders[0];
    if (!folder) throw new Error("imap connection has no selected folder");
    const [cursorRow] = await sql`
      SELECT container, generation, cursor
      FROM opening_import_cursors
      WHERE connection_id = ${input.connectionId}
        AND container = ${folder}
      LIMIT 1
    `;
    const cursor: ImapCursor = cursorRow
      ? {
          folder: String(cursorRow.container),
          uidValidity: String(cursorRow.generation),
          lastUid: Number((cursorRow.cursor as { lastUid?: number })?.lastUid ?? 0),
        }
      : { folder, uidValidity: "pending", lastUid: 0 };
    const since = new Date(String(row.since_at));

    const result = await syncMailbox({
      scope: toScope(row),
      connectionId: input.connectionId,
      connectionVersion: Number(row.version),
      folder,
      cursor,
      since,
      client,
      imports,
      sources,
      privacy,
      upload: async ({ key, bytes, mime }) => {
        await storage.client.send(
          new PutObjectCommand({
            Bucket: storage.bucket,
            Key: key,
            Body: bytes,
            ContentType: mime,
          }),
        );
      },
    });

    await connections.get(
      { workspaceId: String(row.workspace_id), ownerUserId: String(row.owner_user_id) },
      input.connectionId,
    );
    await client.logout();
    return { imported: result.imported, skipped: result.skipped, cursor: result.cursor };
  };
}
