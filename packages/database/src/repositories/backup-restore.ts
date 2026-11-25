import { uuidSchema, type NativeBackupPackage } from "@aistudy/contracts";
import { findForbiddenBackupTable } from "../../../contracts/src/opening/backup-inventory";
import { BackupRestoreError } from "./backup-types";
import { assertNativeCardRestorePrivacy, assertNativeNoteRestorePrivacy, readNoteBackupProvenance, retainNativeRestoreProvenance } from "./native-note-privacy";
import type { Sql } from "postgres";
import { listMigrationFiles } from "../migrate";
import { assertFileHashes, planNativeRestore } from "@aistudy/domain/native";
import { dumpWorkspaceSnapshot, snapshotToPackage, assertBackupWorkspaceOwner } from "./backup-dump";
import { applyRestorePlan, loadExistingIds } from "./backup-insert";
import { asRecords, wrapBackupError } from "./backup-map";
import type { BackupRestoreRepository } from "./backup-types";
import { privateExamDocumentIds, readBackupLibrarySourceVersions, readBackupNoteProvenance, readBackupTeachingSourceRefs } from "./opening-backup-library";
import { projectNativeBackupLibrary } from "./backup-native-library";
import { attachNativeCardPublicationSources, attachNativeTeachingOrigins, readNativeTeachingOrigins } from "./native-backup-teaching";
import { isVerifiedSnippetLineage, noteOriginTurnIds, parseNoteContextProvenanceRefs } from "./opening-context-provenance";
import { historicalTeachingDocumentsByCard, parseBackupSourceRefs, publicationAnswerKeysByDocument, publicationSourceRefsByDocument, type BackupSourceRef } from "./backup-publication-provenance";

const lowerUuid = (value: unknown): unknown =>
  typeof value === "string" && uuidSchema.safeParse(value).success ? value.toLowerCase() : value;

function normalizeRecordUuids(
  row: unknown,
  keys: readonly string[],
  arrayKeys: readonly string[] = [],
  nested?: Record<string, { keys: readonly string[]; arrayKeys?: readonly string[] }>,
): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return row;
  const next: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const key of keys) {
    if (key in next) next[key] = lowerUuid(next[key]);
  }
  for (const key of arrayKeys) {
    if (Array.isArray(next[key])) next[key] = (next[key] as unknown[]).map(lowerUuid);
  }
  if (nested) {
    for (const [key, spec] of Object.entries(nested)) {
      if (Array.isArray(next[key])) {
        next[key] = (next[key] as unknown[]).map(child =>
          normalizeRecordUuids(child, spec.keys, spec.arrayKeys ?? []),
        );
      }
    }
  }
  return next;
}

function normalizeNativeBackupPackageUuids(packed: NativeBackupPackage): NativeBackupPackage {
  const { records } = packed;
  return {
    ...packed,
    sourceWorkspaceId: String(lowerUuid(packed.sourceWorkspaceId)),
    records: {
      workspace: normalizeRecordUuids(records.workspace, ["id", "ownerUserId"]) as Record<string, unknown>,
      courses: records.courses.map(row => normalizeRecordUuids(row, ["id", "workspaceId"]) as Record<string, unknown>),
      documents: records.documents.map(row => normalizeRecordUuids(row, ["id", "workspaceId"], [], {
        learningAssetLinks: {
          keys: ["id", "workspace_id", "owner_user_id", "asset_id", "course_id", "goal_id", "requirement_id"],
        },
      }) as Record<string, unknown>),
      blocks: records.blocks.map(row => normalizeRecordUuids(row, ["id", "workspaceId", "documentId"]) as Record<string, unknown>),
      revisions: records.revisions.map(row => normalizeRecordUuids(row, ["id", "workspaceId", "documentId"], [], {
        blocks: { keys: ["id"] },
      }) as Record<string, unknown>),
      relations: records.relations.map(row => normalizeRecordUuids(row, ["id", "workspaceId", "fromId", "toId"]) as Record<string, unknown>),
      memberships: records.memberships.map(row => normalizeRecordUuids(row, ["id", "workspaceId", "courseId", "assetId"]) as Record<string, unknown>),
      goals: records.goals.map(row => normalizeRecordUuids(row, ["id", "workspaceId", "courseId"], ["courseIds"]) as Record<string, unknown>),
      windows: records.windows.map(row => normalizeRecordUuids(row, ["id", "workspaceId", "goalId"]) as Record<string, unknown>),
      explorations: records.explorations.map(row => normalizeRecordUuids(
        row,
        ["id", "workspaceId", "ownerUserId", "courseId", "goalId"],
        [],
        {
          branches: { keys: ["id", "workspaceId", "explorationId", "parentBranchId"] },
          blocks: { keys: ["id", "workspaceId", "explorationId", "branchId"] },
        },
      ) as Record<string, unknown>),
      promotions: records.promotions.map(row => normalizeRecordUuids(
        row,
        ["id", "workspaceId", "explorationId", "sourceTurnId", "targetId"],
        [],
        {
          targets: { keys: ["id", "workspaceId", "promotionId", "explorationId", "sourceTurnId", "targetId"] },
        },
      ) as Record<string, unknown>),
      cards: records.cards.map(row => normalizeRecordUuids(
        row,
        ["id", "workspaceId", "ownerUserId", "sourceDocumentId", "syllabusPointId", "courseId", "originObservationRootId"],
        ["sourceIds", "originTeachingDocumentIds"],
        {
          reviewStates: { keys: ["id", "ownerUserId", "cardId", "workspaceId"] },
        },
      ) as Record<string, unknown>),
      events: records.events.map(row => normalizeRecordUuids(
        row,
        ["id", "workspaceId", "ownerUserId", "contentId", "syllabusPointId", "correctsEventId"],
      ) as Record<string, unknown>),
    },
  };
}

