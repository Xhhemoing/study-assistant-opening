import {
  validateOpeningRestore,
  type OpeningBackup,
  type OpeningBackupObject,
  type OpeningDeletionMark,
} from "./backup-policy";
import { isUuid } from "./backup-validation";
import {
  validBackupTableSet,
  canonicalObject,
  clone,
  sameJournal,
  sourceMap, sourceVersionMap, sourceVersionKey,
  tableJournal,
  uniqueJournal,
  validHash,
  validSource,
} from "./backup-compose-validation";

export type OpeningBackupComposeRecords = {
  privacyEpoch: number;
  deletionJournal: OpeningDeletionMark[];
  tables: Record<string, Record<string, unknown>[]>;
};

export type OpeningBackupComposeStaging = {
  snapshot: {
    workspaceId: string;
    privacyEpoch: number;
    deletionJournal: OpeningDeletionMark[];
    sources: Array<{ sourceId: string; version: number; bytes: number; sha256: string }>;
  };
  objects: OpeningBackupObject[];
  unavailableSources?: Array<{ sourceId: string; version: number }>;
};

export type OpeningBackupComposeInput = {
  records: OpeningBackupComposeRecords;
  staging: OpeningBackupComposeStaging;
};

type ComposeFailureCode =
  | "INVALID_INPUT" | "EPOCH_MISMATCH" | "WORKSPACE_MISMATCH" | "JOURNAL_MISMATCH"
  | "OBJECT_MISMATCH" | "OBJECT_METADATA_MISMATCH" | "PREVIEW_REJECTED";

export type OpeningBackupComposeResult =
  | { ok: true; backup: OpeningBackup }
  | { ok: false; code: ComposeFailureCode; errors: string[] };

function fail(code: ComposeFailureCode, ...errors: string[]): OpeningBackupComposeResult {
  return { ok: false, code, errors };
}

function validInput(records: OpeningBackupComposeRecords, staging: OpeningBackupComposeStaging): boolean {
  return Number.isSafeInteger(records.privacyEpoch) && records.privacyEpoch >= 0
    && Number.isSafeInteger(staging.snapshot.privacyEpoch) && staging.snapshot.privacyEpoch >= 0
    && isUuid(staging.snapshot.workspaceId)
    && uniqueJournal(records.deletionJournal) && uniqueJournal(staging.snapshot.deletionJournal)
    && Object.values(records.tables).every((rows) => Array.isArray(rows)
      && rows.every((row) => row && typeof row === "object"))
    && Array.isArray(staging.snapshot.sources) && staging.snapshot.sources.every(validSource)
    && Array.isArray(staging.objects);
}



function validWorkspaceRows(
  tables: Record<string, Record<string, unknown>[]>,
  workspaceId: string,
): boolean {
  return Object.entries(tables).every(([name, rows]) => name === "opening_source_chunks"
    || rows.every((row) => isUuid(row.workspace_id) && row.workspace_id.toLowerCase() === workspaceId));
}

function validChunks(
  rows: Record<string, unknown>[],
  sources: Map<string, Record<string, unknown>>,
): boolean {
  return rows.every((row) => {
    const id = typeof row.source_id === "string" ? row.source_id.toLowerCase() : "";
    const version = row.source_version;
    return isUuid(row.source_id) && Number.isSafeInteger(version) && (version as number) >= 0
      && sources.has(sourceVersionKey(id, version as number));
  });
}

function matchSources(
  rows: Map<string, Record<string, unknown>>,
  staged: OpeningBackupComposeStaging["snapshot"]["sources"],
): boolean {
  const stagedMap = new Map(staged.map((source) => [sourceVersionKey(source.sourceId, source.version), source]));
  if (stagedMap.size !== staged.length || stagedMap.size !== rows.size) return false;
  return [...stagedMap].every(([id, source]) => {
    const row = rows.get(id);
    return !!row && row.version === source.version && row.bytes === source.bytes
      && String(row.sha256).toLowerCase() === source.sha256.toLowerCase();
  });
}

