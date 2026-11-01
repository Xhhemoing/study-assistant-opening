import type { ApiFailure } from "@aistudy/contracts";

type PageRange = { start: number; end: number };

function summarizePages(ranges: PageRange[]): string {
  const merged: PageRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  const total = merged.reduce((sum, range) => sum + range.end - range.start + 1, 0);
  const shown = merged.slice(0, 6).map(({ start, end }) => start === end ? `${start}` : `${start}–${end}`).join("、");
  return `第 ${shown}${merged.length > 6 ? ` 等共 ${total}` : ""} 页`;
}

/** Keep persisted PDF warnings within the API contract, regardless of page count. */
export function createPdfPartialError(failedRanges: string[], lowQualityPages: number[]): ApiFailure {
  const failed = failedRanges.map(range => {
    const [first, last] = range.split("-");
    return { start: Number(first), end: Number(last ?? first) };
  });
  const message = [
    failed.length ? `${summarizePages(failed)}未能识别，可以重新解析` : "",
    lowQualityPages.length ? `${summarizePages(lowQualityPages.map(page => ({ start: page, end: page })))}识别质量低` : "",
  ].filter(Boolean).join("；");
  return { code: "PARSE_PARTIAL", message: message.slice(0, 500), retryable: failedRanges.length > 0 };
}
