import { randomUUID } from "node:crypto";
import { link, open, rm, type FileHandle } from "node:fs/promises";

/** The complete destination exists; callers must not retry or remove it as a failed output. */
export class OpeningBackupPublishedError extends Error {
  readonly published = true;
  constructor(readonly destination: string, readonly temporaryPath: string, cause: unknown) {
    super("backup output published but temporary cleanup failed", { cause });
    this.name = "OpeningBackupPublishedError";
  }
}

/** This attempt did not publish, but its owned temporary file could not be removed. */
export class OpeningBackupUnpublishedCleanupError extends Error {
  readonly published = false;
  constructor(
    readonly destination: string,
    readonly temporaryPath: string,
    readonly cleanupError: unknown,
    cause: unknown,
  ) {
    super("backup output not published and temporary cleanup failed", { cause });
    this.name = "OpeningBackupUnpublishedCleanupError";
  }
}
/** Same-volume, complete-file publication. Unsupported hard links fail closed; no overwrite fallback. */
export async function writeExclusiveOpeningBackupFile(
  destination: string,
  existsMessage: string,
  write: (handle: FileHandle) => Promise<void>,
): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  // A failed wx open conveys no ownership: never unlink that path in this case.
  const handle = await open(temporary, "wx", 0o600);
  try {
    try { await write(handle); } finally { await handle.close(); }
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(existsMessage, { cause: error });
      throw error;
    }
  } catch (error) {
    try { await rm(temporary, { force: true }); } catch (cleanupError) {
      throw new OpeningBackupUnpublishedCleanupError(destination, temporary, cleanupError, error);
    }
    throw error;
  }
  // Publication already succeeded. Never enter pre-publication cleanup or remove the destination.
  try { await rm(temporary); } catch (error) {
    throw new OpeningBackupPublishedError(destination, temporary, error);
  }
}
