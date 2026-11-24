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
  const scopeByEdgeId = new Map<string, string>();
  for (const row of rows) {
    if (!isUuid(row.revision_id) || !isUuid(row.edge_id) || !isUuid(row.workspace_id) || !isUuid(row.owner_user_id)) return null;
    if (row.course_id != null && !isUuid(row.course_id)) return null;
    const id = row.revision_id.toLowerCase();
    if (byId.has(id)) return null;
    const edgeId = row.edge_id.toLowerCase();
    const scope = `${row.workspace_id.toLowerCase()}/${row.owner_user_id.toLowerCase()}/${row.course_id?.toLowerCase() ?? ""}`;
    const previousScope = scopeByEdgeId.get(edgeId);
    if (previousScope !== undefined && previousScope !== scope) return null;
    scopeByEdgeId.set(edgeId, scope);
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

// PostgreSQL ISO output uses a space and a numeric offset. Retain microseconds
// so an adjacent pair of bounds within one millisecond remains distinguishable.
const firstFiniteTimestamp = -211813488000000000n;
const pastLastFiniteTimestamp = 9223371331200000000n;

function archiveTimestampMicros(value: string): bigint | null {
  const parts = /^(\d{4,6})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2})(?::(\d{2})(?::(\d{2}))?)?)( BC)?$/.exec(value);
  if (!parts) return null;
  const [, year, month, day, hour, minute, second, fraction = "", , sign,
    zoneHour = "0", zoneMinute = "0", zoneSecond = "0", bc] = parts;
  if (Number(year) === 0 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || Number(zoneHour) > 15 || Number(zoneMinute) > 59 || Number(zoneSecond) > 59) return null;

  // Map to a Gregorian 400-year cycle within Date's range, even for PostgreSQL's extended years.
  const astronomicalYear = bc ? 1 - Number(year) : Number(year);
  const cycles = Math.floor((astronomicalYear - 2000) / 400);
  const cycleYear = astronomicalYear - cycles * 400;
  const date = new Date(Date.UTC(cycleYear, Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second)));
  if (date.getUTCFullYear() !== cycleYear || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day)) return null;
  const offsetSeconds = (sign === "-" ? -1 : 1) * (Number(zoneHour) * 3600 + Number(zoneMinute) * 60 + Number(zoneSecond));
  const micros = (BigInt(date.getTime() - Date.UTC(2000, 0, 1)) + BigInt(cycles) * 146097n * 86400000n
    - BigInt(offsetSeconds) * 1000n) * 1000n + BigInt(fraction.padEnd(6, "0"));
  // Finite PostgreSQL timestamps are measured from 2000-01-01 UTC.
  return micros >= firstFiniteTimestamp && micros < pastLastFiniteTimestamp ? micros : null;
}

type MisconceptionRange = { lower: bigint; upper: bigint };
type MisconceptionSlice = { valid: MisconceptionRange; tx: MisconceptionRange };

function parseMisconceptionRange(value: unknown, allowExplicitInfinity: boolean): MisconceptionRange | null {
  if (typeof value !== "string") return null;
  const bounds = /^\[("[^"]+"|[^",]+),("[^"]+"|[^",]+)?\)$/.exec(value);
  if (!bounds) return null;
  const lowerText = bounds[1]!.replace(/^"|"$/g, "");
  const upperText = bounds[2]?.replace(/^"|"$/g, "");
  const lower = lowerText === "-infinity" ? firstFiniteTimestamp - 1n : archiveTimestampMicros(lowerText);
  // For supported lower bounds, an exclusive +infinity and an unbounded upper overlap the same ranges.
  const upper = upperText === undefined || (allowExplicitInfinity && upperText === "infinity")
    ? pastLastFiniteTimestamp : archiveTimestampMicros(upperText);
  return lower !== null && upper !== null && lower < upper ? { lower, upper } : null;
}

