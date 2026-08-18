export type NativeBackupErrorCode =
  | "INCOMPATIBLE_SCHEMA"
  | "FILE_HASH_MISMATCH"
  | "ID_CONFLICT"
  | "VALIDATION";

export class NativeBackupError extends Error {
  readonly code: NativeBackupErrorCode;

  constructor(code: NativeBackupErrorCode, message: string) {
    super(message);
    this.name = "NativeBackupError";
    this.code = code;
  }
}
