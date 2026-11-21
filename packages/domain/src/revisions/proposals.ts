import type {
  RevisionProposalBlock,
  RevisionProposalDiffEntry,
} from "@aistudy/contracts";

export function assertNonEmptyRevisionBlocks(blocks: RevisionProposalBlock[]): void {
  if (!blocks.length) throw new Error("Document requires at least one block");
}

const idKey = (id: string) => id.toLowerCase();

function assertUnique(blocks: RevisionProposalBlock[]): void {
  const seen = new Set<string>();
  for (const block of blocks) {
    const key = idKey(block.id);
    if (seen.has(key)) throw new Error(`Duplicate block id: ${block.id}`);
    seen.add(key);
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
  const proposedById = new Map(proposedBlocks.map((block) => [idKey(block.id), block]));
  const baseIds = new Set(baseBlocks.map((block) => idKey(block.id)));
  const result: RevisionProposalDiffEntry[] = baseBlocks.map((base) => {
    const proposed = proposedById.get(idKey(base.id)) ?? null;
    return {
      blockId: base.id,
      kind: proposed === null ? "removed" : sameBlock(base, proposed) ? "unchanged" : "changed",
      base,
      proposed,
    };
  });
  for (const proposed of proposedBlocks) {
    if (!baseIds.has(idKey(proposed.id))) {
      result.push({ blockId: proposed.id, kind: "added", base: null, proposed });
    }
  }
  return result;
}

function selectedSet(selectedIds: string[]): Set<string> {
  const result = new Set<string>();
  for (const id of selectedIds) {
    const key = idKey(id);
    if (result.has(key)) throw new Error(`Duplicate selected block id: ${id}`);
    result.add(key);
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
  const proposedById = new Map(proposedBlocks.map((block) => [idKey(block.id), block]));
  const removedIds = new Set(diff.filter((entry) => entry.kind === "removed").map((entry) => idKey(entry.blockId)));
  for (const rawId of selectedProposalBlockIds) {
    const key = idKey(rawId);
    if (!proposedById.has(key) && !removedIds.has(key)) throw new Error(`Unknown selected proposal block: ${rawId}`);
  }
  const currentIds = new Set(currentBlocks.map((block) => idKey(block.id)));
  const result = currentBlocks
    .filter((block) => !selected.has(idKey(block.id)) || !removedIds.has(idKey(block.id)))
    .map((block) => {
      const key = idKey(block.id);
      if (!selected.has(key)) return block;
      const proposed = proposedById.get(key);
      return proposed ? { ...proposed, id: block.id } : block;
    });
  for (const block of proposedBlocks) {
    const key = idKey(block.id);
    if (selected.has(key) && !currentIds.has(key)) result.push(block);
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
  const proposedById = new Map(proposedBlocks.map((block) => [idKey(block.id), block]));
  const removedIds = new Set(diff.filter((entry) => entry.kind === "removed").map((entry) => idKey(entry.blockId)));
  for (const rawId of selectedProposalBlockIds) {
    const key = idKey(rawId);
    if (!proposedById.has(key) && !removedIds.has(key)) throw new Error(`Unknown selected proposal block: ${rawId}`);
  }
  const used = new Set(currentBlocks.map((block) => idKey(block.id)));
  const result = [...currentBlocks];
  let salt = 0;
  for (const proposed of proposedBlocks) {
    const proposedKey = idKey(proposed.id);
    if (!selected.has(proposedKey)) continue;
    let id = proposed.id;
    while (used.has(idKey(id))) id = stableCollisionId(proposedKey, ++salt);
    used.add(idKey(id));
    result.push({ ...proposed, id });
  }
  return result.map((block, position) => ({ ...block, position }));
}