function buildObjects(
  staged: OpeningBackupComposeStaging["snapshot"]["sources"],
  objects: OpeningBackupObject[],
): { ok: true; objects: OpeningBackupObject[] } | { ok: false; code: ComposeFailureCode } {
  const sources = new Map(staged.map((source) => [sourceVersionKey(source.sourceId, source.version), source]));
  const result = new Map<string, OpeningBackupObject>();
  for (const object of objects) {
    const id = object.archivePath;
    const source = [...sources.values()].find(row => `objects/${row.sourceId.toLowerCase()}/v${row.version}.bin` === id);
    if (!isUuid(object.sourceId) || result.has(id)) return { ok: false, code: "OBJECT_MISMATCH" };
    if (!source) return { ok: false, code: [...sources.values()].some(row => row.sourceId.toLowerCase() === object.sourceId.toLowerCase()) ? "OBJECT_METADATA_MISMATCH" : "OBJECT_MISMATCH" };
    if (object.sourceId.toLowerCase() !== source.sourceId.toLowerCase()) return { ok: false, code: "OBJECT_MISMATCH" };
    const expectedPath = `objects/${source.sourceId.toLowerCase()}/v${source.version}.bin`;
    if (!validHash(object.sha256) || !validHash(object.actualSha256) || object.archivePath !== expectedPath
      || object.bytes !== source.bytes || object.sha256.toLowerCase() !== source.sha256.toLowerCase()
      || object.actualSha256.toLowerCase() !== object.sha256.toLowerCase()) {
      return { ok: false, code: "OBJECT_METADATA_MISMATCH" };
    }
    result.set(id, canonicalObject(source, object));
  }
  return result.size === sources.size
    ? { ok: true, objects: [...result.values()] }
    : { ok: false, code: "OBJECT_MISMATCH" };
}

export function composeOpeningBackupDraft(input: OpeningBackupComposeInput): OpeningBackupComposeResult {
  if (!input?.records || !input.staging?.snapshot || !validInput(input.records, input.staging)) {
    return fail("INVALID_INPUT");
  }
  const { records, staging } = input;
  if (records.privacyEpoch !== staging.snapshot.privacyEpoch) return fail("EPOCH_MISMATCH");
  const workspaceId = staging.snapshot.workspaceId.toLowerCase();
  if (!validBackupTableSet(records.tables)) return fail("INVALID_INPUT");
  const sourceRows = records.tables.opening_sources ?? [];
  const chunkRows = records.tables.opening_source_chunks ?? [];
  const sources = sourceMap(sourceRows);
  if (!sources) return fail("INVALID_INPUT");
  if ([...sources.values()].some((row) => typeof row.workspace_id !== "string"
      || row.workspace_id.toLowerCase() !== workspaceId)
    || !validWorkspaceRows(records.tables, workspaceId)) return fail("WORKSPACE_MISMATCH");
  const versions = sourceVersionMap(sources, records.tables.opening_source_versions ?? []);
  if (!versions) return fail("OBJECT_METADATA_MISMATCH");
  if (!validChunks(chunkRows, versions)) return fail("OBJECT_METADATA_MISMATCH");
  const exclusions = tableJournal(records.tables);
  if (!exclusions || !sameJournal(records.deletionJournal, staging.snapshot.deletionJournal)
    || !sameJournal(records.deletionJournal, exclusions)) return fail("JOURNAL_MISMATCH");
  const available = new Map([...versions].filter(([, row]) => row.availability === "available"));
  if (!matchSources(available, staging.snapshot.sources)) return fail("OBJECT_METADATA_MISMATCH");
  const currentVersions = new Set([...sources].map(([id,row]) => sourceVersionKey(id,row.version as number)));
  const unavailable = new Set<string>();
  for (const missing of staging.unavailableSources ?? []) {
    const key = sourceVersionKey(missing.sourceId, missing.version);
    if (currentVersions.has(key) || !available.has(key) || unavailable.has(key)) return fail("OBJECT_MISMATCH");
    unavailable.add(key);
  }
  const objectResult = buildObjects(staging.snapshot.sources.filter(source => !unavailable.has(sourceVersionKey(source.sourceId, source.version))), staging.objects);
  if (!objectResult.ok) return fail(objectResult.code);
  const backup: OpeningBackup = {
    format: "opening-backup", version: 1, workspaceId,
    privacyEpoch: records.privacyEpoch,
    deletionJournal: clone(records.deletionJournal),
    tables: clone(records.tables), objects: objectResult.objects,
  };
  if (unavailable.size) backup.tables.opening_source_versions = [...versions].map(([key, row]) => ({
    source_id: row.source_id, version: row.version, workspace_id: row.workspace_id, bytes: row.bytes,
    sha256: row.sha256, availability: unavailable.has(key) ? "unavailable" : row.availability,
  }));
  const preview = validateOpeningRestore(backup, staging.snapshot.deletionJournal);
  return preview.allowed ? { ok: true, backup } : fail("PREVIEW_REJECTED", ...preview.errors);
}
