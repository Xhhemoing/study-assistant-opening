import type { OpeningMemoryDeletions } from "./backup-policy";

// Structural preflight only; this is not a database row schema or an archive reader.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Order an archive's revisions independently of storage order and timestamp precision. */
export function orderBackupMisconceptionRevisions(rows: readonly Record<string, unknown>[]) {
  const byId = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    if (!isUuid(row.revision_id) || !isUuid(row.edge_id) || !isUuid(row.workspace_id) || !isUuid(row.owner_user_id)) return null;
    const id = row.revision_id.toLowerCase();
    if (byId.has(id)) return null;
    byId.set(id, row);
  }

  const ordered: Record<string, unknown>[] = [];
  const children = new Map<string, Record<string, unknown>[]>();
  for (const row of rows) {
    if (row.prior_revision_id == null) {
      ordered.push(row);
      continue;
    }
    if (!isUuid(row.prior_revision_id)) return null;
    const prior = row.prior_revision_id.toLowerCase();
    const parent = byId.get(prior);
    if (!parent || String(parent.edge_id).toLowerCase() !== String(row.edge_id).toLowerCase()
      || String(parent.workspace_id).toLowerCase() !== String(row.workspace_id).toLowerCase()
      || String(parent.owner_user_id).toLowerCase() !== String(row.owner_user_id).toLowerCase()) return null;
    const siblings = children.get(prior);
    if (siblings) siblings.push(row);
    else children.set(prior, [row]);
  }
  for (const row of ordered) {
    for (const child of children.get(String(row.revision_id).toLowerCase()) ?? []) ordered.push(child);
  }
  return ordered.length === rows.length ? ordered : null;
}

export function isJournal(value: unknown): value is Array<{ sourceId: string; deletedAt: string; assetDeletedAt?: string | null }> {
  return Array.isArray(value) && value.every((mark) => isRecord(mark)
    && isUuid(mark.sourceId) && typeof mark.deletedAt === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(mark.deletedAt) && Number.isFinite(Date.parse(mark.deletedAt))
    && (mark.assetDeletedAt == null || (typeof mark.assetDeletedAt === "string"
      && /^\d{4}-\d{2}-\d{2}T/.test(mark.assetDeletedAt) && Number.isFinite(Date.parse(mark.assetDeletedAt)))));
}

export function isTables(value: unknown): value is Record<string, Record<string, unknown>[]> {
  return isRecord(value) && Object.values(value).every((rows) => Array.isArray(rows) && rows.every(isRecord));
}

/** Content-free, workspace-bound facts; an omitted live read is not an empty result. */
export function isMemoryDeletions(value: unknown, workspaceId: string): value is OpeningMemoryDeletions {
  if (!isRecord(value) || !isUuid(value.workspaceId) || value.workspaceId.toLowerCase() !== workspaceId.toLowerCase()
    || Object.keys(value).some(key => key !== "workspaceId" && key !== "memories") || !Array.isArray(value.memories)) return false;
  const seen = new Set<string>();
  return value.memories.every(mark => {
    if (!isRecord(mark) || Object.keys(mark).some(key => key !== "memoryId" && key !== "deletedAt")
      || !isUuid(mark.memoryId) || typeof mark.deletedAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T/.test(mark.deletedAt) || !Number.isFinite(Date.parse(mark.deletedAt))) return false;
    const id = mark.memoryId.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

export function sameMemoryDeletions(left: OpeningMemoryDeletions, right: OpeningMemoryDeletions): boolean {
  if (!isMemoryDeletions(left, right.workspaceId) || !isMemoryDeletions(right, left.workspaceId)
    || left.memories.length !== right.memories.length) return false;
  const key = (mark: OpeningMemoryDeletions["memories"][number]) => `${mark.memoryId.toLowerCase()}\u0000${new Date(mark.deletedAt).toISOString()}`;
  const keys = new Set(left.memories.map(key));
  return right.memories.every(mark => keys.has(key(mark)));
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

export function validObject(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return isUuid(value.sourceId) && isHash(value.sha256)
    && Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0
    && typeof value.archivePath === "string"
    // Portable archive member names only; never permit path traversal or drive paths.
    && /^objects\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)*$/.test(value.archivePath)
    && (value.actualSha256 === undefined || isHash(value.actualSha256));
}

export function uuidList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isUuid);
}

export function parseUuidArray(value: unknown): string[] | null {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return uuidList(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return uuidList(value) ? value : null;
}

function parseCitations(value: unknown): string[] | null {
  let citations = value;
  if (typeof citations === "string") {
    try {
      citations = JSON.parse(citations) as unknown;
    } catch {
      return null;
    }
  }
  if (!Array.isArray(citations)) return null;
  const refs: string[] = [];
  for (const citation of citations) {
    if (!isRecord(citation) || !isUuid(citation.sourceId)
      || typeof citation.sourceVersion !== "number"
      || !Number.isSafeInteger(citation.sourceVersion) || citation.sourceVersion < 0
      || (citation.memoryOnly !== undefined && typeof citation.memoryOnly !== "boolean")) return null;
    refs.push(citation.sourceId);
  }
  return refs;
}

/** Assistant turn provenance can carry exact global-memory dependency IDs alongside versioned source refs. */
export function turnMemoryDependencyMetadata(value: unknown): { memoryDependencyIds: string[] } | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== "memoryDependencyIds") return null;
  const ids = value.memoryDependencyIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every(isUuid)) return null;
  const normalized = ids.map(id => id.toLowerCase());
  if (new Set(normalized).size !== normalized.length) return null;
  return { memoryDependencyIds: normalized };
}

