import type { MemoryItem } from "@aistudy/contracts";

/**
 * Context selection gate. Candidate is never a fact; temporary expires;
 * only confirmed+active (or unexpired temporary) may enter model context.
 */
export function isMemoryEligible(item: MemoryItem, now: string): boolean {
  if (item.status !== "active") return false;
  if (item.kind === "candidate") return false;
  if (item.kind === "temporary") {
    if (item.expiresAt === null) return false;
    return Date.parse(item.expiresAt) > Date.parse(now);
  }
  return item.kind === "confirmed";
}

/** Active confirmed + unexpired temporary for tutor context. */
export function memoriesForContext(items: readonly MemoryItem[], now: string): MemoryItem[] {
  return items.filter((item) => isMemoryEligible(item, now));
}

/** Active candidates shown for review only — never as facts. */
export function memoriesForReview(items: readonly MemoryItem[]): MemoryItem[] {
  return items.filter((item) => item.kind === "candidate" && item.status === "active");
}

/** Card surface: why = source turns; when = createdAt. */
export function memoryCardMeta(item: MemoryItem): { why: string[]; when: string } {
  return { why: [...item.sourceTurnIds], when: item.createdAt };
}
