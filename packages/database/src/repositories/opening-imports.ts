import { randomUUID } from "node:crypto";
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { ImapCursor, ImportIdentity, UploadInput } from "@aistudy/contracts";
import { OpeningConnectionError } from "./opening-connections";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { createOpeningPrivacyRepository } from "./opening-privacy";
import { CONNECTOR_PUT_TIMEOUT_MS, CONNECTOR_RESERVATION_GRACE_MS, connectorReservationId, releaseConnectorReservation } from "./opening-source-actions";
import { reserveOpeningSourceQuota } from "./opening-source-quota";
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

function importLock(scope: OpeningScope, identity: ImportIdentity) {
  return JSON.stringify(["opening-import-object", scope.workspaceId, identityKey(identity)]);
}

// Each active import needs one physical session for its locks across PUT. A
// dedicated single-connection client can be closed even if that session dies
// during storage I/O. Limit these clients across repository instances per pool.
const activeImports = new WeakMap<Sql, Set<Promise<void>>>();
// postgres.js also accepts its own parsed options (as used by its subscriber).
// Its public overloads only describe URL and unparsed options.
const openSession = postgres as typeof postgres & ((options: postgres.ParsedOptions) => Sql);

async function withImportSession<T>(pool: Sql, run: (session: Sql, lost: () => boolean) => Promise<T>) {
  const active = activeImports.get(pool) ?? new Set<Promise<void>>();
  activeImports.set(pool, active);
  while (active.size >= pool.options.max) await Promise.race(active);
  let release!: () => void;
  const slot = new Promise<void>(resolve => { release = resolve; });
  active.add(slot);
  try {
    let lost = false;
    const session = openSession({ ...pool.options, max: 1, idle_timeout: 0, max_lifetime: null,
      onclose: () => { lost = true; } });
    try {
      return await run(session, () => lost);
    } finally {
      // Closing this physical connection releases only this attempt's locks.
      await session.end({ timeout: 0 });
    }
  } finally {
    active.delete(slot);
    release();
  }
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
      stage: () => Promise<void>,
    ): Promise<OpeningImportReceiptView> {
      const deliveryLock = importLock(scope, input.identity);
      const canonicalSourceId = input.sourceId.toLowerCase();
      return withImportSession(sql, async (session, lost) => {
        // One session fences duplicate deliveries and protects its physical key
        // across PUT, while revocation remains free to commit on another session.
        await session`SELECT pg_advisory_lock(hashtextextended(${deliveryLock}, 0))`;
        await session`SELECT pg_advisory_lock(hashtextextended(${canonicalSourceId}, 0))`;
        const duplicate = await session.begin(async tx => {
          if (await readReceipt(tx, scope, input.identity)) {
            await lockWorkspaceLearningHistory(tx, scope);
            return commitImport(tx, scope, input, async () => {
              throw new OpeningConnectionError("CONFLICT", "import receipt changed; retry the delivery");
            });
          }
          await lockImportConnection(tx, scope, { connectionId: input.identity.connectionId, connectionVersion: input.connectionVersion });
          await reserveOpeningSourceQuota(tx, scope, input.source.bytes, input.quota);
          const [used] = await tx`SELECT 1 FROM opening_sources WHERE id=${canonicalSourceId}
            UNION ALL SELECT 1 FROM opening_privacy_exclusions WHERE source_id=${canonicalSourceId}
            UNION ALL SELECT 1 FROM opening_source_versions WHERE source_id=${canonicalSourceId} LIMIT 1`;
          if (used) throw new OpeningConnectionError("CONFLICT", "connector source object is already reserved");
          const initialCutoffSeconds = Math.ceil((CONNECTOR_PUT_TIMEOUT_MS + CONNECTOR_RESERVATION_GRACE_MS) / 1000);
          await tx`INSERT INTO opening_source_versions (source_id, version, workspace_id, bytes, availability)
            VALUES (${canonicalSourceId}, 0, ${scope.workspaceId}, ${input.source.bytes}, 'unavailable')`;
          await tx`INSERT INTO opening_privacy_exclusions
            (id, workspace_id, source_id, asset_deleted_at, pending_object_keys, cleanup_not_before)
            VALUES (${connectorReservationId(canonicalSourceId)}, ${scope.workspaceId}, ${canonicalSourceId}, now(), ARRAY[${input.key}]::text[], now() + make_interval(secs => ${initialCutoffSeconds}))`;
          return null;
        });
        if (duplicate) return duplicate;
        if (lost()) {
          // No PUT was attempted. A healthy pool can cancel the reservation
          // without contacting storage after the dedicated session was lost.
          await sql.begin(tx => releaseConnectorReservation(tx, scope, canonicalSourceId, input.key));
          throw new OpeningConnectionError("CONFLICT", "connector staging session disconnected");
        }
        await stage();
        if (lost()) throw new OpeningConnectionError("CONFLICT", "connector staging session disconnected");
        return session.begin(async tx => {
          if (lost()) throw new OpeningConnectionError("CONFLICT", "connector staging session disconnected");
          await lockWorkspaceLearningHistory(tx, scope);
          return commitImport(tx, scope, input, async () => {
            if (!await releaseConnectorReservation(tx, scope, canonicalSourceId, input.key)) {
              throw new OpeningConnectionError("CONFLICT", "connector staging reservation changed");
            }
            // A failure in either source operation rolls back the entire publication.
            const sourceSql = { begin: (run: (db: TransactionSql) => Promise<unknown>) => tx.savepoint(run) } as Sql;
            const sources = createOpeningSourceRepository(sourceSql, { quota: input.quota });
            const source = await sources.create(scope, { ...input.source, uploadId: canonicalSourceId });
            const privacyEpoch = await createOpeningPrivacyRepository(tx).getWorkspaceEpoch(scope);
            await sources.completeWithParseJob(scope, source.id, {
              key: input.key, payload: { sourceId: source.id, sourceVersion: source.version, connectionId: input.identity.connectionId },
              privacyEpoch, actual: input.source,
            });
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
    async refreshConnectorReservationCutoff(
      scope: OpeningScope,
      sourceId: string,
      key: string,
      options?: { now?: Date },
    ): Promise<void> {
      const canonicalId = sourceId.toLowerCase();
      const cutoffSeconds = Math.ceil((CONNECTOR_PUT_TIMEOUT_MS + CONNECTOR_RESERVATION_GRACE_MS) / 1000);
      await sql.begin(async tx => {
        const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!owner) throw new OpeningConnectionError("NOT_FOUND", "workspace not found");
        const explicitCutoff = options?.now
          ? new Date(options.now.getTime() + CONNECTOR_PUT_TIMEOUT_MS + CONNECTOR_RESERVATION_GRACE_MS)
          : null;
        const [updated] = explicitCutoff
          ? await tx`UPDATE opening_privacy_exclusions
              SET cleanup_not_before = GREATEST(COALESCE(cleanup_not_before, ${explicitCutoff}), ${explicitCutoff})
              WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId}
                AND id=${connectorReservationId(canonicalId)} AND asset_deleted_at IS NOT NULL
                AND pending_object_keys=ARRAY[${key}]::text[]
                AND NOT EXISTS (SELECT 1 FROM opening_sources WHERE id=${canonicalId})
              RETURNING id`
          : await tx`UPDATE opening_privacy_exclusions
              SET cleanup_not_before = GREATEST(
                COALESCE(cleanup_not_before, now() + make_interval(secs => ${cutoffSeconds})),
                now() + make_interval(secs => ${cutoffSeconds})
              )
              WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId}
                AND id=${connectorReservationId(canonicalId)} AND asset_deleted_at IS NOT NULL
                AND pending_object_keys=ARRAY[${key}]::text[]
                AND NOT EXISTS (SELECT 1 FROM opening_sources WHERE id=${canonicalId})
              RETURNING id`;
        if (!updated) throw new OpeningConnectionError("CONFLICT", "connector staging reservation changed");
      });
    },
    async removeUnpublishedSource(
      scope: OpeningScope, identity: ImportIdentity, sourceId: string, key: string, _byteSize: number,
      remove: () => Promise<void>,
      options?: { putUncertain?: boolean; now?: Date },
    ): Promise<void> {
      const canonicalId = sourceId.toLowerCase();
      await sql.begin(async tx => {
        // An uncertain COMMIT must settle before deleting a possibly published key.
        await tx`SELECT pg_advisory_xact_lock(hashtextextended(${importLock(scope, identity)}, 0))`;
        const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!owner) throw new OpeningConnectionError("NOT_FOUND", "workspace not found");
        const [published] = await tx`SELECT 1 FROM opening_sources WHERE id=${canonicalId} LIMIT 1`;
        if (published) return;
        const uncertainPut = options?.putUncertain ?? true;
        if (uncertainPut) {
          const graceSeconds = Math.ceil(CONNECTOR_RESERVATION_GRACE_MS / 1000);
          const explicitCutoff = options?.now
            ? new Date(options.now.getTime() + CONNECTOR_RESERVATION_GRACE_MS)
            : null;
          const [extended] = explicitCutoff
            ? await tx`UPDATE opening_privacy_exclusions
                SET cleanup_not_before = GREATEST(COALESCE(cleanup_not_before, ${explicitCutoff}), ${explicitCutoff})
                WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId}
                  AND id=${connectorReservationId(canonicalId)} AND asset_deleted_at IS NOT NULL
                RETURNING id`
            : await tx`UPDATE opening_privacy_exclusions
                SET cleanup_not_before = GREATEST(
                  COALESCE(cleanup_not_before, now() + make_interval(secs => ${graceSeconds})),
                  now() + make_interval(secs => ${graceSeconds})
                )
                WHERE workspace_id=${scope.workspaceId} AND source_id=${canonicalId}
                  AND id=${connectorReservationId(canonicalId)} AND asset_deleted_at IS NOT NULL
                RETURNING id`;
          if (extended) {
            // Uncertain PUT: extend grace window to a full post-abort duration while
            // attempting best-effort immediate S3 deletion.
            await remove();
            return;
          }
        } else if (await releaseConnectorReservation(tx, scope, canonicalId, key, {
          enforceNotBefore: false,
          now: options?.now,
        })) {
          await remove();
          return;
        }
        const [retained] = await tx`SELECT 1 FROM opening_source_versions WHERE source_id=${canonicalId}
          UNION ALL SELECT 1 FROM opening_privacy_exclusions WHERE source_id=${canonicalId} LIMIT 1`;
        if (!retained) await remove();
      });
    },
  };
}
