import { knowledgeSnapshotSchema, type Scope, type SourceChunk } from "@aistudy/contracts";
import { knowledgeNodeDefinition } from "@aistudy/domain";
import type { TransactionSql } from "postgres";

/** Upgrade pre-definition graphs before the parser replaces their evidence UUIDs.
 * Workspace → graph → source/chunks matches graph publication and privacy writes. */
export async function preserveOpeningKnowledgeDefinitions(tx: TransactionSql, scope: Scope, sourceId: string): Promise<void> {
  const [owner] = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR SHARE`;
  if (!owner) throw new Error("workspace not found");
  const graphs = await tx`SELECT course_id,snapshot,source_versions,node_definitions FROM opening_course_knowledge
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND source_versions ? ${sourceId}
    ORDER BY course_id FOR UPDATE`;
  for (const graph of graphs) {
    const parsed = knowledgeSnapshotSchema.safeParse(graph.snapshot);
    if (!parsed.success || parsed.data.courseId !== graph.course_id) continue;
    const definitions = { ...graph.node_definitions as Record<string, string> };
    const missing = parsed.data.nodes.filter(node => !definitions[node.id] && node.evidenceChunkIds.length);
    if (!missing.length) continue;
    const ids = [...new Set(missing.flatMap(node => node.evidenceChunkIds))];
    const rows = await tx`SELECT c.* FROM opening_source_chunks c
      JOIN opening_sources s ON s.id=c.source_id AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
      JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id
        AND v.version=c.source_version AND v.availability='available'
      JOIN course_asset_memberships m ON m.workspace_id=s.workspace_id AND m.course_id=${String(graph.course_id)}
        AND m.asset_type='source' AND m.asset_id=s.id
      WHERE c.id=ANY(${ids}::uuid[])
        AND c.source_version::text=${tx.json(graph.source_versions as Record<string, number>)}->>s.id::text
        AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      FOR SHARE OF c,s,v,m`;
    const chunks: SourceChunk[] = rows.map(row => ({ id: String(row.id), sourceId: String(row.source_id), sourceVersion: Number(row.source_version),
      page: row.page == null ? null : Number(row.page), slideLabel: row.slide_label as string | null,
      startMs: row.start_ms == null ? null : Number(row.start_ms), endMs: row.end_ms == null ? null : Number(row.end_ms),
      text: typeof row.text === "string" ? row.text : "", imageObjectKey: row.image_object_key as string | null }));
    const replacing = new Set(chunks.filter(chunk => chunk.sourceId === sourceId).map(chunk => chunk.id));
    let changed = false;
    for (const node of missing) {
      if (!node.evidenceChunkIds.some(id => replacing.has(id))) continue;
      const definition = knowledgeNodeDefinition(node, chunks);
      if (definition) { definitions[node.id] = definition; changed = true; }
    }
    if (changed) await tx`UPDATE opening_course_knowledge SET node_definitions=${tx.json(definitions)}
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${String(graph.course_id)}`;
  }
}
