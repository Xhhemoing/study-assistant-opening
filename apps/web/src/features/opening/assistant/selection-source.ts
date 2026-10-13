/** Minimal DOM surface used here; real DOM nodes satisfy it, tests can use plain objects. */
export type SourceNode = {
  parentNode: SourceNode | null;
  getAttribute?: (name: string) => string | null;
};
export type SourceSelection = { anchorNode: SourceNode | null; focusNode: SourceNode | null };
export type SelectedSource = { kind: "source"; text: string } | { kind: "fallback" };

/** Nearest top-level prose block (marked by LearningProse) containing `node`, below `root`. */
function sourceRange(node: SourceNode | null, root: SourceNode, length: number): [number, number] | null {
  for (let current = node; current && current !== root; current = current.parentNode) {
    const start = current.getAttribute?.("data-src-start"), end = current.getAttribute?.("data-src-end");
    if (start == null || end == null) continue;
    const range = [Number(start), Number(end)] as const;
    return range.every(Number.isInteger) && range[0] >= 0 && range[0] <= range[1] && range[1] <= length ? [range[0], range[1]] : null;
  }
  return null;
}

/**
 * Maps a rendered selection back to the answer's Markdown source, widened to whole blocks,
 * so a saved excerpt keeps its structure. Anything unmapped falls back to the whole answer.
 */
export function selectedSourceFor(text: string, root: SourceNode, selection: SourceSelection): SelectedSource {
  const anchor = sourceRange(selection.anchorNode, root, text.length);
  const focus = sourceRange(selection.focusNode, root, text.length);
  if (!anchor || !focus) return { kind: "fallback" };
  const source = text.slice(Math.min(anchor[0], focus[0]), Math.max(anchor[1], focus[1]));
  return source.trim() ? { kind: "source", text: source } : { kind: "fallback" };
}
