// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDueReviewCount } from "./review-count";
let host: HTMLDivElement;
let root: Root;
function Count({ pathname = "/opening/review" }: { pathname?: string }) { const count = useDueReviewCount(pathname); return <span>{count === null ? "unknown" : count}</span>; }
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", vi.fn());
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

describe("navigation review metadata", () => {
  it("fetches count without delivering the review queue and refreshes after a review", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ count: 7 })).mockResolvedValueOnce(Response.json({ count: 6 }));
    await act(async () => root.render(<Count />));
    expect(host.textContent).toBe("7");
    expect(fetch).toHaveBeenCalledWith("/api/reviews/count", expect.objectContaining({ cache: "no-store" }));
    await act(async () => { window.dispatchEvent(new Event("opening:reviews-changed")); });
    expect(host.textContent).toBe("6");
  });
  it("omits a stale count after a failed or invalid response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ count: 7 })).mockResolvedValueOnce(Response.json({ count: -1 }));
    await act(async () => root.render(<Count />));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(host.textContent).toBe("unknown");
  });
  it("does not accept a late response from a previous page", async () => {
    let finish!: (response: Response) => void;
    vi.mocked(fetch).mockReturnValueOnce(new Promise(resolve => { finish = resolve; })).mockResolvedValueOnce(Response.json({ count: 2 }));
    await act(async () => root.render(<Count pathname="/opening/today" />));
    await act(async () => root.render(<Count pathname="/opening/review" />));
    await act(async () => finish(Response.json({ count: 100 })));
    expect(host.textContent).toBe("2");
  });
});
