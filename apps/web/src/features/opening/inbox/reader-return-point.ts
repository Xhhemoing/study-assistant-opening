export type ReaderReturnPoint = {
  opener: HTMLElement | null;
  scroll: Array<{ element: HTMLElement; top: number; left: number }>;
};

/** Keep the mounted library/learning view's scroll and keyboard position intact. */
export function captureReaderReturnPoint(opener: HTMLElement | null): ReaderReturnPoint {
  const scroll: ReaderReturnPoint["scroll"] = [];
  for (let element = opener; element; element = element.parentElement) {
    scroll.push({ element, top: element.scrollTop, left: element.scrollLeft });
  }
  return { opener, scroll };
}

export function restoreReaderReturnPoint(point: ReaderReturnPoint): void {
  if (point.opener?.isConnected) point.opener.focus({ preventScroll: true });
  for (const { element, top, left } of point.scroll) {
    if (!element.isConnected) continue;
    element.scrollTop = top;
    element.scrollLeft = left;
  }
}
