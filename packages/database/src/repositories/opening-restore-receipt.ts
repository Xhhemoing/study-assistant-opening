import type { OpeningRestoreObjectSideEffects } from "./opening-backup-apply";

/** Shared by the CLI: unknown is deliberately not rendered as no mutation. */
export function formatOpeningRestoreObjectSideEffects(receipt: OpeningRestoreObjectSideEffects | undefined): string {
  if (!receipt) return "";
  return `  objectSideEffects.status=${receipt.status}\n`
    + `  objectSideEffects.createdKeys=${JSON.stringify(receipt.createdKeys)}\n`
    + `  objectSideEffects.remainingKeys=${JSON.stringify(receipt.remainingKeys)}\n`
    + `  objectSideEffects.unknownKeys=${JSON.stringify(receipt.unknownKeys)}\n`;
}
