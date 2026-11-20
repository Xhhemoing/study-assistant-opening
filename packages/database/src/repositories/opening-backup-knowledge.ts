import { knowledgeSnapshotSchema } from "@aistudy/contracts";
import { knowledgeNodeDefinition } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { mapChunk } from "./opening-source-chunks";

/** Rebuild the same definitions as knowledge publication, with restored course evidence. */
export async function restoreKnowledgeDefinitions(tx: TransactionSql, row: Record<string, unknown>, workspaceId: string) {
  const snapshot = knowledgeSnapshotSchema.parse(row.snapshot);
  const ids = [...new Set(snapshot.nodes.flatMap(node => node.evidenceChunkIds))];
  if (!ids.length) return {};
  const chunks = (await tx`SELECT c.* FROM opening_source_chunks c
    JOIN opening_sources s ON s.id=c.source_id AND s.version=c.source_version
    JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=c.source_version
    JOIN course_asset_memberships m ON m.workspace_id=s.workspace_id AND m.course_id=${snapshot.courseId}
      AND m.asset_type='source' AND m.asset_id=s.id AND (m.purpose IS NULL OR m.purpose='teaching')
    WHERE s.workspace_id=${workspaceId} AND s.upload_state='uploaded' AND s.parse_state='ready'
      AND v.availability='available' AND c.id=ANY(${ids}::uuid[])
      AND c.source_version::text=${tx.json(row.source_versions as Record<string, number>)}->>s.id::text
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`)
    .map(mapChunk);
  return Object.fromEntries(snapshot.nodes.flatMap(node => {
    const definition = knowledgeNodeDefinition(node, chunks);
    return definition ? [[node.id, definition]] : [];
  }));
}
