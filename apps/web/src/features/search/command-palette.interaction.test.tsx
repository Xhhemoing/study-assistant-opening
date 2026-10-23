// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("./search-api", () => ({ createSearchApi: () => ({ search: vi.fn().mockResolvedValue([]) }) }));
import { CommandPalette } from "./command-palette";

let root: Root;
let host: HTMLDivElement;
const open = vi.fn();
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
  HTMLElement.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal("cancelAnimationFrame", clearTimeout);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  open.mockReset(); push.mockReset();
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function key(patch: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "k", ctrlKey: true, ...patch });
  document.dispatchEvent(event);
  return event;
}

describe("global search navigation", () => {
  it("opens only the supported non-composing Cmd/Ctrl K shortcut", async () => {
    await act(async () => root.render(<CommandPalette open={false} onOpen={open} onClose={() => {}} />));
    expect(key({}).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
    for (const patch of [{ key: "j" }, { shiftKey: true }, { altKey: true }, { isComposing: true }, { keyCode: 229 }]) {
      expect(key(patch).defaultPrevented).toBe(false);
    }
    expect(open).toHaveBeenCalledOnce();
  });
  it("leaves the shortcut to an already open modal", async () => {
    await act(async () => root.render(<CommandPalette open={false} onOpen={open} onClose={() => {}} />));
    const dialog = document.createElement("dialog"); dialog.open = true; host.append(dialog);
    expect(key({}).defaultPrevented).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it("keeps global search available alongside a non-modal study companion", async () => {
    await act(async () => root.render(<CommandPalette open={false} onOpen={open} onClose={() => {}} />));
    const companion = document.createElement("dialog"); companion.open = true; companion.dataset.studyCompanion = "true"; host.append(companion);
    expect(key({}).defaultPrevented).toBe(true);
    expect(open).toHaveBeenCalledOnce();
  });
  it("navigates to conversation history as a real route", async () => {
    const close = vi.fn();
    await act(async () => root.render(<CommandPalette open onOpen={open} onClose={close} />));
    await act(async () => document.getElementById("command-option-assistant")?.click());
    expect(close).toHaveBeenCalledOnce();
    expect(push).toHaveBeenCalledWith("/opening/assistant");
  });
});
