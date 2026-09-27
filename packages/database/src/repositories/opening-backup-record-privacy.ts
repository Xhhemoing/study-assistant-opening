import type { Sql, TransactionSql } from "postgres";

type Tx = Sql | TransactionSql;
type Fragment = ReturnType<Tx>;
export function cleanUuidSources(tx: Tx, id: string, ids: Fragment) {
  return tx`
    NOT EXISTS (
      SELECT 1 FROM unnest(${ids}) sid(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM opening_sources s
        WHERE s.id = sid.id AND s.workspace_id = ${id} AND s.upload_state = 'uploaded'
      ) OR EXISTS (
        SELECT 1 FROM opening_privacy_exclusions e
        WHERE e.workspace_id = ${id} AND e.source_id = sid.id
      )
    )`;
}

export function memoryNotExcluded(tx: Tx, id: string) {
  return tx`
    NOT EXISTS (
      SELECT 1 FROM opening_privacy_exclusions e
      WHERE e.workspace_id = ${id} AND e.memory_id = m.id
    )`;
}

/** Session-dependent rows must refer to a session that is itself exportable. */
export function includedLearningSession(tx: Tx, id: string, userId: string, session: Fragment) {
  return tx`EXISTS (
    SELECT 1 FROM opening_learning_sessions backup_session
    WHERE backup_session.id = ${session} AND backup_session.workspace_id = ${id}
      AND backup_session.owner_user_id = ${userId}
      AND ${cleanUuidSources(tx, id, tx`backup_session.source_ids`)}
  )`;
}
