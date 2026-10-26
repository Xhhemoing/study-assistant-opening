// @vitest-environment jsdom
import { act, createElement, useEffect, useState, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SPLIT_PANES, SplitControls, SplitView, toggleSplitPane, visibleSplitPanes } from "./split-view";
import { NAV_WIDTH_DEFAULT, NAV_WIDTH_MAX, NAV_WIDTH_MIN, clampNavWidth, normalizeLayoutPref } from "../shell/use-layout-pref";
import type { LayoutPref } from "../shell/use-layout-pref";
import { StudyToolsPanel } from "../../teaching/study-tools-panel";

const state = vi.hoisted(() => ({ pref: null as unknown as LayoutPref, listeners: new Set<() => void>(), wide: true, realResize: false, mediaListeners: new Set<() => void>() }));
vi.mock("../shell/use-layout-pref", async () => ({
  ...await vi.importActual("../shell/use-layout-pref"),
  useLayoutPref: () => [useSyncExternalStore(callback => { state.listeners.add(callback); return () => { state.listeners.delete(callback); }; }, () => state.pref),
    (patch: Partial<LayoutPref>) => { state.pref = { ...state.pref, ...patch }; state.listeners.forEach(callback => callback()); }],
}));
// Node identity is under test here; resize geometry stays the library/browser's responsibility.
vi.mock("react-resizable-panels", async importOriginal => {
  const actual = await importOriginal<typeof import("react-resizable-panels")>();
  return {
    Group: (props: Parameters<typeof actual.Group>[0]) => state.realResize ? createElement(actual.Group, props) : createElement("div", { "data-split-group": true }, props.children),
    Panel: (props: Parameters<typeof actual.Panel>[0]) => {
      useEffect(() => { if (!state.realResize && props.panelRef && typeof props.panelRef === "object") props.panelRef.current = { collapse: vi.fn(), expand: vi.fn(), resize: vi.fn(), getSize: vi.fn(), isCollapsed: vi.fn() }; }, [props.panelRef]);
      return state.realResize ? createElement(actual.Panel, props) : createElement("div", { id: props.id, className: props.className, hidden: props.hidden }, props.children);
    },
    Separator: (props: Parameters<typeof actual.Separator>[0]) => state.realResize ? createElement(actual.Separator, props) : createElement("div", { role: "separator" }),
  };
});

let host: HTMLDivElement, root: Root;
const originalShow = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "show");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
beforeEach(() => {
  state.pref = normalizeLayoutPref({}); state.wide = true; state.realResize = false; window.localStorage.clear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ get matches() { return state.wide; }, addEventListener: (_: string, callback: () => void) => state.mediaListeners.add(callback), removeEventListener: (_: string, callback: () => void) => state.mediaListeners.delete(callback) }));
  Object.defineProperty(HTMLDialogElement.prototype, "show", { configurable: true, value: function (this: HTMLDialogElement) { this.setAttribute("open", ""); } });
  Object.defineProperty(HTMLDialogElement.prototype, "close", { configurable: true, value: function (this: HTMLDialogElement) { this.removeAttribute("open"); } });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove(); state.listeners.clear(); state.mediaListeners.clear(); vi.unstubAllGlobals();
  if (originalShow) Object.defineProperty(HTMLDialogElement.prototype, "show", originalShow); else Reflect.deleteProperty(HTMLDialogElement.prototype, "show");
  if (originalClose) Object.defineProperty(HTMLDialogElement.prototype, "close", originalClose); else Reflect.deleteProperty(HTMLDialogElement.prototype, "close");
});

describe("split panes", () => {
  it("opens one pane, replacing the previous selection", () => {
    expect(toggleSplitPane([], "assistant")).toEqual(["assistant"]);
    expect(toggleSplitPane(["assistant"], "notes")).toEqual(["notes"]);
    expect(toggleSplitPane(["assistant", "notes"], "sources")).toEqual(["sources"]);
    expect(toggleSplitPane(["assistant", "notes"], "assistant")).toEqual(["notes"]);
    expect(MAX_SPLIT_PANES).toBe(1);
  });
  it("only shows panes the page provides", () => {
    const spec = { label: "x", icon: null, render: () => null };
    expect(visibleSplitPanes(["assistant", "sources"], { assistant: spec })).toEqual(["assistant"]);
  });
});

