// Structural preflight only; this is not a database row schema or an archive reader.
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

export function isJournal(value: unknown): value is Array<{ sourceId: string; deletedAt: string }> {
  return Array.isArray(value) && value.every((mark) => isRecord(mark)
    && isUuid(mark.sourceId) && typeof mark.deletedAt === "string"
    && /^\d{4}-\d{2}-\d{2}T/.test(mark.deletedAt) && Number.isFinite(Date.parse(mark.deletedAt)));
}

export function isTables(value: unknown): value is Record<string, Record<string, unknown>[]> {
  return isRecord(value) && Object.values(value).every((rows) => Array.isArray(rows) && rows.every(isRecord));
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
      || !Number.isSafeInteger(citation.sourceVersion) || citation.sourceVersion < 0) return null;
    refs.push(citation.sourceId);
  }
  return refs;
}

function collectSourceIds(value: unknown, refs: Set<string>): boolean {
  if (Array.isArray(value)) return value.every((item) => collectSourceIds(item, refs));
  if (!isRecord(value)) return true;
  if ("sourceId" in value && !isUuid(value.sourceId)) return false;
  if (isUuid(value.sourceId)) refs.add(value.sourceId.toLowerCase());
  return Object.entries(value).every(([key, child]) => key === "sourceId" || collectSourceIds(child, refs));
}

function opaqueSourceIds(row: Record<string, unknown>): string[] | null {
  const refs = new Set<string>();
  for (const key of ["payload", "blocks", "accepted_blocks", "input_snapshot"]) {
    if (row[key] !== undefined && !collectSourceIds(row[key], refs)) return null;
  }
  return [...refs];
}

/** Undefined optional lineage is allowed here; full row validation belongs to apply. */
export function sourceReferences(row: Record<string, unknown>): string[] | null {
  const refs: string[] = [];
  if (row.source_id !== undefined) {
    if (!isUuid(row.source_id)) return null;
    refs.push(row.source_id);
  }
  if (row.reference_source_id !== undefined && row.reference_source_id !== null) {
    if (!isUuid(row.reference_source_id)) return null;
    refs.push(row.reference_source_id);
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
  if (row.source_versions !== undefined) {
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
