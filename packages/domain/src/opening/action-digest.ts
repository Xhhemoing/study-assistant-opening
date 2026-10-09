/**
 * P04 multisource action digest — pure projection.
 * Never auto-accepts. Rejected keys are never re-prompted. Primary ≤ 3;
 * pendingConfirmationCount is not truncated with the primary slice.
 */

export type DigestActionStatus = "pending" | "accepted" | "rejected" | "superseded";

/** Structural candidate for digest rules (API boundary still validates UUIDs). */
export type DigestActionCandidate = {
  id: string;
  dedupeKey: string;
  title: string;
  minutes: number;
  dueAt: string | null;
  priority: number;
  sourceIds: string[];
  status: DigestActionStatus;
  needsConfirmation: boolean;
};

export type ActionDigestView = {
  primary: DigestActionCandidate[];
  pendingConfirmationCount: number;
};

const PRIMARY_CAP = 3;

function dueRank(dueAt: string | null): number {
  if (dueAt == null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(dueAt);
  return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
}

/** dueAt ascending (null last), priority descending, id ascending. */
export function compareDigestCandidates(
  a: DigestActionCandidate,
  b: DigestActionCandidate,
): number {
  const dueA = dueRank(a.dueAt);
  const dueB = dueRank(b.dueAt);
  if (dueA !== dueB) return dueA < dueB ? -1 : 1;
  if (a.priority !== b.priority) return a.priority > b.priority ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function uniqueSourceIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Collapse one dedupeKey group.
 * Rejected → suppress forever (never re-prompt).
 * Accepted-only / superseded-only → omit.
 * Multiple pending same key → merge sourceIds; keep best ranking row.
 * Cross-source unclear duplicates must use different dedupeKeys (caller/AI).
 */
export function resolveDedupeGroup(
  group: readonly DigestActionCandidate[],
): DigestActionCandidate | null {
  if (group.length === 0) return null;
  if (group.some((c) => c.status === "rejected")) return null;

  const pending = group.filter((c) => c.status === "pending");
  if (pending.length === 0) return null;

  const sorted = [...pending].sort(compareDigestCandidates);
  const head = sorted[0]!;
  const sourceIds = uniqueSourceIds(pending.flatMap((c) => c.sourceIds));
  const needsConfirmation = pending.some((c) => c.needsConfirmation);
  return {
    ...head,
    sourceIds,
    needsConfirmation,
  };
}

/**
 * Builds the Today digest projection from action candidates.
 * Drops accepted / rejected / superseded; merges by dedupeKey; caps primary at 3.
 */
export function buildActionDigest(
  candidates: readonly DigestActionCandidate[],
): ActionDigestView {
  const byKey = new Map<string, DigestActionCandidate[]>();
  for (const candidate of candidates) {
    const list = byKey.get(candidate.dedupeKey);
    if (list) list.push(candidate);
    else byKey.set(candidate.dedupeKey, [candidate]);
  }

  const active: DigestActionCandidate[] = [];
  for (const group of byKey.values()) {
    const resolved = resolveDedupeGroup(group);
    if (resolved) active.push(resolved);
  }

  active.sort(compareDigestCandidates);
  const primary = active.slice(0, PRIMARY_CAP);
  const pendingConfirmationCount = active.filter((c) => c.needsConfirmation).length;
  return { primary, pendingConfirmationCount };
}

/**
 * Source correction adapter: supersede prior pending rows sharing dedupeKey,
 * keep accepted history, append the revised pending candidate.
 * If an accepted row already exists for the key, force needsConfirmation so
 * callers only propose a delta draft (never silent re-accept).
 */
export function applySourceRevision(
  existing: readonly DigestActionCandidate[],
  revised: DigestActionCandidate,
): DigestActionCandidate[] {
  const hadAccepted = existing.some(
    (c) => c.dedupeKey === revised.dedupeKey && c.status === "accepted",
  );
  const next: DigestActionCandidate[] = existing.map((c) => {
    if (c.dedupeKey !== revised.dedupeKey) return c;
    if (c.status === "pending") return { ...c, status: "superseded" as const };
    return c;
  });
  next.push({
    ...revised,
    status: "pending",
    needsConfirmation: revised.needsConfirmation || hadAccepted,
  });
  return next;
}

/**
 * Map a K02 TutorAction-shaped blocker into a digest candidate.
 * No mastery percentage — evidence ids become sourceIds when they look usable.
 */
export function blockerToDigestCandidate(input: {
  id: string;
  nodeId: string;
  kind: string;
  reason: string;
  evidenceIds: readonly string[];
  minutes?: number;
  priority?: number;
  dueAt?: string | null;
}): DigestActionCandidate {
  return {
    id: input.id,
    dedupeKey: `k02:${input.nodeId}:${input.kind}`,
    title: input.reason.slice(0, 500) || `学习卡点 · ${input.kind}`,
    minutes: input.minutes ?? 25,
    dueAt: input.dueAt ?? null,
    priority: input.priority ?? 50,
    sourceIds: [...input.evidenceIds],
    status: "pending",
    needsConfirmation: true,
  };
}

/** Digest / candidate payloads must never carry mastery percentages. */
export function assertDigestHasNoMasteryPercentage(
  value: Record<string, unknown>,
): void {
  for (const key of Object.keys(value)) {
    if (/mastery/i.test(key)) {
      throw new Error(`mastery field is not allowed on action digest: ${key}`);
    }
  }
}

/**
 * After an accepted schedule is revised, only the delta task ids should be
 * re-proposed — never a silent full replan of unchanged blocks.
 */
export function deltaTaskIdsForRevision(input: {
  previouslyAcceptedTaskIds: readonly string[];
  revisedCandidateTaskIds: readonly string[];
}): string[] {
  const prior = new Set(input.previouslyAcceptedTaskIds);
  return input.revisedCandidateTaskIds.filter((id) => !prior.has(id));
}
