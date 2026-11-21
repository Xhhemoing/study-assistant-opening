import type { Sql, TransactionSql } from "postgres";
import type { RevisionBlockSnapshot } from "../schema/library";
import { isBackupAnswerBlock } from "./backup-private-library";
import { publicationAnswerKeysByDocument } from "./backup-publication-provenance";

export const PROTECTED_ANSWER_BLOCK_ERROR_MESSAGE = "Protected answer blocks cannot be modified or forged";

export { isBackupAnswerBlock };

export function excludeAnswerKeys(ids: readonly string[] = []) {
  const hidden = new Set(ids.map((id) => id.toLowerCase()));
  return <T extends { id: string }>(block: T): boolean =>
    !isBackupAnswerBlock(block as unknown as Record<string, unknown>) && !hidden.has(block.id.toLowerCase());
}

export async function readDocumentAnswerKeyIds(
  client: Sql | TransactionSql,
  workspaceId: string,
  documentIds: string[],
): Promise<Map<string, string[]>> {
  if (!documentIds.length) return new Map<string, string[]>();
  const rows = await client`SELECT document_id,block_order,NULL::jsonb AS context_source_refs
    FROM opening_teaching_activity_specs WHERE workspace_id=${workspaceId} AND document_id=ANY(${documentIds}::uuid[])
    UNION ALL
    SELECT document_id,NULL::jsonb,context_source_refs
    FROM opening_note_provenance WHERE workspace_id=${workspaceId} AND document_id=ANY(${documentIds}::uuid[])`;
  return publicationAnswerKeysByDocument(rows, rows);
}

export function collectProtectedBlockIds(
  existingBlocks: readonly RevisionBlockSnapshot[],
  answerKeyIds: readonly string[],
): Set<string> {
  const isVisibleExisting = excludeAnswerKeys(answerKeyIds);
  return new Set<string>([
    ...answerKeyIds.map((id) => id.toLowerCase()),
    ...existingBlocks.filter((block) => !isVisibleExisting(block)).map((block) => block.id.toLowerCase()),
  ]);
}

export function hasForgedOrProtectedBlock(
  rawBlocks: readonly unknown[],
  protectedIds: ReadonlySet<string>,
): boolean {
  for (const block of rawBlocks) {
    if (!block || typeof block !== "object") continue;
    const record = block as Record<string, unknown>;
    if (typeof record.id === "string" && protectedIds.has(record.id.toLowerCase())) {
      return true;
    }
    if (isBackupAnswerBlock(record)) {
      return true;
    }
  }
  return false;
}

export function mergePreservedProtectedBlocks(
  existingBlocks: readonly RevisionBlockSnapshot[],
  submittedBlocks: readonly RevisionBlockSnapshot[],
  isVisibleExisting: (block: RevisionBlockSnapshot) => boolean,
): RevisionBlockSnapshot[] {
  const existingStates = existingBlocks.map((block) => ({
    block,
    visible: isVisibleExisting(block),
  }));
  if (existingStates.every((entry) => entry.visible)) {
    return submittedBlocks.map((block, position) => ({ ...block, position }));
  }

  const submittedIds = new Set(submittedBlocks.map((block) => block.id.toLowerCase()));
  const leading: RevisionBlockSnapshot[] = [];
  const trailing: RevisionBlockSnapshot[] = [];
  const beforeBlock = new Map<string, RevisionBlockSnapshot[]>();
  const afterBlock = new Map<string, RevisionBlockSnapshot[]>();

  const pushTo = (map: Map<string, RevisionBlockSnapshot[]>, key: string, block: RevisionBlockSnapshot) => {
    const list = map.get(key) ?? [];
    list.push(block);
    map.set(key, list);
  };

  for (let i = 0; i < existingStates.length; i += 1) {
    const entry = existingStates[i]!;
    if (entry.visible) continue;

    let immediatePrevVisibleId: string | null = null;
    let hadEarlierVisible = false;
    let nearestSurvivingEarlierId: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (!existingStates[j]!.visible) continue;
      const id = existingStates[j]!.block.id.toLowerCase();
      if (!hadEarlierVisible) {
        hadEarlierVisible = true;
        immediatePrevVisibleId = id;
      }
      if (submittedIds.has(id)) {
        nearestSurvivingEarlierId = id;
        break;
      }
    }

    let hasLaterVisible = false;
    let nearestSurvivingLaterId: string | null = null;
    for (let k = i + 1; k < existingStates.length; k += 1) {
      if (!existingStates[k]!.visible) continue;
      hasLaterVisible = true;
      const id = existingStates[k]!.block.id.toLowerCase();
      if (submittedIds.has(id)) {
        nearestSurvivingLaterId = id;
        break;
      }
    }

    if (!hadEarlierVisible) {
      leading.push(entry.block);
    } else if (immediatePrevVisibleId && submittedIds.has(immediatePrevVisibleId)) {
      pushTo(afterBlock, immediatePrevVisibleId, entry.block);
    } else if (!hasLaterVisible) {
      trailing.push(entry.block);
    } else if (nearestSurvivingEarlierId) {
      pushTo(afterBlock, nearestSurvivingEarlierId, entry.block);
    } else if (nearestSurvivingLaterId) {
      pushTo(beforeBlock, nearestSurvivingLaterId, entry.block);
    } else {
      trailing.push(entry.block);
    }
  }

  const merged: RevisionBlockSnapshot[] = [...leading];
  for (const block of submittedBlocks) {
    const key = block.id.toLowerCase();
    const before = beforeBlock.get(key);
    if (before) merged.push(...before);
    merged.push(block);
    const after = afterBlock.get(key);
    if (after) merged.push(...after);
  }
  merged.push(...trailing);

  return merged.map((block, position) => ({
    id: block.id,
    type: block.type,
    position,
    content: block.content,
  }));
}
