import type { SystemQueryReceipt } from "@aistudy/contracts";

export type QueryEvidenceLink = { href: string; label: string };
const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const COURSE = new RegExp(`^/opening/courses/${UUID}(?:/study|\\?tab=records)?$`);
const MATERIAL = new RegExp(`^/opening/library\\?tab=materials&source=${UUID}&version=(?:0|[1-9][0-9]*)(?:&page=[1-9][0-9]*)?$`);

/** Only the read routes emitted by the query executor; encoded URL interpretation is unnecessary. */
export function isQueryEvidenceHref(href: string): boolean {
  if (/[\s%\\]/.test(href)) return false;
  return ["/opening/today", "/opening/settings", "/opening/library"].includes(href)
    || COURSE.test(href) || MATERIAL.test(href);
}

/** Answer Markdown alone never grants a destination: these come from the server-owned receipt. */
export function queryEvidenceLinks(receipt?: SystemQueryReceipt | null): QueryEvidenceLink[] {
  const links = new Map<string, QueryEvidenceLink>();
  for (const result of receipt?.results ?? []) {
    for (const evidence of result.evidence) {
      if (isQueryEvidenceHref(evidence.href)) links.set(evidence.href, { href: evidence.href, label: evidence.title });
    }
  }
  return [...links.values()];
}
