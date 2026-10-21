// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ConnectionNotice } from "./connection-notice";

it("shows an offline notice and clears it on reconnect without replaying requests", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ConnectionNotice />));
    expect(host.textContent).toBe("");
    online.mockReturnValue(false);
    await act(async () => window.dispatchEvent(new Event("offline")));
    expect(host.querySelector('[role="status"]')?.textContent).toContain("当前离线");
    online.mockReturnValue(true);
    await act(async () => window.dispatchEvent(new Event("online")));
    expect(host.textContent).toBe("");
    expect(fetch).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
    online.mockRestore(); vi.unstubAllGlobals();
  }
});
