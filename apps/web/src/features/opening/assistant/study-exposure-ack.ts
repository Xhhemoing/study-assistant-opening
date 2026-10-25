/** A failed ack leaves the conservative server release in force; it never restores independence. */
const acknowledged = new Set<string>();
const pending = new Map<string, Promise<void>>();
export function acknowledgeStudyExposure(receipt: { id: string } | null | undefined, fetcher: typeof fetch = fetch): Promise<void> {
  if (!receipt || acknowledged.has(receipt.id)) return Promise.resolve();
  const existing = pending.get(receipt.id);
  if (existing) return existing;
  const request = fetcher(`/api/opening/study/exposures/${encodeURIComponent(receipt.id)}/ack`, { method: "POST" })
    .then(response => { if (!response.ok) throw new Error("学习记录暂未同步"); acknowledged.add(receipt.id); })
    .finally(() => pending.delete(receipt.id));
  pending.set(receipt.id, request);
  return request;
}

/** Call only once the successful response body has been read and accepted. */
export function acknowledgeStudyExposureHeaders(response: Pick<Response, "headers">, fetcher: typeof fetch = fetch): void {
  const ids = response.headers.get("X-Study-Exposure-Receipts")?.split(",").map(id => id.trim()).filter(Boolean) ?? [];
  for (const id of ids) void acknowledgeStudyExposure({ id }, fetcher).catch(() => undefined);
}
