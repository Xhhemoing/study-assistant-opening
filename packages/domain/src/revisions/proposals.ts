import type {
  RevisionProposalBlock,
  RevisionProposalDiffEntry,
} from "@aistudy/contracts";

export function assertNonEmptyRevisionBlocks(blocks: RevisionProposalBlock[]): void {
  if (!blocks.length) throw new Error("Document requires at least one block");
}

function assertUnique(blocks: RevisionProposalBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    if (seen.has(block.id)) throw new Error(`Duplicate block id: ${block.id}`);
    seen.add(block.id);
  }
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sameBlock(left: RevisionProposalBlock, right: RevisionProposalBlock): boolean {
  return left.type === right.type && left.position === right.position && stable(left.content) === stable(right.content);
}

export function diffRevisionBlocks(
  baseBlocks: RevisionProposalBlock[],
  proposedBlocks: RevisionProposalBlock[],
): RevisionProposalDiffEntry[] {
  assertUnique(baseBlocks);
  assertUnique(proposedBlocks);
  const proposedById = new Map(proposedBlocks.map((block) => [block.id, block]));
  const baseIds = new Set(baseBlocks.map((block) => block.id));
  const result: RevisionProposalDiffEntry[] = baseBlocks.map((base) => {
    const proposed = proposedById.get(base.id) ?? null;
    return {
      blockId: base.id,
      kind: proposed === null ? "removed" : sameBlock(base, proposed) ? "unchanged" : "changed",
      base,
      proposed,
    };
  });
  for (const proposed of proposedBlocks) {
    if (!baseIds.has(proposed.id)) {
      result.push({ blockId: proposed.id, kind: "added", base: null, proposed });
    }
  }
  return result;
}

function selectedSet(selectedIds: string[]): Set<string> {
  const result = new Set<string>();
  for (const id of selectedIds) {
    if (result.has(id)) throw new Error(`Duplicate selected block id: ${id}`);
    result.add(id);
  }
  return result;
}

export function selectProposalBlocks(
  currentBlocks: RevisionProposalBlock[],
  proposedBlocks: RevisionProposalBlock[],
  selectedProposalBlockIds: string[],
  diff: RevisionProposalDiffEntry[] = diffRevisionBlocks(currentBlocks, proposedBlocks),
): RevisionProposalBlock[] {
  assertUnique(currentBlocks);
  assertUnique(proposedBlocks);
  const selected = selectedSet(selectedProposalBlockIds);
  const proposedById = new Map(proposedBlocks.map((block) => [block.id, block]));
  const removedIds = new Set(diff.filter((entry) => entry.kind === "removed").map((entry) => entry.blockId));
  for (const id of selected) {
    if (!proposedById.has(id) && !removedIds.has(id)) throw new Error(`Unknown selected proposal block: ${id}`);
  }
  const currentIds = new Set(currentBlocks.map((block) => block.id));
  const result = currentBlocks
    .filter((block) => !selected.has(block.id) || !removedIds.has(block.id))
    .map((block) => selected.has(block.id) ? proposedById.get(block.id) ?? block : block);
  for (const block of proposedBlocks) {
    if (selected.has(block.id) && !currentIds.has(block.id)) result.push(block);
  }
  return result.map((block, position) => ({ ...block, position }));
}

function stableCollisionId(originalId: string, salt: number): string {
  let hash = 2166136261;
  for (const char of `${originalId}:${salt}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  const hex = ((hash >>> 0).toString(16).padStart(8, "0") + "000000000000000000000000").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

export function preserveBothBlocks(
  currentBlocks: RevisionProposalBlock[],
  proposedBlocks: RevisionProposalBlock[],
  selectedProposalBlockIds: string[],
  diff: RevisionProposalDiffEntry[] = diffRevisionBlocks(currentBlocks, proposedBlocks),
): RevisionProposalBlock[] {
  assertUnique(currentBlocks);
  assertUnique(proposedBlocks);
  const selected = selectedSet(selectedProposalBlockIds);
  const proposedById = new Map(proposedBlocks.map((block) => [block.id, block]));
  const removedIds = new Set(diff.filter((entry) => entry.kind === "removed").map((entry) => entry.blockId));
  for (const id of selected) {
    if (!proposedById.has(id) && !removedIds.has(id)) throw new Error(`Unknown selected proposal block: ${id}`);
  }
  const used = new Set(currentBlocks.map((block) => block.id));
  const result = [...currentBlocks];
  let salt = 0;
  for (const proposed of proposedBlocks) {
    if (!selected.has(proposed.id)) continue;
    let id = proposed.id;
    while (used.has(id)) id = stableCollisionId(proposed.id, ++salt);
    used.add(id);
    result.push({ ...proposed, id });
  }
  return result.map((block, position) => ({ ...block, position }));
}
