/**
 * V2-06 teaching coverage — condition → SourceAnchor rows + status.
 * Domain-only: no @aistudy/ai import. Lexical overlap is a local lightweight helper.
 * No mastery / confidence % anywhere in this module.
 */

export type SourceAnchor = {
  sourceId: string;
  sourceVersion: number;
  chunkId: string;
  page?: number | null;
  slideLabel?: string | null;
  startMs?: number | null;
};

export type CoverageStatus = "covered" | "partial" | "uncovered" | "conflict";

export type CoverageRow = {
  goalId?: string;
  conditionId: string;
  statement: string;
  sourceAnchors: SourceAnchor[];
  status: CoverageStatus;
  notes?: string;
};

export type ClaimEvidenceKind =
  | "material_reorg"
  | "generated_example"
  | "supplemental"
  | "inference"
  | "conflict"
  | "uncovered";

export type CoverageCondition = {
  goalId?: string;
  conditionId: string;
  statement: string;
  linkedSourceIds?: string[];
};

export type BuildCoverageTableInput = {
  conditions: CoverageCondition[];
  anchors: SourceAnchor[];
  chunkTexts: Map<string, string>;
  /** Condition ids forced to conflict (M1: no auto-conflict detection). */
  conflicts?: readonly string[];
};

/** Identity key — never page-alone (AN-RN-01). */
export function anchorKey(a: SourceAnchor): string {
  return `${a.sourceId}@${a.sourceVersion}#${a.chunkId}`;
}

/** Mark a row as conflict without inventing new anchors. */
export function markConflict(row: CoverageRow, notes?: string): CoverageRow {
  return {
    ...row,
    status: "conflict",
    notes: notes ?? row.notes ?? "conflict marked",
  };
}

/**
 * Local keyword / CJK-bigram overlap (domain copy — do not import @aistudy/ai).
 * Returns 0 when either side is blank; citation-id-only callers get 0.
 */
export function lexicalOverlapScore(query: string, text: string): number {
  const q = query.trim();
  const t = text.trim();
  if (q.length === 0 || t.length === 0) return 0;

  const tokens = q
    .toLocaleLowerCase()
    .slice(0, 20_000)
    .split(/\s+/)
    .map((token) =>
      token.replace(
        /^[,.;:!?"“”「」『』、，。；：！？…]+|[,.;:!?"“”「」『』、，。；：！？…]+$/gu,
        "",
      ),
    )
    .filter(Boolean);

  const unique = [...new Set(tokens)];
  if (unique.length === 0) {
    // No whitespace tokens (e.g. pure CJK) — score via includes / bigrams on whole query.
    const haystack = t.toLocaleLowerCase();
    const whole = q.toLocaleLowerCase();
    if (haystack.includes(whole)) return 1;
    const grams: string[] = [];
    for (const run of whole.match(/\p{Script=Han}+/gu) ?? []) {
      for (let i = 0; i < run.length - 1; i++) grams.push(run.slice(i, i + 2));
    }
    if (grams.length === 0) return haystack.includes(whole) ? 1 : 0;
    const hit = grams.filter((g) => haystack.includes(g)).length;
    return hit / grams.length;
  }

  const haystack = t.toLocaleLowerCase();
  return unique.reduce((total, whole) => {
    const grams = new Set<string>();
    for (const run of whole.match(/\p{Script=Han}+/gu) ?? []) {
      for (let i = 0; i < run.length - 1; i++) grams.add(run.slice(i, i + 2));
    }
    const gramList = [...grams];
    return (
      total +
      (haystack.includes(whole)
        ? 1
        : gramList.filter((gram) => haystack.includes(gram)).length /
          Math.max(1, gramList.length))
    );
  }, 0);
}

/**
 * Build coverage rows. Conflict only when `conflicts` lists the conditionId
 * (or via `markConflict` after the fact). Citation id alone is never "covered".
 */
export function buildCoverageTable(input: BuildCoverageTableInput): CoverageRow[] {
  const conflictSet = new Set(input.conflicts ?? []);
  return input.conditions.map((condition) => {
    const linked = condition.linkedSourceIds;
    const candidates =
      linked && linked.length > 0
        ? input.anchors.filter((a) => linked.includes(a.sourceId))
        : input.anchors;

    const scored = candidates.map((anchor) => {
      const text = input.chunkTexts.get(anchorKey(anchor)) ?? "";
      return { anchor, score: lexicalOverlapScore(condition.statement, text) };
    });
    const supporting = scored.filter((s) => s.score > 0).map((s) => s.anchor);
    const zeroOnly = scored.filter((s) => s.score === 0).map((s) => s.anchor);

    if (conflictSet.has(condition.conditionId)) {
      return {
        goalId: condition.goalId,
        conditionId: condition.conditionId,
        statement: condition.statement,
        sourceAnchors: supporting.length > 0 ? supporting : candidates,
        status: "conflict" as const,
        notes: "conflict listed by caller",
      };
    }

    if (supporting.length > 0) {
      return {
        goalId: condition.goalId,
        conditionId: condition.conditionId,
        statement: condition.statement,
        sourceAnchors: supporting,
        status: "covered" as const,
      };
    }

    if (candidates.length > 0) {
      return {
        goalId: condition.goalId,
        conditionId: condition.conditionId,
        statement: condition.statement,
        sourceAnchors: zeroOnly.length > 0 ? zeroOnly : candidates,
        status: "partial" as const,
        notes: "zero lexical overlap; pack may be filled via Package C fallback",
      };
    }

    return {
      goalId: condition.goalId,
      conditionId: condition.conditionId,
      statement: condition.statement,
      sourceAnchors: [],
      status: "uncovered" as const,
      notes: "no usable anchor in pack for the condition",
    };
  });
}

/** Worst-wins merge: conflict > uncovered > partial > covered. */
export function mergeCoverageStatus(rows: CoverageRow[]): CoverageStatus {
  if (rows.length === 0) return "uncovered";
  const rank: Record<CoverageStatus, number> = {
    conflict: 0,
    uncovered: 1,
    partial: 2,
    covered: 3,
  };
  let worst: CoverageStatus = "covered";
  for (const row of rows) {
    if (rank[row.status] < rank[worst]) worst = row.status;
  }
  return worst;
}
