import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { snippetCreateInputSchema, type SnippetCreateInput } from "@aistudy/contracts";
import { contextSourceRefsIncluded, parseContextSourceRefs } from "./opening-context-provenance";
import type { OpeningScope } from "./opening-sources";

type Db = Sql | TransactionSql;
export class OpeningNoteError extends Error {
  constructor(readonly code: "NOT_FOUND" | "SOURCE_UNAVAILABLE" | "PROVENANCE_UNKNOWN", message: string) { super(message); }
}

/** AI exclusion still permits personal reading; permanent source deletion does not. */
export function openingNoteReadable(db: Db, workspaceId: string, documentId: ReturnType<Db>) {
  return db`NOT EXISTS (SELECT 1 FROM opening_note_provenance np
    WHERE np.workspace_id=${workspaceId} AND np.document_id=${documentId}
      AND (np.context_source_refs IS NULL OR jsonb_typeof(np.context_source_refs) IS DISTINCT FROM 'array'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(np.context_source_refs)='array' THEN np.context_source_refs ELSE '[]'::jsonb END) ref
          WHERE NOT EXISTS (SELECT 1 FROM opening_sources s WHERE s.workspace_id=np.workspace_id AND s.id::text=lower(ref->>'sourceId')))
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(np.context_source_refs)='array' THEN np.context_source_refs ELSE '[]'::jsonb END) ref
          JOIN opening_privacy_exclusions e ON e.workspace_id=np.workspace_id AND e.source_id::text=lower(ref->>'sourceId')
          WHERE e.asset_deleted_at IS NOT NULL)))`;
}

export function createOpeningNoteRepository(sql: Sql) {
  return {
    async saveSnippet(scope: OpeningScope, raw: SnippetCreateInput): Promise<{ documentId: string }> {
      const input = snippetCreateInputSchema.parse(raw);
      return sql.begin(async tx => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningNoteError("NOT_FOUND", "workspace not found");
        const receipts = await tx`SELECT context_source_refs FROM opening_ephemeral_provenance
          WHERE id=${input.provenanceId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!receipts.length) throw new OpeningNoteError("NOT_FOUND", "临时片段来源凭据不可用，请重新提问后保存。");
        const refs = parseContextSourceRefs(receipts[0]!.context_source_refs);
        if (refs === null) throw new OpeningNoteError("PROVENANCE_UNKNOWN", "临时历史来源不完整，无法保存为关联笔记。请开始新的临时对话。");
        const admission = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(refs)}::jsonb`)} AS included`;
        if (!admission[0]!.included) throw new OpeningNoteError("SOURCE_UNAVAILABLE", "关联材料已删除、停止供 AI 使用或版本已变化，无法保存此片段。");
        const documentId = randomUUID(), blockId = randomUUID();
        const content = { blockNoteContent: input.text, props: null, children: [] };
        const blocks = [{ id: blockId, type: "paragraph", position: 0, content }];
        await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle,schema_version,current_revision_number)
          VALUES(${documentId},${scope.workspaceId},${input.title},'scratch',1,1)`;
        await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
          VALUES(${blockId},${scope.workspaceId},${documentId},'paragraph',0,${tx.json(content)})`;
        await tx`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,parent_revision_number,title,lifecycle,reason,blocks)
          VALUES(${randomUUID()},${scope.workspaceId},${documentId},1,NULL,${input.title},'scratch','save-opening-snippet',${tx.json(blocks)})`;
        await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
          VALUES(${documentId},${scope.workspaceId},${tx.json(refs)})`;
        return { documentId };
      });
    },
  };
}