describe("one persistent tool surface", () => {
  function Editor({ label, onMount }: { label: string; onMount: () => void }) { useEffect(onMount, []); return createElement("textarea", { "aria-label": label, defaultValue: label }); }
  function setup(onMount = vi.fn(), suspended = false, extra: Partial<Parameters<typeof SplitView>[0]> = {}) {
    const panes = { assistant: { label: "对话", icon: null, render: () => createElement(Editor, { label: "对话草稿", onMount }) }, notes: { label: "笔记", icon: null, render: () => createElement(Editor, { label: "笔记草稿", onMount }) }, sources: { label: "资料", icon: null, render: () => createElement(Editor, { label: "资料选择", onMount }) } };
    return createElement("div", null, createElement(SplitControls, { panes }), createElement(SplitView, { panes, suspended, ...extra, children: createElement("textarea", { "aria-label": "主区", defaultValue: "原答" }) }));
  }
  const control = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "工具")!;
  const tab = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === label)!;
  async function click(button: HTMLButtonElement) { await act(async () => button.click()); }

  it("has one entry and retains visited draft/main identity across close, tab changes and narrow layout", async () => {
    const mount = vi.fn(); await act(async () => root.render(setup(mount)));
    expect([...host.querySelectorAll('button')].filter(button => !button.closest('[hidden]')).map(button => button.textContent)).toEqual(["工具"]);
    const main = host.querySelector<HTMLTextAreaElement>('[aria-label="主区"]')!; main.value = "写到一半";
    await click(control());
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="对话草稿"]')!; draft.value = "未发送";
    await click(tab("笔记")); expect(state.pref.split).toEqual(["notes"]);
    await click(control()); expect(state.pref.split).toEqual([]);
    await click(control()); expect(state.pref.split).toEqual(["notes"]);
    await click(tab("对话"));
    expect(host.querySelector('[aria-label="对话草稿"]')).toBe(draft); expect(draft.value).toBe("未发送");
    await act(async () => { state.wide = false; state.mediaListeners.forEach(callback => callback()); });
    expect(host.querySelector('[aria-label="主区"]')).toBe(main); expect(main.value).toBe("写到一半");
    expect(host.querySelector('[aria-label="对话草稿"]')).toBe(draft);
    await click(control()); await click(control());
    expect(host.querySelector('[aria-label="对话草稿"]')).toBe(draft);
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it("uses one preference source for keyboard selection, protects IME and restores the last available tab", async () => {
    await act(async () => root.render(setup())); await click(control());
    const chat = tab("对话");
    await act(async () => chat.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, isComposing: true })));
    expect(state.pref.split).toEqual(["assistant"]);
    await act(async () => chat.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(state.pref.split).toEqual(["notes"]); expect(document.activeElement).toBe(tab("笔记"));
    await act(async () => tab("笔记").dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
    expect(state.pref.split).toEqual(["sources"]);
    await act(async () => tab("资料").dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true })));
    expect(state.pref.split).toEqual(["assistant"]);
    await click(tab("笔记"));
    await click(control()); await act(async () => root.render(null));
    await act(async () => root.render(setup())); await click(control());
    expect(state.pref.split).toEqual(["notes"]);
  });

  it("leaves Escape to IME and nested dialogs, then closes and returns focus to its opener", async () => {
    await act(async () => root.render(setup())); control().focus(); await click(control());
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true })));
    expect(state.pref.split).toEqual(["assistant"]);
    const nested = document.createElement("dialog"); nested.setAttribute("open", ""); host.append(nested);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(state.pref.split).toEqual(["assistant"]); nested.remove();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(state.pref.split).toEqual([]); expect(document.activeElement).toBe(control());
  });

  it("ignores an unavailable remembered pane without changing the stored layout schema", async () => {
    window.localStorage.setItem("aistudy.split.last-pane", "removed-tool");
    await act(async () => root.render(setup())); await click(control());
    expect(state.pref.split).toEqual(["assistant"]);
  });

  it("suspends for a ready teaching workspace without discarding the previous tool or its draft", async () => {
    const mount = vi.fn(); await act(async () => root.render(setup(mount)));
    await click(control()); await click(tab("笔记"));
    const draft = host.querySelector<HTMLTextAreaElement>('[aria-label="笔记草稿"]')!; draft.value = "加载课堂前的笔记";
    const selected = state.pref.split;
    await act(async () => root.render(setup(mount, true)));
    expect(host.querySelector('section[aria-label="学习工具"]')?.hasAttribute("hidden")).toBe(true);
    expect(host.querySelector('[aria-label="笔记草稿"]')).toBe(draft);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(state.pref.split).toBe(selected);
    await act(async () => tab("笔记").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    expect(state.pref.split).toBe(selected);
    await act(async () => root.render(setup(mount)));
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe("笔记");
    expect(host.querySelector('[aria-label="笔记草稿"]')).toBe(draft);
    expect(draft.value).toBe("加载课堂前的笔记");
    expect(mount).toHaveBeenCalledTimes(2);
  });

  it("mounts and toggles the real resizable Group on narrow screens with a browser ResizeObserver", async () => {
    state.realResize = true; state.wide = false;
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
    await act(async () => root.render(setup()));
    const main = host.querySelector('[aria-label="主区"]');
    await click(control()); await click(control());
    expect(host.querySelector('[aria-label="主区"]')).toBe(main);
    await act(async () => { state.wide = true; state.mediaListeners.forEach(callback => callback()); });
    await click(control());
    expect(host.querySelector('[aria-label="主区"]')).toBe(main);
    await act(async () => root.render(setup(undefined, true)));
    await act(async () => root.render(setup(undefined, true, { restoring: true })));
    expect(main?.closest("[hidden][inert]")).not.toBeNull();
    expect(host.querySelector('[aria-label="主区"]')).toBe(main);
  });

  it("restores only the pane captured before suspension and returns to teaching without changing preferences", async () => {
    const mount = vi.fn(), available = vi.fn(), close = vi.fn();
    await act(async () => root.render(setup(mount)));
    await click(control()); await click(tab("笔记"));
    const chat = host.querySelector<HTMLTextAreaElement>('[aria-label="对话草稿"]')!;
    const note = host.querySelector<HTMLTextAreaElement>('[aria-label="笔记草稿"]')!;
    note.value = "上课前的笔记"; chat.value = "上课前的问题";
    const main = host.querySelector('[aria-label="主区"]')!;
    const extra = { onSuspendedPaneAvailable: available, onRestoreClose: close };
    await act(async () => root.render(setup(mount, true, extra)));
    expect(available).toHaveBeenLastCalledWith(true);
    await act(async () => { state.pref = { ...state.pref, split: ["sources"] }; state.listeners.forEach(callback => callback()); });
    const prefs = state.pref.split;
    await act(async () => root.render(setup(mount, true, { ...extra, restoring: true })));
    expect([...host.querySelectorAll('[role="tab"]')].map(item => item.textContent)).toEqual(["笔记"]);
    expect(main.closest("[hidden][inert]")).not.toBeNull();
    expect(host.querySelector('[aria-label="笔记草稿"]')).toBe(note);
    expect(host.querySelector('[aria-label="对话草稿"]')).toBe(chat);
    expect(host.querySelector('[aria-label="资料选择"]')).toBeNull();
    await act(async () => tab("笔记").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await click(host.querySelector<HTMLButtonElement>('[aria-label="关闭学习工具"]')!);
    expect(close).toHaveBeenCalledOnce(); expect(state.pref.split).toBe(prefs);
    await act(async () => root.render(setup(mount, true, extra)));
    expect(main.closest("[hidden]")).toBeNull();
    expect(note.value).toBe("上课前的笔记"); expect(chat.value).toBe("上课前的问题"); expect(mount).toHaveBeenCalledTimes(2);
  });

  it("does not invent a suspended pane from a later global preference", async () => {
    const available = vi.fn();
    await act(async () => root.render(setup()));
    await act(async () => root.render(setup(undefined, true, { onSuspendedPaneAvailable: available })));
    await act(async () => { state.pref = { ...state.pref, split: ["assistant"] }; state.listeners.forEach(callback => callback()); });
    await act(async () => root.render(setup(undefined, true, { restoring: true, onSuspendedPaneAvailable: available })));
    expect(available).toHaveBeenLastCalledWith(false);
    expect(host.querySelector('[aria-label="对话草稿"]')).toBeNull();
    expect(host.querySelector('section[aria-label="学习工具"]')?.hasAttribute("hidden")).toBe(true);
  });

  it("lets the visible restored tool own Escape while the hidden teaching dialog keeps its selection", async () => {
    const close = vi.fn();
    function Nested({ suspended = false, restoring = false }) {
      const [inner, setInner] = useState<string | null>("sources");
      return createElement(SplitView, { suspended, restoring, onRestoreClose: close,
        panes: { notes: { label: "课前笔记", icon: null, render: () => createElement("textarea", { "aria-label": "课前草稿" }) } },
        children: createElement(StudyToolsPanel, { activePanel: inner, onPanelChange: setInner,
          panels: [{ id: "chat", label: "对话", content: "对话草稿" }, { id: "sources", label: "资料", content: "当前资料" }],
          children: createElement("output", { "data-inner-selection": true }, inner) }),
      });
    }
    state.pref = { ...state.pref, split: ["notes"] };
    await act(async () => root.render(createElement(Nested)));
    await act(async () => root.render(createElement(Nested, { suspended: true })));
    await act(async () => root.render(createElement(Nested, { suspended: true, restoring: true })));
    const innerDialog = host.querySelector<HTMLDialogElement>('dialog[data-study-companion]')!;
    expect(innerDialog.open).toBe(true);
    expect(innerDialog.closest("[hidden][inert]")).not.toBeNull();
    const visibleModal = document.createElement("dialog"); visibleModal.setAttribute("open", ""); host.append(visibleModal);
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(close).not.toHaveBeenCalled(); visibleModal.remove();
    await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
    expect(close).toHaveBeenCalledOnce();
    expect(host.querySelector("[data-inner-selection]")?.textContent).toBe("sources");
    expect(innerDialog.open).toBe(true);
  });
});

describe("layout preference", () => {
  it("clamps nav width and repairs stored values", () => {
    expect(clampNavWidth(100)).toBe(NAV_WIDTH_MIN);
    expect(clampNavWidth(999)).toBe(NAV_WIDTH_MAX);
    expect(clampNavWidth(Number.NaN)).toBe(NAV_WIDTH_DEFAULT);
    const pref = normalizeLayoutPref({ skin: "neon" as never, navWidth: 9000, split: ["assistant", "assistant", "bogus" as never, "notes", "sources"], splitLayouts: { ok: { main: 70, assistant: 30 }, bad: { main: 400 } } });
    expect(pref.skin).toBe("frost");
    expect(pref.navWidth).toBe(NAV_WIDTH_MAX);
    expect(pref.split).toEqual(["assistant", "notes"]);
    expect(Object.keys(pref.splitLayouts)).toEqual(["ok"]);
  });
  it("defaults to light glass and the narrower nav", () => {
    const pref = normalizeLayoutPref({});
    expect(pref.skin).toBe("frost");
    expect(pref.navWidth).toBe(208);
    expect(pref.split).toEqual([]);
  });
});
