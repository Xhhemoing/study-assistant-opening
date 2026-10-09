import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import type { ImportIdentity } from "@aistudy/contracts";
import { OpeningConnectionError } from "./opening-connections";
import type { OpeningScope } from "./opening-sources";

export type OpeningImportCursor = { generation: string; cursor: unknown };
export type OpeningImportCommit = {
  connectionVersion: number;
  identity: ImportIdentity;
  sourceId: string;
  cursor?: OpeningImportCursor | undefined;
};
export type OpeningImportReceiptView = {
  id: string; sourceIds: string[]; duplicate: boolean; connectionVersion: number;
};

function identityKey(identity: ImportIdentity): string {
  return JSON.stringify([
    identity.connectionId, identity.container, identity.generation, identity.remoteId,
  ]);
}

async function ownedConnection(tx: TransactionSql, scope: OpeningScope, id: string) {
  const rows = await tx`SELECT c.id, c.version, c.state FROM opening_connections c
    JOIN workspaces w ON w.id=c.workspace_id
    WHERE c.id=${id} AND c.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
      AND w.owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!rows.length) throw new OpeningConnectionError("NOT_FOUND", "connection not found");
  return rows[0]!;
}

export function createOpeningImportsRepository(sql: Sql) {
  return {
    async findByIdentity(scope: OpeningScope, identity: ImportIdentity): Promise<{ id: string; sourceId: string } | null> {
      const key = identityKey(identity);
      const [row] = await sql`SELECT id, source_id FROM opening_import_receipts
        WHERE workspace_id=${scope.workspaceId} AND connection_id=${identity.connectionId}
          AND identity_key=${key}`;
      if (!row) return null;
      return { id: String(row.id), sourceId: String(row.source_id) };
    },
    async commit(scope: OpeningScope, input: OpeningImportCommit): Promise<OpeningImportReceiptView> {
      return sql.begin(async tx => {
        const connection = await ownedConnection(tx, scope, input.identity.connectionId);
        if (connection.state === "revoked") {
          throw new OpeningConnectionError("CONFLICT", "connection is revoked");
        }
        if (Number(connection.version) !== input.connectionVersion) {
          throw new OpeningConnectionError("CONFLICT", "connection version changed; import discarded");
        }
        const key = identityKey(input.identity);
        const [existing] = await tx`SELECT id FROM opening_import_receipts
          WHERE workspace_id=${scope.workspaceId} AND connection_id=${input.identity.connectionId}
            AND identity_key=${key}`;
        if (existing) {
          const [view] = await tx`SELECT source_id, connection_version FROM opening_import_receipts WHERE id=${existing.id}`;
          return {
            id: String(existing.id), sourceIds: [String(view!.source_id)], duplicate: true,
            connectionVersion: Number(view!.connection_version),
          };
        }
        const receiptId = randomUUID();
        await tx`INSERT INTO opening_import_receipts
          (id,workspace_id,owner_user_id,connection_id,connection_version,identity_key,source_id)
          VALUES (${receiptId},${scope.workspaceId},${scope.ownerUserId},${input.identity.connectionId},
            ${input.connectionVersion},${key},${input.sourceId})`;
        if (input.cursor) {
          const cursor = input.cursor;
          await tx`INSERT INTO opening_import_cursors
            (workspace_id,connection_id,container,generation,cursor)
            VALUES (${scope.workspaceId},${input.identity.connectionId},${input.identity.container},
              ${cursor.generation},${tx.json(cursor.cursor as never)})
            ON CONFLICT (workspace_id,connection_id,container) DO UPDATE SET
              generation=EXCLUDED.generation,cursor=EXCLUDED.cursor,updated_at=now()
            WHERE opening_import_cursors.generation=EXCLUDED.generation`;
        }
        return { id: receiptId, sourceIds: [input.sourceId], duplicate: false, connectionVersion: input.connectionVersion };
      });
    },
  };
}
