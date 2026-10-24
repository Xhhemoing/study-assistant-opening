import { knowledgeSnapshotSchema, type Scope } from "@aistudy/contracts";
import type { TransactionSql } from "postgres";
import { materialPageReadable } from "./opening-material-manifest";
import { learningError } from "./opening-learning-facts";

/**
 * Call after updating the version's manifest, inside that SAME transaction.
 * The manifest writer owns history → workspace (exclusive) → source/version;
 * reusing its workspace lock serializes us with graph publication/reparsing.
 * Only derived data is changed: no new job, outbox, model call or learner fact.
 */
export async function invalidateMaterialDerived(
  tx: TransactionSql,
  scope: Scope,
  sourceId: string,
  version: number,
): Promise<void> {
  const [owner] = await tx`SELECT id FROM workspaces
    WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
  if (!owner) throw learningError("NOT_FOUND", "workspace not found");
  const [source] = await tx`SELECT s.id FROM opening_sources s
    JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id
    WHERE s.id=${sourceId} AND s.workspace_id=${scope.workspaceId} AND v.version=${version}
    FOR SHARE OF s,v`;
  if (!source) throw learningError("NOT_FOUND", "source version not found");

  const graphs = await tx`SELECT course_id,version,snapshot,source_versions,node_definitions
    FROM opening_course_knowledge
    WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}
      AND source_versions->>${sourceId}=${String(version)}
    ORDER BY course_id FOR UPDATE`;
  for (const graph of graphs) {
    const snapshot = knowledgeSnapshotSchema.parse(graph.snapshot);
    const ids = [...new Set([...snapshot.nodes, ...snapshot.edges].flatMap(item => item.evidenceChunkIds))];
    const readable = ids.length ? await tx`SELECT c.id FROM opening_source_chunks c
      JOIN opening_sources s ON s.id=c.source_id AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
      JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id
        AND v.version=c.source_version AND v.availability='available'
      JOIN course_asset_memberships m ON m.workspace_id=s.workspace_id AND m.course_id=${String(graph.course_id)}
        AND m.asset_type='source' AND m.asset_id=s.id
      WHERE c.id=ANY(${ids}::uuid[])
        AND c.source_version::text=(${tx.json(graph.source_versions as Record<string, number>)}->>s.id::text)
        AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
        AND ${materialPageReadable(tx, "c.source_id", "c.source_version", "c.page")}` : [];
    const allowed = new Set(readable.map(row => String(row.id)));
    // A reparse may already have removed historical chunk UUIDs. Without a
    // readable locator, cached text must not be treated as authoritative proof.
    const affectedNodes = new Set(snapshot.nodes
      .filter(node => node.evidenceChunkIds.some(id => !allowed.has(id))).map(node => node.id));
    let changed = false;
    const nodes = snapshot.nodes.map(node => {
      if (!affectedNodes.has(node.id) || node.status === "needs_check") return node;
      changed = true;
      return { ...node, status: "needs_check" as const };
    });
    const edges = snapshot.edges.map(edge => {
      if (edge.status === "needs_check" || (!affectedNodes.has(edge.from) && !affectedNodes.has(edge.to)
        && edge.evidenceChunkIds.every(id => allowed.has(id)))) return edge;
      changed = true;
      return { ...edge, status: "needs_check" as const };
    });
    const definitions = { ...graph.node_definitions as Record<string, string> };
    for (const id of affectedNodes) {
      if (Object.hasOwn(definitions, id)) { delete definitions[id]; changed = true; }
    }
    if (!changed) continue;
    // Revoke stale editor/rebuild CAS inputs as well as supported status.
    const nextVersion = Number(graph.version) + 1;
    await tx`UPDATE opening_course_knowledge
      SET version=${nextVersion},snapshot=${tx.json({ ...snapshot, version: nextVersion, nodes, edges })},
        node_definitions=${tx.json(definitions)},updated_at=now()
      WHERE workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} AND course_id=${String(graph.course_id)}`;
  }

  // Existing vectors may contain answer text even though recall already filters
  // their pages. Purge those derivatives without scheduling a paid rebuild.
  await tx`DELETE FROM opening_source_embeddings e USING opening_source_chunks c,opening_sources s
    WHERE e.chunk_id=c.id AND e.source_id=c.source_id AND e.source_version=c.source_version
      AND s.id=c.source_id AND s.workspace_id=${scope.workspaceId}
      AND c.source_id=${sourceId} AND c.source_version=${version}
      AND NOT (${materialPageReadable(tx, "c.source_id", "c.source_version", "c.page")})`;
}
