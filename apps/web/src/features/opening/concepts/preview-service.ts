import "server-only";
import { createOpeningConceptPreviewRepository } from "@aistudy/database";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { conceptPreviewRequestSchema, type ConceptPreviewRequest, type ConceptPreviewResponse } from "./preview-contract";

/** Exact matching, including case, combining marks and mathematical notation. */
export function locatePreviewSelection(text: string, input: ConceptPreviewRequest) {
  const quote = input.selection?.text ?? input.term;
  if (!quote.includes(input.term)) return { status: "unavailable" as const, selection: null };
  const start = input.selection?.start;
  if (start != null) {
    const end = input.selection!.end!;
    return text.slice(start, end) === quote
      ? { status: "available" as const, selection: { text: text.slice(start,end), start, end } }
      : { status: "stale" as const, selection: null };
  }
  const at = text.indexOf(quote);
  if (at < 0) return { status: "unavailable" as const, selection: null };
  if (text.indexOf(quote, at + 1) >= 0) return { status: "ambiguous" as const, selection: null };
  return { status: "available" as const, selection: { text: text.slice(at,at+quote.length), start: at, end: at+quote.length } };
}
/** Expand only inside the verified page's enclosing blank-line paragraph. */
export function expandPreviewContext(text: string, selection: { text: string; start: number; end: number }) {
  let paragraphStart = 0, paragraphEnd = text.length;
  for (const match of text.matchAll(/\r?\n[\t ]*\r?\n/g)) {
    const start = match.index!, end = start + match[0].length;
    if (end <= selection.start) paragraphStart = end;
    if (start >= selection.end) { paragraphEnd = start; break; }
  }
  const budget = 1200 - (selection.end - selection.start);
  let start = Math.max(paragraphStart, selection.start - Math.floor(budget / 2));
  const end = Math.min(paragraphEnd, start + 1200);
  start = Math.max(paragraphStart, Math.min(start, end - 1200));
  return { text: text.slice(start, end), start, end,
    context: { scope: "same_page_paragraph" as const, expanded: start < selection.start || end > selection.end,
      truncatedBefore: start > paragraphStart, truncatedAfter: end < paragraphEnd } };
}
export function conceptPreviewService(sql: Sql) {
  const repository = createOpeningConceptPreviewRepository(sql);
  return {
    async preview(scope: Scope, raw: unknown): Promise<ConceptPreviewResponse> {
      const input = conceptPreviewRequestSchema.parse(raw);
      let match: ReturnType<typeof locatePreviewSelection> | undefined;
      let excerpt: ReturnType<typeof expandPreviewContext> | undefined;
      const result = await repository.deliver(scope, { ...input, releaseKey: input.clientKey }, text => {
        match = locatePreviewSelection(text, input);
        if (!match.selection) return null;
        excerpt = expandPreviewContext(text, match.selection);
        return { text: excerpt.text, start: excerpt.start, end: excerpt.end, originalSelection: match.selection };
      });
      if (result.status !== "read") return { status: result.status, reason: result.status === "restricted"
        ? "reader_preview_restricted_material_or_open_attempt" : result.status === "stale" ? "source_version_unavailable" : "source_page_unavailable" };
      if (!result.selection) return { status: match?.status === "ambiguous" ? "ambiguous" : match?.status === "stale" ? "stale" : "unavailable", reason: "selection_not_uniquely_verified" };
      return { status: "available", kind: "source_excerpt", text: result.selection.text, term: input.term,
        selection: match!.selection!, context: excerpt!.context,
        locator: { sourceId: input.sourceId, sourceVersion: input.sourceVersion, page: input.page,
          start: result.selection.start, end: result.selection.end, manifestRevision: result.manifestRevision },
        contextAnchor: result.anchor, exposureReceipts: result.exposureReceipts };
    },
  };
}
