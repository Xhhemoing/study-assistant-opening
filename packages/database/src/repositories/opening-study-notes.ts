import { randomUUID } from "node:crypto";
import { studyNoteCreateSchema, type Scope, type StudyNoteCreate } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { assertLearningAssetTarget, insertLearningAssetLink, lockLearningAssetOwner, readLearningAssetReceipt, resolveLearningAssetOrigin } from "./opening-learning-asset-links";
import { readLearningAssetLinkView } from "./opening-learning-asset-links-read";
export function createOpeningStudyNoteRepository(sql: Sql) {
  return { create: (scope: Scope, raw: StudyNoteCreate) => sql.begin(async tx => {
    const input = studyNoteCreateSchema.parse(raw), intent = { kind: "study-note", input };
    await lockLearningAssetOwner(tx, scope);
    const receipt = await readLearningAssetReceipt(tx, scope, input.clientKey, intent);
    if (receipt) return { documentId: String(receipt.asset_id), link: await readLearningAssetLinkView(tx, scope, receipt) };
    await assertLearningAssetTarget(tx, scope, input);
    const { origin, refs } = await resolveLearningAssetOrigin(tx, scope, input.origin);
    const documentId = randomUUID(), blockId = randomUUID();
    const blocks = [{ id: blockId, type: "paragraph", position: 0, content: { blockNoteContent: [{ type: "text", text: input.text, styles: {} }], props: null, children: [] } }];
    await tx`INSERT INTO library_documents(id,workspace_id,title,lifecycle,schema_version,current_revision_number) VALUES(${documentId},${scope.workspaceId},${input.title},'scratch',1,1)`;
    await tx`INSERT INTO library_blocks(id,workspace_id,document_id,type,position,content) VALUES(${blockId},${scope.workspaceId},${documentId},'paragraph',0,${tx.json(blocks[0]!.content)})`;
    await tx`INSERT INTO library_revisions(id,workspace_id,document_id,revision_number,parent_revision_number,title,lifecycle,reason,blocks) VALUES(${randomUUID()},${scope.workspaceId},${documentId},1,NULL,${input.title},'scratch','save-study-note',${tx.json(blocks)})`;
    // Keep existing note/source privacy semantics; personal notes without sources have an explicit empty lineage.
    await tx`INSERT INTO opening_note_provenance(document_id,workspace_id,context_source_refs) VALUES(${documentId},${scope.workspaceId},${tx.json(refs)})`;
    const row = await insertLearningAssetLink(tx, scope, input, { type: "document", id: documentId, version: null }, origin, refs, intent);
    return { documentId, link: await readLearningAssetLinkView(tx, scope, row) };
  }) };
}
