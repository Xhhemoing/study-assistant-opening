import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { ImapCursor, ImportIdentity, UploadInput } from "@aistudy/contracts";
import { OpeningConnectionError } from "./opening-connections";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { createOpeningPrivacyRepository } from "./opening-privacy";
import { createOpeningSourceRepository, type OpeningScope, type OpeningSourceQuota } from "./opening-sources";

export type OpeningImportCursor = { expected: ImapCursor | null; next: ImapCursor };
export type OpeningImportCommit = {
  connectionVersion: number;
  identity: ImportIdentity;
  sourceId: string;
  cursor?: OpeningImportCursor | undefined;
};
export type OpeningImportReceiptView = {
  id: string; sourceIds: string[]; duplicate: boolean; connectionVersion: number;
};

type ConnectionVersion = { connectionId: string; connectionVersion: number };

function identityKey(identity: ImportIdentity): string {
  return JSON.stringify([identity.connectionId, identity.container, identity.generation, identity.remoteId]);
}

async function lockImportConnection(tx: TransactionSql, scope: OpeningScope, input: ConnectionVersion) {
  // Acquire workspace before connection, in the same order as revocation and
  // credential updates. Source publication also takes the history lock first.
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId}
    AND owner_user_id=${scope.ownerUserId} FOR NO KEY UPDATE`;
  const [connection] = owner ? await tx`SELECT version, state FROM opening_connections
    WHERE id=${input.connectionId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    FOR UPDATE` : [];
  if (!connection) throw new OpeningConnectionError("NOT_FOUND", "connection not found");
  if (connection.state === "revoked") throw new OpeningConnectionError("CONFLICT", "connection is revoked");
  if (Number(connection.version) !== input.connectionVersion) {
    throw new OpeningConnectionError("CONFLICT", "connection version changed; import discarded");
  }
}

async function readReceipt(sql: Sql | TransactionSql, scope: OpeningScope, identity: ImportIdentity) {
  const [row] = await sql`SELECT id, source_id, connection_version FROM opening_import_receipts
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
    AND connection_id=${identity.connectionId} AND identity_key=${identityKey(identity)}`;
  return row;
}

function sameCursor(left: ImapCursor | null, right: ImapCursor | null): boolean {
  if (!left || !right) return left === right;
  return left.folder === right.folder && left.uidValidity === right.uidValidity && left.lastUid === right.lastUid;
}

async function readImapCursor(sql: Sql | TransactionSql, scope: OpeningScope, connectionId: string, container: string): Promise<ImapCursor | null> {
  const [row] = await sql`SELECT generation, cursor FROM opening_import_cursors
    WHERE workspace_id=${scope.workspaceId} AND connection_id=${connectionId} AND container=${container}`;
  return row ? { folder: container, uidValidity: String(row.generation), lastUid: Number(row.cursor?.lastUid ?? 0) } : null;
}

/** The connection lock serializes cursor readers and writers for this import. */
async function writeImapCursor(
  tx: TransactionSql, scope: OpeningScope, connectionId: string, container: string,
  change: OpeningImportCursor, duplicate = false,
) {
  const { expected, next } = change;
  const current = await readImapCursor(tx, scope, connectionId, container);
  if (duplicate && sameCursor(current, next)) return;
  if (!sameCursor(current, expected) || next.folder !== container
    || (current?.uidValidity === next.uidValidity && next.lastUid < current.lastUid)) {
    throw new OpeningConnectionError("CONFLICT", "IMAP cursor changed; restart from the persisted cursor");
  }
  await tx`INSERT INTO opening_import_cursors (workspace_id,connection_id,container,generation,cursor)
    VALUES (${scope.workspaceId},${connectionId},${container},${next.uidValidity},${tx.json(next)})
    ON CONFLICT (workspace_id,connection_id,container) DO UPDATE SET
      generation=EXCLUDED.generation,cursor=EXCLUDED.cursor,updated_at=now()`;
}

async function commitImport(
  tx: TransactionSql, scope: OpeningScope, input: OpeningImportCommit, publishSource?: () => Promise<void>,
): Promise<OpeningImportReceiptView> {
  const { identity } = input;
  await lockImportConnection(tx, scope, { connectionId: identity.connectionId, connectionVersion: input.connectionVersion });
  const existing = await readReceipt(tx, scope, identity);
  if (input.cursor) {
    if (input.cursor.next.uidValidity !== identity.generation) {
      throw new OpeningConnectionError("CONFLICT", "IMAP receipt and cursor generations differ");
    }
    await writeImapCursor(tx, scope, identity.connectionId, identity.container, input.cursor, Boolean(existing));
  }
  if (existing) {
    return {
      id: String(existing.id), sourceIds: [String(existing.source_id)], duplicate: true,
      connectionVersion: Number(existing.connection_version),
    };
  }
  await publishSource?.();
  const receiptId = randomUUID();
  await tx`INSERT INTO opening_import_receipts
    (id,workspace_id,owner_user_id,connection_id,connection_version,identity_key,source_id)
    VALUES (${receiptId},${scope.workspaceId},${scope.ownerUserId},${identity.connectionId},
      ${input.connectionVersion},${identityKey(identity)},${input.sourceId})`;
  return { id: receiptId, sourceIds: [input.sourceId], duplicate: false, connectionVersion: input.connectionVersion };
}

export function createOpeningImportsRepository(sql: Sql) {
  return {
    async findByIdentity(scope: OpeningScope, identity: ImportIdentity): Promise<{ id: string; sourceId: string } | null> {
      const row = await readReceipt(sql, scope, identity);
      return row ? { id: String(row.id), sourceId: String(row.source_id) } : null;
    },
    async commit(scope: OpeningScope, input: OpeningImportCommit): Promise<OpeningImportReceiptView> {
      return sql.begin(tx => commitImport(tx, scope, input));
    },
    readImapCursor(scope: OpeningScope, connectionId: string, folder: string): Promise<ImapCursor | null> {
      return readImapCursor(sql, scope, connectionId, folder);
    },
    async publish(
      scope: OpeningScope,
      input: OpeningImportCommit & { source: UploadInput; key: string; quota: OpeningSourceQuota },
    ): Promise<OpeningImportReceiptView> {
      return sql.begin(async tx => {
        await lockWorkspaceLearningHistory(tx, scope);
        return commitImport(tx, scope, input, async () => {
          // Reuse the source writer's quota, parse kind, outbox and history logic
          // with savepoints on this same SQL transaction.
          const sourceSql = { begin: (run: (db: TransactionSql) => Promise<unknown>) => tx.savepoint(run) } as Sql;
          const sources = createOpeningSourceRepository(sourceSql, { quota: input.quota });
          const source = await sources.create(scope, { ...input.source, uploadId: input.sourceId });
          const privacyEpoch = await createOpeningPrivacyRepository(tx).getWorkspaceEpoch(scope);
          await sources.completeWithParseJob(scope, source.id, {
            key: input.key,
            payload: { sourceId: source.id, sourceVersion: source.version },
            privacyEpoch,
            actual: input.source,
          });
        });
      });
    },
    async advanceImapCursor(scope: OpeningScope, input: ConnectionVersion & { cursor: OpeningImportCursor }): Promise<void> {
      await sql.begin(async tx => {
        await lockImportConnection(tx, scope, input);
        await writeImapCursor(tx, scope, input.connectionId, input.cursor.next.folder, input.cursor);
      });
    },
    async isSourcePublished(scope: OpeningScope, sourceId: string): Promise<boolean> {
      return sql.begin(async tx => {
        // This conflicts with the publisher's workspace lock and settles an
        // ambiguous COMMIT result before cleanup can remove the staged bytes.
        await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} FOR SHARE`;
        const [source] = await tx`SELECT id FROM opening_sources WHERE id=${sourceId} AND workspace_id=${scope.workspaceId}`;
        return Boolean(source);
      });
    },
  };
}
