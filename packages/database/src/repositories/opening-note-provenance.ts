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

/** A BlockNote block without ids; the caller derives it from `input.text`. */
export type SnippetNoteBlock = { type: string; props: Record<string, unknown> | null; content: unknown; children: SnippetNoteBlock[] };

function withIds(block: SnippetNoteBlock): { id: string; type: string; content: Record<string, unknown> } {
  const child = (item: SnippetNoteBlock): Record<string, unknown> => ({
    id: randomUUID(), type: item.type, props: item.props ?? {}, content: item.content, children: item.children.map(child),
  });
  return { id: randomUUID(), type: block.type, content: { blockNoteContent: block.content, props: block.props, children: block.children.map(child) } };
}

export function createOpeningNoteRepository(sql: Sql) {
  return {
    /** `structured` is the note body as blocks; when absent the text is saved as one paragraph. */
    async saveSnippet(scope: OpeningScope, raw: SnippetCreateInput, structured?: SnippetNoteBlock[]): Promise<{ documentId: string }> {
      const input = snippetCreateInputSchema.parse(raw);
      return sql.begin(async tx => {
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningNoteError("NOT_FOUND", "workspace not found");
        const origins = input.savedTurnId !== undefined
          ? await tx`SELECT t.context_source_refs,t.citations FROM opening_turns t
              JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
              WHERE t.id=${input.savedTurnId} AND t.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
                AND t.role='assistant' AND t.status='complete' AND NOT t.query_system AND t.system_query IS NULL
                AND t.composer_purpose IS DISTINCT FROM 'query' AND t.composer_purpose IS DISTINCT FROM 'explain_state'
                AND NOT EXISTS (SELECT 1 FROM opening_tutor_jobs j JOIN opening_turns u
                  ON u.id=j.user_turn_id AND u.workspace_id=j.workspace_id
                  WHERE j.assistant_turn_id=t.id AND j.workspace_id=t.workspace_id
                    AND (u.query_system OR u.system_query IS NOT NULL OR u.composer_purpose IN ('query','explain_state')))
              FOR SHARE OF t,c`
          : await tx`SELECT context_source_refs FROM opening_ephemeral_provenance
              WHERE id=${input.provenanceId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!origins.length) throw new OpeningNoteError("NOT_FOUND", input.savedTurnId
          ? "已保存回答不可用，请重新打开已完成的普通对话回答后保存。"
          : "临时片段来源凭据不可用，请重新提问后保存。");
        const refs = parseContextSourceRefs(origins[0]!.context_source_refs);
        if (refs === null) throw new OpeningNoteError("PROVENANCE_UNKNOWN", "回答来源不完整，无法保存为关联笔记。请重新提问后保存。");
        if (input.savedTurnId) {
          // Selected sources need not have been retrieved. Citations, unlike selection,
          // claim consumed content and must be covered by the recorded lineage.
          const citations = parseContextSourceRefs(origins[0]!.citations);
          if (citations === null || citations.some(ref => !refs.some(parent => parent.sourceId === ref.sourceId && parent.sourceVersion === ref.sourceVersion))) {
            throw new OpeningNoteError("PROVENANCE_UNKNOWN", "回答的关联材料来源不完整，请重新提问后保存。");
          }
        }
        const admission = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, tx`${tx.json(refs)}::jsonb`)} AS included`;
        if (!admission[0]!.included) throw new OpeningNoteError("SOURCE_UNAVAILABLE", "关联材料已删除、停止供 AI 使用或版本已变化，无法保存此片段。");
        const documentId = randomUUID();
        const blocks = (structured?.length ? structured : [{ type: "paragraph", props: null, content: input.text, children: [] }])
          .map((block, position) => { const { id, type, content } = withIds(block); return { id, type, position, content }; });
        await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle,schema_version,current_revision_number)
          VALUES(${documentId},${scope.workspaceId},${input.title},'scratch',1,1)`;
        for (const block of blocks) {
          await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content)
            VALUES(${block.id},${scope.workspaceId},${documentId},${block.type},${block.position},${tx.json(block.content as never)})`;
        }
        await tx`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,parent_revision_number,title,lifecycle,reason,blocks)
          VALUES(${randomUUID()},${scope.workspaceId},${documentId},1,NULL,${input.title},'scratch','save-opening-snippet',${tx.json(blocks as never)})`;
        await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
          VALUES(${documentId},${scope.workspaceId},${tx.json(refs)})`;
        return { documentId };
      });
    },
  };
}