/** Extract exact global-memory dependency IDs from an opening_turns row. Returns null on malformed metadata. */
export function turnMemoryDependencyIds(row: Record<string, unknown>): string[] | null {
  if (row.context_source_refs === undefined || row.context_source_refs === null) return [];
  if (!Array.isArray(row.context_source_refs)) return null;
  let metadata: string[] | null = null;
  for (const ref of row.context_source_refs) {
    if (isRecord(ref) && "memoryDependencyIds" in ref) {
      if (row.role !== "assistant" || metadata !== null) return null;
      const parsed = turnMemoryDependencyMetadata(ref);
      if (!parsed) return null;
      metadata = parsed.memoryDependencyIds;
    }
  }
  return metadata ?? [];
}

type BackupHistoryRow = Record<string, unknown>;

function canSupplyBackupMemory(row: BackupHistoryRow, now: number): boolean {
  if (row.status !== "active" || row.course_id != null) return false;
  if (row.kind === "confirmed") return true;
  if (row.kind !== "temporary") return false;
  const expires = row.expires_at;
  return (expires instanceof Date ? expires.getTime() : typeof expires === "string" ? Date.parse(expires) : NaN) > now;
}

/** Propagate broken lineage through both directions of the turn/memory dependency graph. */
export function unavailableBackupMemoryLineage(
  turns: readonly BackupHistoryRow[],
  memories: readonly BackupHistoryRow[],
  now: number,
  deletedMemoryIds?: ReadonlySet<string>,
): ReadonlySet<BackupHistoryRow> {
  const byId = (rows: readonly BackupHistoryRow[]) => new Map(
    rows.flatMap(row => isUuid(row.id) ? [[row.id.toLowerCase(), row] as const] : []),
  );
  const turnsById = byId(turns);
  const memoriesById = byId(memories.filter(row => isUuid(row.id)
    && !deletedMemoryIds?.has(row.id.toLowerCase()) && canSupplyBackupMemory(row, now)));
  const dependents = new Map<BackupHistoryRow, BackupHistoryRow[]>();
  const unavailable = new Set<BackupHistoryRow>();
  const link = (row: BackupHistoryRow, ids: string[] | null, targets: typeof turnsById) => {
    if (!ids) {
      unavailable.add(row);
      return;
    }
    for (const id of ids) {
      const target = targets.get(id.toLowerCase());
      if (!target) {
        unavailable.add(row);
        continue;
      }
      const users = dependents.get(target);
      if (users) users.push(row);
      else dependents.set(target, [row]);
    }
  };
  for (const turn of turns) link(turn, turnMemoryDependencyIds(turn), memoriesById);
  for (const memory of memories) {
    const sourceIds = parseUuidArray(memory.source_turn_ids);
    if (!isUuid(memory.id) || deletedMemoryIds?.has(memory.id.toLowerCase()) || memory.status === "deleted") {
      unavailable.add(memory);
    }
    link(memory, sourceIds?.length ? sourceIds : null, turnsById);
  }
  // Set iteration visits newly added rows once, even for a cycle.
  for (const row of unavailable) {
    for (const dependent of dependents.get(row) ?? []) unavailable.add(dependent);
  }
  return unavailable;
}

/** Note provenance can carry publication metadata alongside its versioned source refs. */
export function notePublicationMetadata(value: unknown) {
  if (!isRecord(value) || Object.keys(value).length !== 1) return null;
  if (Array.isArray(value.answerKeyBlockIds) && value.answerKeyBlockIds.every(isUuid)) {
    return { answerKeyBlockIds: value.answerKeyBlockIds.map(id => id.toLowerCase()) };
  }
  if (Array.isArray(value.publicationCardIds) && value.publicationCardIds.every(isUuid)) {
    return { publicationCardIds: value.publicationCardIds.map(id => id.toLowerCase()) };
  }
  return null;
}

const openingCitationRoles = new Set(["teach", "prompt", "example", "answer_key"]);
const openingCitationStatuses = new Set(["bound", "missing", "mismatch"]);

