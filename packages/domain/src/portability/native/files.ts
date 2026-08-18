import { createHash } from "node:crypto";
import type { BackupFileManifestEntry } from "@aistudy/contracts";
import { NativeBackupError } from "./errors";
import type { NativeBackupFileInput } from "./types";

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function packFiles(files: NativeBackupFileInput[]): BackupFileManifestEntry[] {
  return files.map((file) => ({
    path: file.path,
    mediaType: file.mediaType,
    sha256: sha256Hex(file.bytes),
    byteLength: file.bytes.byteLength,
    bytesBase64: Buffer.from(file.bytes).toString("base64"),
  }));
}

export function assertFileHashes(files: BackupFileManifestEntry[]): void {
  for (const file of files) {
    if (file.bytesBase64 === undefined) continue;
    const actual = sha256Hex(Uint8Array.from(Buffer.from(file.bytesBase64, "base64")));
    if (actual !== file.sha256) {
      throw new NativeBackupError(
        "FILE_HASH_MISMATCH",
        `File sha256 mismatch for ${file.path}`,
      );
    }
  }
}
