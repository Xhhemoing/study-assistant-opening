import { z } from "zod";
import { lossEntrySchema } from "./portability";

export const NATIVE_BACKUP_FORMAT_VERSION = 1 as const;

export const backupConflictPolicySchema = z.enum(["reject", "skip"]);

export const backupSchemaManifestSchema = z.object({
  formatVersion: z.literal(NATIVE_BACKUP_FORMAT_VERSION),
  latestMigrationId: z.string().min(1),
  tables: z.array(z.string().min(1)).min(1),
  workspaceSchemaVersion: z.number().int().positive(),
});

export const backupIdentityCountsSchema = z.object({
  workspaces: z.number().int().nonnegative(),
  courses: z.number().int().nonnegative(),
  memberships: z.number().int().nonnegative(),
  goals: z.number().int().nonnegative(),
  windows: z.number().int().nonnegative(),
  documents: z.number().int().nonnegative(),
  blocks: z.number().int().nonnegative(),
  relations: z.number().int().nonnegative(),
  revisions: z.number().int().nonnegative(),
  explorations: z.number().int().nonnegative(),
  promotions: z.number().int().nonnegative(),
  cards: z.number().int().nonnegative(),
  events: z.number().int().nonnegative(),
  files: z.number().int().nonnegative(),
});

export const backupFileManifestEntrySchema = z.object({
  path: z.string().min(1),
  mediaType: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  byteLength: z.number().int().nonnegative(),
  bytesBase64: z.string().optional(),
});

const jsonRecordSchema = z.record(z.string(), z.unknown());

export const nativeBackupPackageSchema = z.object({
  format: z.literal("aistudy-native"),
  schemaManifest: backupSchemaManifestSchema,
  sourceWorkspaceId: z.string().uuid(),
  counts: backupIdentityCountsSchema,
  records: z.object({
    workspace: jsonRecordSchema,
    courses: z.array(jsonRecordSchema),
    memberships: z.array(jsonRecordSchema),
    goals: z.array(jsonRecordSchema),
    windows: z.array(jsonRecordSchema),
    documents: z.array(jsonRecordSchema),
    blocks: z.array(jsonRecordSchema),
    relations: z.array(jsonRecordSchema),
    revisions: z.array(jsonRecordSchema),
    explorations: z.array(jsonRecordSchema),
    promotions: z.array(jsonRecordSchema),
    cards: z.array(jsonRecordSchema),
    events: z.array(jsonRecordSchema),
  }),
  files: z.array(backupFileManifestEntrySchema),
});

export const backupExportRequestSchema = z.object({});

export const backupExportResponseSchema = z.object({
  format: z.literal("aistudy-native"),
  package: nativeBackupPackageSchema,
});

export const backupRestoreRequestSchema = z.object({
  conflictPolicy: backupConflictPolicySchema,
  package: nativeBackupPackageSchema,
});

export const backupRestoreResponseSchema = z.object({
  conflictPolicy: backupConflictPolicySchema,
  applied: backupIdentityCountsSchema,
  skipped: backupIdentityCountsSchema,
  warnings: z.array(lossEntrySchema),
});

export type BackupConflictPolicy = z.infer<typeof backupConflictPolicySchema>;
export type BackupSchemaManifest = z.infer<typeof backupSchemaManifestSchema>;
export type BackupIdentityCounts = z.infer<typeof backupIdentityCountsSchema>;
export type BackupFileManifestEntry = z.infer<typeof backupFileManifestEntrySchema>;
export type NativeBackupPackage = z.infer<typeof nativeBackupPackageSchema>;
export type BackupExportRequest = z.infer<typeof backupExportRequestSchema>;
export type BackupExportResponse = z.infer<typeof backupExportResponseSchema>;
export type BackupRestoreRequest = z.infer<typeof backupRestoreRequestSchema>;
export type BackupRestoreResponse = z.infer<typeof backupRestoreResponseSchema>;
