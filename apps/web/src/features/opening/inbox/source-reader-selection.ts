export type ReaderSelection = { sourceId: string; version: number; page?: number; text: string };

/** A selection belongs to one rendered source revision and one reading region. */
export function selectedReaderExcerpt(root: HTMLElement, sourceId: string, version: number, selection: Pick<Selection, "anchorNode" | "focusNode" | "isCollapsed" | "toString"> | null): ReaderSelection | null {
  if (!selection || selection.isCollapsed) return null;
  const element = (node: Node | null) => node instanceof Element ? node : node?.parentElement;
  const anchor = element(selection.anchorNode)?.closest<HTMLElement>("[data-study-reading-text]");
  const focus = element(selection.focusNode)?.closest("[data-study-reading-text]");
  const text = selection.toString().trim();
  if (!anchor || anchor !== focus || !root.contains(anchor) || anchor.closest('[hidden],[inert],[aria-busy="true"]')) return null;
  if (anchor.dataset.sourceId !== sourceId || anchor.dataset.sourceVersion !== String(version) || !text) return null;
  const page = anchor.dataset.pageKind === "physical" ? Number(anchor.dataset.sourcePage) : undefined;
  if (page !== undefined && (!Number.isSafeInteger(page) || page <= 0)) return null;
  return { sourceId, version, page, text };
}
