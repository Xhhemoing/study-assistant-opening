export type MatchRange = {
  readonly start: number;
  readonly end: number;
};

export function rangesOverlap(a: MatchRange, b: MatchRange): boolean {
  return a.start < b.end && b.start < a.end;
}

export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

type TransferSpan = MatchRange & {
  readonly paragraphIndex: number;
  readonly exclusiveKey?: string;
};

function spanKey(span: TransferSpan): string {
  return span.exclusiveKey ?? JSON.stringify([span.paragraphIndex, span.start, span.end]);
}

function conflicts(a: TransferSpan, b: TransferSpan): boolean {
  return spanKey(a) === spanKey(b) ||
    (a.paragraphIndex === b.paragraphIndex && rangesOverlap(a, b));
}

function compareSpans(a: TransferSpan, b: TransferSpan): number {
  return a.paragraphIndex - b.paragraphIndex || a.start - b.start || a.end - b.end ||
    compareText(spanKey(a), spanKey(b));
}

/** Maximum bipartite matching between targets and individual evidence resources. */
function matchingSize(candidates: readonly (readonly TransferSpan[])[]): number {
  const ownerByResource = new Map<string, number>();
  function claim(target: number, visited: Set<string>): boolean {
    for (const candidate of candidates[target]!) {
      const resource = spanKey(candidate);
      if (visited.has(resource)) continue;
      visited.add(resource);
      const owner = ownerByResource.get(resource);
      if (owner === undefined || claim(owner, visited)) {
        ownerByResource.set(resource, target);
        return true;
      }
    }
    return false;
  }

  candidates.forEach((_, target) => claim(target, new Set()));
  return ownerByResource.size;
}

function countDisjointSpans(candidates: readonly (readonly TransferSpan[])[]): number {
  const spans = candidates.flat().sort((a, b) => a.paragraphIndex - b.paragraphIndex || a.end - b.end);
  let last: TransferSpan | undefined;
  let count = 0;
  for (const span of spans) {
    if (!last || span.paragraphIndex !== last.paragraphIndex || span.start >= last.end) {
      last = span;
      count += 1;
    }
  }
  return count;
}

/**
 * Maximizes credited targets, including when distinct candidate resources overlap.
 * Bipartite matching bounds the search by available resources. Interval scheduling
 * bounds it by disjoint text. Visit target IDs and spans in sorted order to keep the
 * first optimal assignment stable under target and candidate permutations.
 */
export function allocateIeltsSpans<T extends TransferSpan>(
  candidatesByTarget: ReadonlyMap<string, readonly T[]>,
): ReadonlyMap<string, T> {
  const targets = [...candidatesByTarget]
    .filter(([, candidates]) => candidates.length > 0)
    .sort(([a], [b]) => compareText(a, b))
    .map(([id, candidates]) => ({ id, candidates: [...candidates].sort(compareSpans) }));
  const selected = new Map<string, T>();
  let best = new Map<string, T>();

  function search(index: number): void {
    if (selected.size > best.size) best = new Map(selected);
    if (selected.size + targets.length - index <= best.size) return;

    const occupied = [...selected.values()];
    const available = targets.slice(index).map(({ candidates }) =>
      candidates.filter((candidate) => occupied.every((span) => !conflicts(span, candidate))),
    );
    const upperBound = selected.size + Math.min(countDisjointSpans(available), matchingSize(available));
    if (upperBound <= best.size) return;

    const { id } = targets[index]!;
    for (const candidate of available[0]!) {
      selected.set(id, candidate);
      search(index + 1);
      selected.delete(id);
      if (best.size === upperBound) return;
    }
    search(index + 1);
  }

  search(0);
  return best;
}