function compareMicros(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Sweep transaction time and count active valid-time endpoints with prefix sums. */
function hasOverlappingMisconceptionSlices(slices: MisconceptionSlice[]): boolean {
  if (slices.length < 2) return false;
  const bounds = [...new Set(slices.flatMap(({ valid }) => [valid.lower, valid.upper]))].sort(compareMicros);
  const ranks = new Map(bounds.map((bound, index) => [bound, index + 1]));
  const lowerCounts = new Int32Array(bounds.length + 1);
  const upperCounts = new Int32Array(bounds.length + 1);
  const add = (counts: Int32Array, rank: number, delta: number) => {
    for (let i = rank; i < counts.length; i += i & -i) counts[i] = counts[i]! + delta;
  };
  const countThrough = (counts: Int32Array, rank: number) => {
    let count = 0;
    for (let i = rank; i > 0; i -= i & -i) count += counts[i]!;
    return count;
  };
  const ending = [...slices].sort((a, b) => compareMicros(a.tx.upper, b.tx.upper));
  let ended = 0;
  for (const slice of slices.sort((a, b) => compareMicros(a.tx.lower, b.tx.lower))) {
    // End events precede start events at the same instant for half-open ranges.
    while (ended < ending.length && ending[ended]!.tx.upper <= slice.tx.lower) {
      const expired = ending[ended++]!.valid;
      add(lowerCounts, ranks.get(expired.lower)!, -1);
      add(upperCounts, ranks.get(expired.upper)!, -1);
    }
    const lowerRank = ranks.get(slice.valid.lower)!, upperRank = ranks.get(slice.valid.upper)!;
    if (countThrough(lowerCounts, upperRank - 1) > countThrough(upperCounts, lowerRank)) return true;
    add(lowerCounts, lowerRank, 1);
    add(upperCounts, upperRank, 1);
  }
  return false;
}

export function validateBackupMisconceptionRevisions(
  tables: Record<string, Record<string, unknown>[]>,
  archivePrivacyEpoch: number,
): string[] {
  const rows = tables.v3_bitemporal_misconception_edges ?? [];
  if (!rows.length) return [];
  const attemptIds = new Set((tables.opening_learning_attempts ?? []).map(row => row.id).filter(isUuid).map(id => id.toLowerCase()));
  const courseIds = new Set((tables.courses ?? []).map(row => row.id).filter(isUuid).map(id => id.toLowerCase()));
  const errors = new Set<string>();
  const txByRevision = new Map<string, MisconceptionRange>();
  const slicesByEdge = new Map<string, MisconceptionSlice[]>();
  let workspaceOwner: string | undefined;
  for (const row of rows) {
    if (isUuid(row.owner_user_id)) {
      const owner = row.owner_user_id.toLowerCase();
      workspaceOwner ??= owner;
      if (owner !== workspaceOwner) errors.add("misconception revisions have conflicting workspace owners");
    }
    for (const column of ["concept_key", "misconception_code", "summary"]) {
      const value = row[column];
      // Unicode matching preserves valid surrogate pairs while rejecting lone surrogates.
      if (typeof value !== "string" || value.includes("\u0000") || /[\uD800-\uDFFF]/u.test(value)) {
        errors.add(`misconception revision has invalid ${column}`);
      }
    }
    const valid = parseMisconceptionRange(row.valid_range, true);
    const tx = parseMisconceptionRange(row.tx_range, false);
    if (!valid) errors.add("misconception revision has invalid valid_range");
    if (!tx) errors.add("misconception revision has invalid tx_range");
    if (tx && isUuid(row.revision_id)) txByRevision.set(row.revision_id.toLowerCase(), tx);
    if (valid && tx && isUuid(row.edge_id)) {
      const edgeId = row.edge_id.toLowerCase();
      const slices = slicesByEdge.get(edgeId);
      if (slices) slices.push({ valid, tx });
      else slicesByEdge.set(edgeId, [{ valid, tx }]);
    }
    if (row.privacy_epoch !== archivePrivacyEpoch) {
      errors.add("misconception revision privacy epoch does not match the archive epoch");
    }
    const evidence = uuidList(row.evidence_attempt_ids) ? row.evidence_attempt_ids : null;
    if (!evidence || evidence.some(id => !attemptIds.has(id.toLowerCase()))) {
      errors.add("misconception revision references invalid or missing archived attempts");
    }
    if (row.course_id != null && (!isUuid(row.course_id) || !courseIds.has(row.course_id.toLowerCase()))) {
      errors.add("misconception revision references an invalid or missing archived course");
    }
    const { status, origin, learner_disposition: disposition, prior_revision_id: prior } = row;
    switch (origin) {
      case "public_try_handoff":
        if (status !== "candidate" || prior != null || row.course_id != null || disposition != null
          || !evidence || evidence.length !== 0) errors.add("invalid public try misconception revision");
        break;
      case "system_diagnosis":
        if (disposition != null || (status !== "candidate" && status !== "verified" && status !== "retracted"
          && status !== "superseded")) errors.add("invalid system misconception revision");
        break;
      case "learner_correction":
        if (status !== "learner_reported" || !isUuid(prior)
          || (disposition !== "disputed" && disposition !== "clarified" && disposition !== "resolved_self_report")) {
          errors.add("invalid learner misconception revision");
        }
        break;
      default:
        errors.add("invalid misconception revision origin");
    }
  }
  for (const row of rows) {
    if (!isUuid(row.revision_id) || !isUuid(row.prior_revision_id)) continue;
    const child = txByRevision.get(row.revision_id.toLowerCase());
    const parent = txByRevision.get(row.prior_revision_id.toLowerCase());
    if (child && parent && (parent.upper === pastLastFiniteTimestamp || child.lower < parent.upper)) {
      errors.add("misconception revision precedes the closure of its predecessor");
      break;
    }
  }
  for (const slices of slicesByEdge.values()) {
    if (hasOverlappingMisconceptionSlices(slices)) {
      errors.add("misconception revisions overlap in valid and transaction time");
      break;
    }
  }
  return [...errors];
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

export function canSupplyBackupMemory(row: BackupHistoryRow, now: number): boolean {
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
  if (Array.isArray(value.originTurnIds) && value.originTurnIds.length === 1 && value.originTurnIds.every(isUuid)) {
    return { originTurnIds: value.originTurnIds.map(id => id.toLowerCase()) };
  }
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
  const refs: unknown[] = [];
  for (const ref of row.context_source_refs) {
    if (notePublicationMetadata(ref)) continue;
    if (isRecord(ref) && "memoryDependencyIds" in ref) {
      if (!turnMemoryDependencyMetadata(ref)) return null;
    } else refs.push(ref);
  }
  return sourceReferences({ ...row, context_source_refs: refs });
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
