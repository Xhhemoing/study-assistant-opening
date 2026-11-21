import { libraryBlockSourceReferences } from "@aistudy/domain";
import { asObject } from "./backup-map";

type Row = Record<string, unknown>;
type DocumentKey = "document_id" | "documentId";

function isAnswerType(value: unknown): boolean {
  return value === "answer_key" || value === "solution";
}

export function isBackupAnswerBlock(block: Row): boolean {
  const content = asObject(block.content);
  return block.role === "answer_key" || isAnswerType(block.type) || isAnswerType(block.blockType)
    || isAnswerType(content?.role) || isAnswerType(content?.blockType);
}

const idKey = (id: unknown) => typeof id === "string" ? id.toLowerCase() : "";

function isGeneratedExam(row: Row): boolean {
  const config = asObject(row.generation_config ?? row.generationConfig);
  return row.kind === "course_exam" || row.reason === "course_exam" || row.reason === "course-exam"
    || asObject(config?.extras)?.kind === "course_exam";
}

function isGeneratedExamBlock(block: Row): boolean {
  const content = asObject(block.content);
  // The course-exam publisher writes this rubric after the generated answer.
  // Both live rows and past document revisions use this representation.
  return isGeneratedExam(block) || (content !== null && (isGeneratedExam(content)
    || isBackupAnswerBlock(block) && content.generated === true && typeof content.answer === "string"
      && content.answer.includes("\n\n评分要点：\n")));
}

function revisionBlocks(row: Row): Row[] {
  return Array.isArray(row.blocks) ? row.blocks.map(asObject).filter(block => block !== null) : [];
}

/** Inspect both live and historical content. Legacy native packages may have no teaching rows. */
export function backupPrivateLibrary<T extends Row>(documents: T[], blocks: T[], revisions: T[], documentKey: DocumentKey,
  privateDocuments: readonly string[] = [], privateBlockIds: readonly unknown[] = [], includedSources?: ReadonlySet<string>) {
  const blockedDocuments = new Set(privateDocuments.map(idKey));
  const blockedBlocks = new Set(privateBlockIds.map(idKey).filter(Boolean));
  const blocksByDocument = [
    ...blocks.map(block => ({ documentId: block[documentKey], block })),
    ...revisions.flatMap(row => revisionBlocks(row).map(block => ({ documentId: row[documentKey], block }))),
  ];
  for (const row of documents) if (isGeneratedExam(row)) blockedDocuments.add(idKey(row.id));
  for (const row of revisions) if (isGeneratedExam(row)) blockedDocuments.add(idKey(row[documentKey]));
  for (const { documentId, block } of blocksByDocument) {
    if (isGeneratedExamBlock(block)) blockedDocuments.add(idKey(documentId));
    if (isBackupAnswerBlock(block) && idKey(block.id)) blockedBlocks.add(idKey(block.id));
    if (includedSources) {
      const refs = libraryBlockSourceReferences(block);
      if (!refs || refs.some(id => !includedSources.has(id))) blockedDocuments.add(idKey(documentId));
    }
  }
  const documentAllowed = (id: unknown) => !blockedDocuments.has(idKey(id));
  const blockAllowed = (block: Row) => !isBackupAnswerBlock(block) && !blockedBlocks.has(idKey(block.id));
  const assetAllowed = (id: unknown) => documentAllowed(id) && !blockedBlocks.has(idKey(id));
  const privatePaths = new Set<string>(), retainedPaths = new Set<string>();
  for (const { documentId, block } of blocksByDocument) {
    const path = asObject(block.content)?.href;
    if (typeof path !== "string") continue;
    (documentAllowed(documentId) && blockAllowed(block) ? retainedPaths : privatePaths).add(path);
  }
  // A path shared with a public block remains a learner attachment.
  const fileAllowed = (path: string) => !privatePaths.has(path) || retainedPaths.has(path);
  for (const block of blocks) if (!documentAllowed(block[documentKey]) && idKey(block.id)) blockedBlocks.add(idKey(block.id));
  return {
    documentAllowed, assetAllowed, blockAllowed, fileAllowed,
    documents: documents.filter(row => documentAllowed(row.id)),
    blocks: blocks.filter(row => documentAllowed(row[documentKey]) && blockAllowed(row)),
    revisions: revisions.filter(row => documentAllowed(row[documentKey])).map(row => ({
      ...row, blocks: revisionBlocks(row).filter(blockAllowed),
    })),
  };
}