// This entrypoint is also re-exported by the database package's public barrel.
export { BACKUP_FORBIDDEN_TABLES, EXPLICIT_NON_EXPORTED_WORKSPACE_TABLES } from "./opening-backup-empty-namespace";
export {
  BackupRestoreError,
  type BackupRestoreErrorCode,
  type BackupRestoreRepository,
} from "./backup-types";

export function createBackupRestoreRepository(sql: Sql): BackupRestoreRepository {
  return {
    async exportWorkspace(input) {
      // Native privacy writers share this owner lock. A read-only transaction cannot take it.
      return sql.begin("isolation level repeatable read", async tx => {
        await tx`SELECT id FROM workspaces WHERE id=${input.workspaceId} AND owner_user_id=${input.ownerUserId} FOR UPDATE`;
        const snapshot = await dumpWorkspaceSnapshot(tx as unknown as Sql, input.workspaceId, input.ownerUserId);
        return snapshotToPackage(snapshot);
      });
    },

    async restoreWorkspace(input) {
      const workspaceId = String(lowerUuid(input.workspaceId));
      const ownerUserId = String(lowerUuid(input.ownerUserId));
      const normalizedPacked = normalizeNativeBackupPackageUuids(input.packed);
      const forbidden = findForbiddenBackupTable(normalizedPacked);
      if (forbidden) throw new BackupRestoreError("VALIDATION", `Forbidden backup table: ${forbidden}`);
      await assertBackupWorkspaceOwner(sql, workspaceId, ownerUserId);
      try {
        const compatibleMigrationIds = await listMigrationFiles();
        return await sql.begin(async (tx) => {
          await tx`SELECT id FROM workspaces WHERE id=${workspaceId} AND owner_user_id=${ownerUserId} FOR UPDATE`;
          await assertBackupWorkspaceOwner(tx as unknown as Sql, workspaceId, ownerUserId);
          const privateExams = await privateExamDocumentIds(tx, workspaceId);
          const sameWorkspace = normalizedPacked.sourceWorkspaceId.toLowerCase() === workspaceId.toLowerCase();
          const [noteProvenance, sourceVersions, teachingSpecs, origins] = await Promise.all([
            readBackupNoteProvenance(tx, workspaceId),
            sameWorkspace ? readBackupLibrarySourceVersions(tx, workspaceId) : undefined,
            readBackupTeachingSourceRefs(tx, workspaceId),
            sameWorkspace ? readNativeTeachingOrigins(tx, workspaceId, normalizedPacked.records.cards, privateExams) : undefined,
          ]);
          const inputRecords = normalizedPacked.records;
          const cards = origins ? attachNativeTeachingOrigins(inputRecords.cards, origins, historicalTeachingDocumentsByCard(noteProvenance)) : inputRecords.cards;
          const modernNotes = Number.parseInt(normalizedPacked.schemaManifest.latestMigrationId.slice(0, 4), 10) >= 35;
          const answerKeys = publicationAnswerKeysByDocument(teachingSpecs, noteProvenance);
          const existingNoteRows = new Map(noteProvenance.map(row => [String(row.document_id).toLowerCase(), row.context_source_refs]));
          const incomingNotes = new Map(asRecords(inputRecords.documents).map(document => [document.id.toLowerCase(), readNoteBackupProvenance(document, false)]));
          const privateBlocks = [...[...answerKeys.values()].flat(), ...[...incomingNotes.values()].flatMap(note => note?.answerKeyBlockIds ?? [])];
          const currentSpecs = sameWorkspace ? teachingSpecs : [];
          const library = projectNativeBackupLibrary({ ...inputRecords, cards }, privateExams, privateBlocks,
            new Set(sourceVersions?.keys()), currentSpecs, origins);
          const files = normalizedPacked.files.filter(file => library.fileAllowed(file.path));
          if (files.length !== normalizedPacked.files.length) assertFileHashes(normalizedPacked.files);
          // Older archives only carried the document IDs. Resolve their provenance before the
          // insert so it survives even when the destination has no teaching spec.
          const currentPublications = publicationSourceRefsByDocument(currentSpecs, sourceVersions ?? new Map());
          const publications: Map<string, BackupSourceRef[]> = new Map(currentPublications);
          for (const row of noteProvenance) {
            const id = String(row.document_id).toLowerCase();
            const refs = parseBackupSourceRefs(row.context_source_refs)?.filter(ref => ref.publication) ?? [];
            if (refs.length) publications.set(id, [...(publications.get(id) ?? []), ...refs]);
          }
          const documents = library.records.documents.map(document => {
            const id = String(document.id).toLowerCase();
            const note = incomingNotes.get(id);
            const existingRaw = sameWorkspace ? existingNoteRows.get(id) : undefined;
            const currentRefs = currentPublications.get(id) ?? [];
            const refs = parseBackupSourceRefs([...(note?.contextSourceRefs ?? []), ...currentRefs])!;
            if (refs.length) publications.set(id, [...(publications.get(id) ?? []), ...refs.filter(ref => ref.publication)]);
            const keys = [...new Set([...(note?.answerKeyBlockIds ?? []), ...(sameWorkspace ? answerKeys.get(id) ?? [] : [])])];
            if (!note) {
              if (existingRaw !== undefined || (modernNotes && !Object.hasOwn(document, "openingProvenance"))) {
                return document;
              }
              return refs.length || keys.length ? {
                ...document,
                openingProvenance: {
                  contextSourceRefs: refs,
                  ...(keys.length > 0 && { answerKeyBlockIds: keys }),
                },
              } : document;
            }
            const existingParsed = existingRaw !== undefined ? parseNoteContextProvenanceRefs(existingRaw) : null;
            const existingMemoryIds = existingParsed?.find(ref => "memoryDependencyIds" in ref)?.memoryDependencyIds ?? [];
            const memoryDependencyIds = [...new Set([...(note.memoryDependencyIds ?? []), ...existingMemoryIds])].sort();
            const existingOriginTurnIds = Array.isArray(existingRaw) ? noteOriginTurnIds(existingRaw) : [];
            const originTurnIds = [...new Set([...(note.originTurnIds ?? []), ...existingOriginTurnIds])].sort();
            const snippetLineageVersion = note.snippetLineageVersion === 1
              || (Array.isArray(existingRaw) && existingRaw.some(isVerifiedSnippetLineage))
              ? 1 as const
              : undefined;
            return {
              ...document,
              openingProvenance: {
                contextSourceRefs: refs,
                ...(keys.length > 0 && { answerKeyBlockIds: keys }),
                ...(memoryDependencyIds.length > 0 && { memoryDependencyIds }),
                ...(originTurnIds.length > 0 && { originTurnIds }),
                ...(snippetLineageVersion === 1 && { snippetLineageVersion: 1 as const }),
              },
            };
          });
          const restoredCards = attachNativeCardPublicationSources(library.records.cards, publications);
          const packed = { ...normalizedPacked, records: { ...inputRecords, ...library.records, documents, cards: restoredCards }, files };
          const existingIds = await loadExistingIds(tx as Sql, packed, workspaceId);
          const plan = planNativeRestore({
            packed,
            targetWorkspaceId: workspaceId,
            targetOwnerUserId: ownerUserId,
            existingIds,
            conflictPolicy: input.conflictPolicy,
            compatibleMigrationIds,
          });
          await assertNativeNoteRestorePrivacy(tx as unknown as Sql, workspaceId, packed);
          await assertNativeCardRestorePrivacy(tx as unknown as Sql, workspaceId, packed, existingIds);
          await applyRestorePlan(tx as Sql, plan);
          await retainNativeRestoreProvenance(tx as Sql, workspaceId, packed, existingIds);
          return {
            conflictPolicy: input.conflictPolicy,
            applied: plan.applied,
            skipped: plan.skipped,
            warnings: plan.warnings,
          };
        });
      } catch (error) {
        wrapBackupError(error);
      }
    },
  };
}
