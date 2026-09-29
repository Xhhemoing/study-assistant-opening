import type { TransactionSql } from "postgres";
import type { OpeningScope } from "./opening-sources";

/** Each digest belongs to its version. Missing historical metadata stays unknown. */
export async function readOpeningBackupVersionRows(tx: TransactionSql, scope: OpeningScope) {
  const { workspaceId: w, ownerUserId: u } = scope;
  return tx`
    WITH owned AS (
      SELECT s.id,s.version,s.workspace_id,s.bytes,s.sha256 FROM opening_sources s WHERE s.workspace_id=${w} AND s.upload_state='uploaded'
        AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=${w} AND e.source_id=s.id)
    ), json_refs AS (
      SELECT a.source_versions AS versions FROM opening_learning_attempts a WHERE a.workspace_id=${w} AND a.owner_user_id=${u}
      UNION ALL SELECT o.source_versions FROM opening_learning_observations o WHERE o.workspace_id=${w} AND o.owner_user_id=${u}
      UNION ALL SELECT t.source_versions FROM opening_turns t JOIN opening_conversations c ON c.id=t.conversation_id
        WHERE t.workspace_id=${w} AND c.workspace_id=${w} AND c.owner_user_id=${u}
    ), refs AS (
      SELECT s.id AS source_id, s.version FROM owned s
      UNION SELECT v.source_id,v.version FROM opening_source_versions v JOIN owned s ON s.id=v.source_id WHERE v.workspace_id=${w}
      UNION SELECT k.source_id,k.source_version FROM opening_source_chunks k JOIN owned s ON s.id=k.source_id
      UNION SELECT v.source_id,v.source_version FROM opening_learning_item_versions v JOIN owned s ON s.id=v.source_id
        WHERE v.workspace_id=${w} AND v.owner_user_id=${u}
      UNION SELECT p.source_id,p.source_version FROM opening_problem_refs p JOIN opening_learning_sessions l ON l.id=p.session_id
        JOIN owned s ON s.id=p.source_id WHERE p.workspace_id=${w} AND l.workspace_id=${w} AND l.owner_user_id=${u}
      UNION SELECT s.id, CASE WHEN j.value #>> '{}' ~ '^[0-9]{1,10}$'
        THEN CASE WHEN (j.value #>> '{}')::bigint <= 2147483647 THEN (j.value #>> '{}')::int END END
        FROM json_refs r CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(r.versions)='object' THEN r.versions ELSE '{}'::jsonb END) j
        JOIN owned s ON s.id::text=lower(j.key)
      UNION SELECT s.id, CASE WHEN jsonb_typeof(ref->'sourceVersion')='number' AND ref->>'sourceVersion' ~ '^[0-9]{1,10}$'
        THEN CASE WHEN (ref->>'sourceVersion')::bigint <= 2147483647 THEN (ref->>'sourceVersion')::int END END
        FROM opening_turns t JOIN opening_conversations c ON c.id=t.conversation_id
        CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(t.context_source_refs)='array'
          THEN t.context_source_refs ELSE '[]'::jsonb END) ref
        JOIN owned s ON s.id::text=lower(ref->>'sourceId')
        WHERE t.workspace_id=${w} AND c.workspace_id=${w} AND c.owner_user_id=${u}
    )
    SELECT r.source_id,r.version,s.workspace_id,
      CASE WHEN r.version=s.version THEN s.bytes ELSE v.bytes END AS bytes,
      CASE WHEN r.version=s.version THEN s.sha256 ELSE v.sha256 END AS sha256,
      COALESCE(v.availability,CASE WHEN r.version=s.version THEN 'available' ELSE 'unknown' END) AS availability
    FROM refs r JOIN owned s ON s.id=r.source_id
    LEFT JOIN opening_source_versions v ON v.source_id=r.source_id AND v.version=r.version AND v.workspace_id=${w}
    WHERE r.version IS NOT NULL ORDER BY r.source_id,r.version`;
}
