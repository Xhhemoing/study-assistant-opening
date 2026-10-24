import type { Parent, Root, Text } from "mdast";

/** Caller-authorized mapping only; labels are never resolved to knowledge by the renderer. */
export type ConceptAnchor = { label: string; id: string };
const BLOCKS = new Set(["paragraph", "heading", "tableCell"]);
const SKIP = new Set(["link", "linkReference", "code", "inlineCode", "math", "inlineMath", "html", "image", "imageReference", "definition"]);

/** Pure rendering capability, not classroom/source-node integration or an authority lookup. */
export function remarkConceptAnchors(options: { candidates: readonly ConceptAnchor[] }) {
  const ids = new Map<string, Set<string>>();
  for (const { label, id } of options.candidates) {
    if (!label.trim() || !id.trim()) continue;
    const values = ids.get(label) ?? new Set<string>();
    values.add(id);
    ids.set(label, values);
  }
  // Ambiguous labels fail closed. Longest candidate wins at the same source location.
  const candidates = [...ids].filter(([, values]) => values.size === 1)
    .map(([label, values]) => ({ label, id: [...values][0]! }))
    .sort((a, b) => b.label.length - a.label.length);

  return (tree: Root, file?: { value?: unknown }) => {
    if (!candidates.length) return;
    const source = typeof file?.value === "string" ? file.value : undefined;
    const split = (node: Text, seen: Set<string>): Text[] => {
      if (node.data?.hName || node.data?.hProperties) return [node];
      const value = node.value;
      const protectedRanges = [...value.matchAll(/\[\d+\]/g)].map(match => [match.index, match.index + match[0].length]);
      const result: Text[] = [];
      const part = (start: number, end: number, candidate?: ConceptAnchor): Text => {
        const next: Text = { type: "text", value: value.slice(start, end) };
        // Entity/escape decoding can change lengths: never manufacture inaccurate offsets.
        const origin = node.position?.start;
        if (origin?.offset !== undefined && source?.slice(origin.offset, node.position?.end.offset) === value) {
          const point = (index: number) => {
            const prefix = value.slice(0, index).split("\n");
            return { line: origin.line + prefix.length - 1, column: prefix.length === 1 ? origin.column + index : prefix.at(-1)!.length + 1, offset: origin.offset! + index };
          };
          next.position = { start: point(start), end: point(end) };
        }
        if (candidate) next.data = { hName: "button", hProperties: { type: "button", dataConceptId: candidate.id } };
        return next;
      };
      let cursor = 0, last = 0;
      while (cursor < value.length) {
        const candidate = candidates.find(item => value.startsWith(item.label, cursor)
          && !protectedRanges.some(([start, end]) => cursor < end! && cursor + item.label.length > start!));
        if (!candidate) { cursor++; continue; }
        if (seen.has(candidate.label)) { cursor += candidate.label.length; continue; }
        if (cursor > last) result.push(part(last, cursor));
        result.push(part(cursor, cursor + candidate.label.length, candidate));
        seen.add(candidate.label);
        cursor += candidate.label.length;
        last = cursor;
      }
      if (!result.length) return [node];
      if (last < value.length) result.push(part(last, value.length));
      return result;
    };
    const walk = (parent: Parent, inherited?: Set<string>) => {
      if (SKIP.has(parent.type) || parent.data?.hName || parent.data?.hProperties) return;
      const seen = BLOCKS.has(parent.type) ? new Set<string>() : inherited;
      parent.children = parent.children.flatMap<Parent["children"][number]>(child => {
        if (child.type === "text" && seen) return split(child, seen);
        if ("children" in child) walk(child, seen);
        return [child];
      });
    };
    walk(tree);
  };
}
