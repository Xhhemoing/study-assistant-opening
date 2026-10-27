// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { RestoredPositionNotice } from "./restored-position-notice";

it("announces restored progress for three seconds without a dismissal control", async () => {
  vi.useFakeTimers(); Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div"), root = createRoot(host);
  try {
    await act(async () => root.render(<RestoredPositionNotice restored />));
    expect(host.textContent).toBe("已恢复学习位置");
    expect(host.querySelector("button")).toBeNull();
    await act(async () => vi.advanceTimersByTime(2999));
    expect(host.textContent).toBe("已恢复学习位置");
    await act(async () => vi.advanceTimersByTime(1));
    expect(host.textContent).toBe("");
    await act(async () => root.render(<RestoredPositionNotice key="new-lesson" restored={false} />));
    expect(host.textContent).toBe("");
  } finally { await act(async () => root.unmount()); vi.useRealTimers(); }
});