function isOpeningCitationBindingEnvelope(binding: Record<string, unknown>): boolean {
  return isUuid(binding.blockId)
    && typeof binding.role === "string" && openingCitationRoles.has(binding.role)
    && typeof binding.status === "string" && openingCitationStatuses.has(binding.status)
    && binding.factualSupport === "unverified";
}

/** Both the live projection and saved revision blocks persist compiler citation lineage here. */
export function libraryBlockSourceReferences(block: Record<string, unknown>): string[] | null {
  const binding = isRecord(block.content) ? block.content.citationBinding : undefined;
  if (!isRecord(binding) || !isOpeningCitationBindingEnvelope(binding)) return [];
  if (!Array.isArray(binding.refs)) return null;
  return parseCitations(binding.refs)?.map(id => id.toLowerCase()) ?? null;
}

export function libraryRevisionSourceReferences(blocks: unknown): string[] | null {
  if (!Array.isArray(blocks)) return null;
  const refs: string[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) return null;
    const ids = libraryBlockSourceReferences(block);
    if (!ids) return null;
    for (const id of ids) refs.push(id);
  }
  return refs;
}

function collectSourceIds(value: unknown, refs: Set<string>): boolean {
  if (Array.isArray(value)) return value.every((item) => collectSourceIds(item, refs));
  if (!isRecord(value)) return true;
  if (value.sourceId != null && !isUuid(value.sourceId)) return false;
  if (isUuid(value.sourceId)) refs.add(value.sourceId.toLowerCase());
  if (value.referenceSourceId != null && !isUuid(value.referenceSourceId)) return false;
  if (isUuid(value.referenceSourceId)) refs.add(value.referenceSourceId.toLowerCase());
  return Object.entries(value).every(([key, child]) => key === "sourceId" || collectSourceIds(child, refs));
}

function opaqueSourceIds(row: Record<string, unknown>): string[] | null {
  const refs = new Set<string>();
  for (const key of ["payload", "blocks", "accepted_blocks", "input_snapshot", "reference_check", "create_intent", "submitted_intent", "context_anchor", "release_intent", "receipt", "system_query"]) {
    if (row[key] !== undefined && !collectSourceIds(row[key], refs)) return null;
  }
  return [...refs];
}

/** Undefined optional lineage is allowed here; full row validation belongs to apply. */
export function sourceReferences(row: Record<string, unknown>, allowSourceFreeQuestion = false): string[] | null {
  const refs: string[] = [];
  if (row.asset_type === "source") {
    if (!isUuid(row.asset_id)) return null;
    refs.push(row.asset_id);
  }
  if (row.source_id !== undefined && !(allowSourceFreeQuestion && row.source_id === null)) {
    if (!isUuid(row.source_id)) return null;
    refs.push(row.source_id);
  }
  if (row.reference_source_id !== undefined && row.reference_source_id !== null) {
    if (!isUuid(row.reference_source_id)) return null;
    refs.push(row.reference_source_id);
  }
  if (row.reference_check !== undefined && row.reference_check !== null) {
    if (!isRecord(row.reference_check) || !isUuid(row.reference_check.referenceId)) return null;
    refs.push(row.reference_check.referenceId);
  }
  if (row.source_ids !== undefined) {
    const ids = parseUuidArray(row.source_ids);
    if (!ids) return null;
    refs.push(...ids);
  }
  if (row.citations !== undefined) {
    const cited = parseCitations(row.citations);
    if (!cited) return null;
    refs.push(...cited);
  }
  if (row.context_source_refs !== undefined && row.context_source_refs !== null) {
    if (!Array.isArray(row.context_source_refs)) return null;
    const context = parseCitations(row.context_source_refs);
    if (!context) return null;
    refs.push(...context);
  }
  if (row.source_versions !== undefined && row.source_versions !== null) {
    if (!isRecord(row.source_versions)
      || !Object.entries(row.source_versions).every(([key, value]) => isUuid(key)
        && typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) return null;
    refs.push(...Object.keys(row.source_versions));
  }
  const opaque = opaqueSourceIds(row);
  if (!opaque) return null;
  refs.push(...opaque);
  return refs.map((id) => id.toLowerCase());
}

export function noteProvenanceSourceReferences(row: Record<string, unknown>): string[] | null {
  if (!Array.isArray(row.context_source_refs)) return null;
  return sourceReferences({ ...row, context_source_refs: row.context_source_refs.filter(ref => !notePublicationMetadata(ref)) });
}

export function turnSourceReferences(row: Record<string, unknown>): string[] | null {
  if (row.context_source_refs === undefined || row.context_source_refs === null) {
    return sourceReferences(row);
  }
  if (!Array.isArray(row.context_source_refs)) return null;
  if (turnMemoryDependencyIds(row) === null) return null;
  return sourceReferences({
    ...row,
    context_source_refs: row.context_source_refs.filter(ref => !turnMemoryDependencyMetadata(ref)),
  });
}
