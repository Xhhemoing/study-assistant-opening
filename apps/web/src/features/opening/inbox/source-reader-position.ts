type PositionStorage = Pick<Storage, "getItem" | "setItem">;
const key = (sourceId: string, version: number) => `opening:reader-page:${sourceId}:v${version}`;

function tabStorage(): PositionStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; }
  catch { return undefined; }
}

/** UI reading preference only. Explicit citation locators always win over saved text position. */
export function sourceReaderInitialPage(sourceId: string, version: number, requestedPage?: number, storage: PositionStorage | undefined = tabStorage()): number | undefined {
  if (requestedPage !== undefined) return requestedPage;
  try {
    const page = Number(storage?.getItem(key(sourceId, version)));
    return Number.isSafeInteger(page) && page > 0 ? page : undefined;
  } catch { return undefined; }
}

/** Call only after a content response has confirmed source, version, and page. */
export function rememberSourceReaderPage(sourceId: string, version: number, page: number | null, storage: PositionStorage | undefined = tabStorage()): void {
  if (page == null || !Number.isSafeInteger(page) || page <= 0) return;
  try { storage?.setItem(key(sourceId, version), String(page)); }
  catch { /* A blocked UI preference store must not prevent reading. */ }
}
