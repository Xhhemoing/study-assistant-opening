import type { WorkspaceEntry } from "@aistudy/ui";

const preferenceKey = "aistudy.default-entry";

export type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function keyFor(userId: string): string {
  return `${preferenceKey}.${userId}`;
}

export function readDefaultEntry(
  storage: PreferenceStorage,
  userId: string,
): WorkspaceEntry | null {
  const value = storage.getItem(keyFor(userId));
  return value === "learn" || value === "explore" || value === "library"
    ? value
    : null;
}

export function writeDefaultEntry(
  storage: PreferenceStorage,
  userId: string,
  entry: WorkspaceEntry,
): void {
  storage.setItem(keyFor(userId), entry);
}