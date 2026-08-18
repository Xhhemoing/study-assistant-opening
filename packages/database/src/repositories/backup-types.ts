import type {
  BackupConflictPolicy,
  BackupRestoreResponse,
  NativeBackupPackage,
} from "@aistudy/contracts";

export type BackupRestoreErrorCode =
  | "NOT_FOUND"
  | "WORKSPACE_MISMATCH"
  | "CONFLICT"
  | "VALIDATION"
  | "INCOMPATIBLE_SCHEMA"
  | "FILE_HASH_MISMATCH";

export class BackupRestoreError extends Error {
  readonly code: BackupRestoreErrorCode;

  constructor(code: BackupRestoreErrorCode, message: string) {
    super(message);
    this.name = "BackupRestoreError";
    this.code = code;
  }
}

export type BackupRestoreRepository = {
  exportWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
  }): Promise<NativeBackupPackage>;
  restoreWorkspace(input: {
    workspaceId: string;
    ownerUserId: string;
    packed: NativeBackupPackage;
    conflictPolicy: BackupConflictPolicy;
  }): Promise<BackupRestoreResponse>;
};
