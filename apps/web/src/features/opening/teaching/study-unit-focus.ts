import type { TeachingCheckpointSaveResult } from "@aistudy/contracts";
import type { OpeningApi } from "../client/api";
import { normalizeToCatalogId, type ClientInitBlock } from "./component-catalog";

export type TeachingStudyUnit = {
  /** Presentation identity only; persisted progress remains the existing block checkpoint. */
  id: string;
  title: string;
  blocks: ClientInitBlock[];
  questionBlockId: string | null;
};

function blockTitle(block: ClientInitBlock, index: number, question: boolean): string {
  const content = block.content;
  const record = content && typeof content === "object" && !Array.isArray(content) ? content as Record<string, unknown> : null;
  const explicit = typeof record?.title === "string" ? record.title.trim() : "";
  const body = typeof content === "string" ? content : [record?.text, record?.markdown, record?.prompt].find(value => typeof value === "string") as string | undefined;
  const heading = body?.split("\n").find(line => /^\s*#{1,6}\s+/.test(line))?.replace(/^\s*#{1,6}\s+/, "").trim();
  const title = explicit || heading || (question ? `练习 ${index + 1}` : `理解与观察 ${index + 1}`);
  return title.length > 56 ? `${title.slice(0, 56)}…` : title;
}

/** Keep an entire contiguous explanation/derivation/diagram together, then one question at a time. */
export function buildTeachingStudyUnits(blocks: readonly ClientInitBlock[]): TeachingStudyUnit[] {
  const units: TeachingStudyUnit[] = [];
  for (const block of [...blocks].sort((a, b) => a.position - b.position)) {
    const catalog = normalizeToCatalogId(block.blockType, block.role);
    const question = catalog === "question";
    const attachment = block.role === "answer_key" || block.blockType === "answer_key" || catalog === "draft" || catalog === "evidence";
    let unit = units[units.length - 1];
    if (!unit || question || (unit.questionBlockId && !attachment)) {
      unit = { id: block.blockId, title: blockTitle(block, units.length, question), blocks: [], questionBlockId: question ? block.blockId : null };
      units.push(unit);
    }
    unit.blocks.push(block);
  }
  return units;
}

export function teachingUnitForBlock(units: readonly TeachingStudyUnit[], blockId: string | null): TeachingStudyUnit | null {
  return units.find(unit => unit.blocks.some(block => block.blockId === blockId)) ?? units[0] ?? null;
}

/** Visible instructional text only; hidden references and personal drafts are never prompt context. */
export function teachingStudyUnitText(unit: TeachingStudyUnit | null): string {
  const text: string[] = [];
  for (const block of unit?.blocks ?? []) {
    const catalog = normalizeToCatalogId(block.blockType, block.role);
    if (block.role === "answer_key" || block.blockType === "answer_key" || catalog === "draft" || catalog === "evidence") continue;
    const content = block.content;
    if (typeof content === "string") text.push(content);
    else if (content && typeof content === "object" && !Array.isArray(content)) {
      const record = content as Record<string, unknown>;
      const body = [record.text, record.markdown, record.prompt, record.latex, record.formula, record.description, record.caption].find(value => typeof value === "string");
      if (typeof body === "string") text.push(body);
      if (Array.isArray(record.steps)) text.push(...record.steps.flatMap(step => typeof step === "string" ? [step] : step && typeof step === "object" && typeof step.text === "string" ? [step.text as string] : []));
    }
  }
  return text.join("\n\n").slice(0, 4000);
}

/** Navigation records a reading position only; it never skips a question or grades an answer. */
export async function saveTeachingUnitPosition(api: Pick<OpeningApi, "postTeachingCheckpoint">, activityId: string, contentVersion: number, targetBlockId: string): Promise<Extract<TeachingCheckpointSaveResult, { ok: true }>> {
  const result = await api.postTeachingCheckpoint(activityId, { expectedVersion: contentVersion, currentBlockId: targetBlockId });
  if (!result.ok) throw new Error("部分草稿位置已变化。原草稿仍保留，请重新读取后对照再继续。");
  return result;
}
