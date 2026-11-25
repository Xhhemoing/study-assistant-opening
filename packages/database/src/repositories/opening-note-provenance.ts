import { randomUUID } from "node:crypto";
import type { Sql, TransactionSql } from "postgres";
import { snippetCreateInputSchema, type SnippetCreateInput } from "@aistudy/contracts";
import {
  contextSourceRefsIncluded, isMemoryDependencyMetadata, isVerifiedSnippetLineage, mergeContextSourceRefs, noteContextSourceRefs,
  noteOriginTurnIds, parseContextMemoryDependencyIds, parseContextSourceRefs, parseNoteContextProvenanceRefs,
} from "./opening-context-provenance";
import { lockWorkspaceLearningHistory } from "./opening-learning-facts";
import { lockAndReadSnippetMemoryRefs } from "./opening-memory-admission";
import type { OpeningScope } from "./opening-sources";

type Db = Sql | TransactionSql;
export class OpeningNoteError extends Error {
  constructor(readonly code: "NOT_FOUND" | "SOURCE_UNAVAILABLE" | "PROVENANCE_UNKNOWN", message: string) { super(message); }
}

type SavedSnippetOrigin = {
  context_source_refs: unknown;
  citations: unknown;
  turn_id: string;
};

/** AI exclusion still permits personal reading; permanent source deletion does not. */
export function openingNoteReadable(db: Db, workspaceId: string, documentId: ReturnType<Db>) {
  const refs = () => noteContextSourceRefs(db, () => db`np.context_source_refs`);
  return db`NOT EXISTS (SELECT 1 FROM opening_note_provenance np
    WHERE np.workspace_id=${workspaceId} AND np.document_id=${documentId}
      AND (np.context_source_refs IS NULL OR jsonb_typeof(np.context_source_refs) IS DISTINCT FROM 'array'
        OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(np.context_source_refs)='array' THEN ${refs()} ELSE '[]'::jsonb END) ref
          WHERE NOT COALESCE(CASE WHEN ref ? 'memoryDependencyIds' THEN (
            ref=jsonb_build_object('memoryDependencyIds', ref->'memoryDependencyIds')
            AND jsonb_typeof(ref->'memoryDependencyIds')='array' AND ref->'memoryDependencyIds'<>'[]'::jsonb
            AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(ref->'memoryDependencyIds')='array'
              THEN ref->'memoryDependencyIds' ELSE '[]'::jsonb END) AS dep(id)
              WHERE dep.id IS NULL OR dep.id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
          ) ELSE (
            jsonb_typeof(ref)='object'
            AND NOT COALESCE(jsonb_path_exists(ref, 'strict $.** ? (@.type() == "array")'), false)
            AND NOT COALESCE(jsonb_path_exists(ref, '$.**.publicationCardIds'), false)
            AND NOT COALESCE(jsonb_path_exists(ref, '$.**.answerKeyBlockIds'), false)
            AND NOT COALESCE(jsonb_path_exists(ref, '$.**.originTurnIds'), false)
            AND NOT COALESCE(jsonb_path_exists(ref, '$.**.snippetLineageVersion'), false)
            AND NOT COALESCE(jsonb_path_exists(ref, '$.**.memoryDependencyIds'), false)
            AND jsonb_typeof(ref->'sourceId')='string'
            AND (ref->>'sourceId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND CASE WHEN jsonb_typeof(ref->'sourceVersion')='number' AND ref->>'sourceVersion' ~ '^[0-9]+$'
              THEN (ref->>'sourceVersion')::numeric <= 9007199254740991 ELSE false END
            AND (NOT ref ? 'memoryOnly' OR jsonb_typeof(ref->'memoryOnly')='boolean')
            AND EXISTS (SELECT 1 FROM opening_sources s WHERE s.workspace_id=np.workspace_id AND s.id::text=lower(ref->>'sourceId'))
            AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=np.workspace_id
              AND e.source_id::text=lower(ref->>'sourceId') AND e.asset_deleted_at IS NOT NULL)
          ) END, false))))`;
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
        // Preserve note-specific owner errors without taking a workspace row lock
        // ahead of history (privacy mutations acquire history first as well).
        const visibleOwner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!visibleOwner.length) throw new OpeningNoteError("NOT_FOUND", "workspace not found");
        await lockWorkspaceLearningHistory(tx, scope);
        const owner = await tx`SELECT id FROM workspaces WHERE id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId} FOR UPDATE`;
        if (!owner.length) throw new OpeningNoteError("NOT_FOUND", "workspace not found");
        const [origin] = input.savedTurnId !== undefined
          ? await tx<SavedSnippetOrigin[]>`SELECT t.context_source_refs,t.citations,t.id AS turn_id
              FROM opening_turns t
              JOIN opening_conversations c ON c.id=t.conversation_id AND c.workspace_id=t.workspace_id
              WHERE t.id=${input.savedTurnId} AND t.workspace_id=${scope.workspaceId} AND c.owner_user_id=${scope.ownerUserId}
                AND t.role='assistant' AND t.status='complete' AND NOT t.query_system AND t.system_query IS NULL
                AND t.composer_purpose IS DISTINCT FROM 'query' AND t.composer_purpose IS DISTINCT FROM 'explain_state'
                AND NOT EXISTS (SELECT 1 FROM opening_tutor_jobs j JOIN opening_turns u
                  ON u.id=j.user_turn_id AND u.workspace_id=j.workspace_id
                  WHERE j.assistant_turn_id=t.id AND j.workspace_id=t.workspace_id
                    AND (u.query_system OR u.system_query IS NOT NULL OR u.composer_purpose IN ('query','explain_state')))
              FOR SHARE OF t,c`
          : await tx<{ context_source_refs: unknown }[]>`SELECT context_source_refs FROM opening_ephemeral_provenance
              WHERE id=${input.provenanceId} AND workspace_id=${scope.workspaceId} AND owner_user_id=${scope.ownerUserId}`;
        if (!origin) throw new OpeningNoteError("NOT_FOUND", input.savedTurnId
          ? "已保存回答不可用，请重新打开已完成的普通对话回答后保存。"
          : "临时片段来源凭据不可用，请重新提问后保存。");
        const storedRefs = origin.context_source_refs;
        const savedOrigin = "turn_id" in origin;
        const verified = savedOrigin || (Array.isArray(storedRefs) && storedRefs.some(isVerifiedSnippetLineage));
        const lineageRefs = savedOrigin ? storedRefs : parseNoteContextProvenanceRefs(storedRefs);
        const recordedRefs = parseContextSourceRefs(lineageRefs);
        const directMemoryIds = parseContextMemoryDependencyIds(lineageRefs);
        const malformedMemoryRef = Array.isArray(origin.context_source_refs) && origin.context_source_refs.some(ref =>
          ref !== null && typeof ref === "object" && "memoryDependencyIds" in ref && !isMemoryDependencyMetadata(ref));
        if (recordedRefs === null || directMemoryIds === null || malformedMemoryRef) {
          throw new OpeningNoteError("PROVENANCE_UNKNOWN", "回答来源不完整，无法保存为关联笔记。请重新提问后保存。");
        }
        let refs = recordedRefs;
        let memoryOrigin: Parameters<typeof lockAndReadSnippetMemoryRefs>[2] | undefined;
        if ("citations" in origin) {
          // Selected sources need not have been retrieved. Citations, unlike selection,
          // claim consumed content and must be covered by the recorded lineage.
          const citations = parseContextSourceRefs(origin.citations);
          if (citations === null || citations.some(ref => !recordedRefs.some(parent => parent.sourceId === ref.sourceId && parent.sourceVersion === ref.sourceVersion))) {
            throw new OpeningNoteError("PROVENANCE_UNKNOWN", "回答的关联材料来源不完整，请重新提问后保存。");
          }
          if (origin.turn_id !== undefined) {
            memoryOrigin = { turnId: origin.turn_id };
          }
        } else if (directMemoryIds.length) {
          memoryOrigin = { dependencyIds: directMemoryIds };
        }
        let memoryIds = directMemoryIds;
        let originTurnIds = input.savedTurnId ? [input.savedTurnId.toLowerCase()] : verified ? noteOriginTurnIds(storedRefs) : [];
        if (memoryOrigin) {
          const lineage = await lockAndReadSnippetMemoryRefs(tx, scope, memoryOrigin);
          if (!lineage) throw new OpeningNoteError("SOURCE_UNAVAILABLE", "关联学习记忆或材料已不可用，无法保存此片段。");
          refs = mergeContextSourceRefs(refs, lineage.sourceRefs);
          memoryIds = [...new Set([...directMemoryIds, ...lineage.dependencyIds])].sort();
          if (lineage.originTurnIds.length) originTurnIds = lineage.originTurnIds;
        }
        const admission = await tx`SELECT ${contextSourceRefsIncluded(tx, scope.workspaceId, () => tx`${tx.json(refs)}::jsonb`)} AS included`;
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
        const provenance = [
          ...refs,
          ...(memoryIds.length ? [{ memoryDependencyIds: memoryIds }] : []),
          ...(verified ? [{ snippetLineageVersion: 1 }] : []),
          ...(originTurnIds.length ? [{ originTurnIds }] : []),
        ];
        await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs)
          VALUES(${documentId},${scope.workspaceId},${tx.json(provenance)})`;
        return { documentId };
      });
    },
  };
}
