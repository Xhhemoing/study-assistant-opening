import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearancePreferencesProvider, appearanceStorageKey, useDiagnosticsEnabled, type AppearancePreferences } from "./appearance-preferences";
import { AppearanceSettings } from "./appearance-settings";

type Effect = { deps: unknown[]; cleanup?: () => void };
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, pending: [] as Array<() => void>, effectSlots: new Set<number>() }));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useState: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = initial;
    return [hooks.slots[index], (value: T) => { hooks.slots[index] = value; }];
  },
  useRef: <T,>(initial: T) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = { current: initial };
    return hooks.slots[index];
  },
  useCallback: (callback: unknown) => callback,
  useEffect: (effect: () => (() => void) | undefined, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.slots[index] as Effect | undefined;
    if (previous && deps.length === previous.deps.length && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const next: Effect = { deps };
    hooks.slots[index] = next;
    hooks.effectSlots.add(index);
    hooks.pending.push(() => { previous?.cleanup?.(); next.cleanup = effect(); });
  },
}));

type Value = { preferences: AppearancePreferences; hydrated: boolean; persistenceError: boolean; updatePreferences: (patch: Partial<AppearancePreferences>) => void };
type ProviderTree = ReactElement<{ value: Value }>;
class MediaQuery extends EventTarget {
  matches = false;
  change(matches: boolean) { this.matches = matches; this.dispatchEvent(new Event("change")); }
}
let values: Map<string, string>;
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> };
let surface: EventTarget;
let attrs: Map<string, string>;
let dark: MediaQuery;
let reduce: MediaQuery;
const defaults: AppearancePreferences = { theme: "system", readingFont: "serif", motion: "system", diagnostics: false };
function DiagnosticsProbe() { return createElement("output", null, useDiagnosticsEnabled() ? "diagnostics-on" : "diagnostics-off"); }
function render(children = createElement(DiagnosticsProbe)): ProviderTree {
  hooks.cursor = 0;
  hooks.pending = [];
  return AppearancePreferencesProvider({ children }) as ProviderTree;
}
function commit() { const pending = hooks.pending; hooks.pending = []; pending.forEach(effect => effect()); }
function refresh() { const tree = render(); commit(); return tree; }
function mount() { refresh(); return refresh(); }
function save(preferences: Partial<AppearancePreferences>) { values.set(appearanceStorageKey, JSON.stringify({ version: 1, preferences: { ...defaults, ...preferences } })); }
function update(preferences: Partial<AppearancePreferences>) { render().props.value.updatePreferences(preferences); return refresh(); }
function emitStorage(key: string | null, newValue: string | null, area: unknown = storage) {
  surface.dispatchEvent(Object.assign(new Event("storage"), { key, newValue, storageArea: area }));
}

beforeEach(() => {
  hooks.slots = []; hooks.cursor = 0; hooks.pending = []; hooks.effectSlots.clear();
  values = new Map(); attrs = new Map();
  storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => { values.set(key, value); }) };
  dark = new MediaQuery(); reduce = new MediaQuery();
  surface = Object.assign(new EventTarget(), { localStorage: storage, matchMedia: (query: string) => query.includes("color-scheme") ? dark : reduce });
  vi.stubGlobal("window", surface);
  vi.stubGlobal("navigator", { platform: "MacIntel" });
  vi.stubGlobal("document", { documentElement: {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => { attrs.set(name, value); },
    removeAttribute: (name: string) => { attrs.delete(name); },
  } });
});
afterEach(() => {
  hooks.effectSlots.forEach(index => (hooks.slots[index] as Effect).cleanup?.());
  vi.unstubAllGlobals();
});

describe("local appearance preferences", () => {
  it("renders deterministic disabled settings and hides diagnostics before hydration without accessing storage", () => {
    save({ diagnostics: true, theme: "dark" });
    const tree = render();
    expect(tree.props.value.hydrated).toBe(false);
    expect(renderToStaticMarkup(tree)).toContain("diagnostics-off");
    const settings = renderToStaticMarkup(render(createElement(AppearanceSettings)));
    expect(settings).toContain('id="appearance"');
    expect(settings.match(/ disabled=""/g)).toHaveLength(4);
    expect(settings).not.toContain('checked=""');
    expect(storage.getItem).not.toHaveBeenCalled();
    tree.props.value.updatePreferences({ theme: "light" });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(attrs.size).toBe(0);
  });

  it("restores validated choices after hydration without overwriting stored values", () => {
    save({ theme: "dark", readingFont: "sans", motion: "reduce", diagnostics: true });
    const tree = mount();
    expect(tree.props.value).toMatchObject({ hydrated: true, persistenceError: false, preferences: { theme: "dark", readingFont: "sans", motion: "reduce", diagnostics: true } });
    expect(Object.fromEntries(attrs)).toEqual({ "data-theme": "dark", "data-reading-font": "sans", "data-motion": "reduce" });
    expect(renderToStaticMarkup(tree)).toContain("diagnostics-on");
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each(["{broken", "null", "[]", JSON.stringify({ version: 2, preferences: { diagnostics: true } }), JSON.stringify({ version: 1, preferences: { theme: "invalid", readingFont: "script", motion: "full", diagnostics: "true" } })])("falls back safely for untrusted persisted input %s", raw => {
    values.set(appearanceStorageKey, raw);
    expect(mount().props.value.preferences).toEqual(defaults);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("uses the reading serif on every platform while preserving an explicit font choice", () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    expect(mount().props.value.preferences.readingFont).toBe("serif");
    emitStorage(appearanceStorageKey, JSON.stringify({ version: 1, preferences: { ...defaults, readingFont: "sans" } }));
    expect(refresh().props.value.preferences.readingFont).toBe("sans");
  });

  it("tracks OS preferences and preserves explicit theme and reduced motion choices", () => {
    dark.matches = true; reduce.matches = true;
    mount();
    expect(attrs.get("data-theme")).toBe("dark");
    expect(attrs.get("data-motion")).toBe("reduce");
    dark.change(false); reduce.change(false); refresh();
    expect(attrs.get("data-theme")).toBe("light");
    expect(attrs.get("data-motion")).toBe("full");
    update({ theme: "light", motion: "reduce" });
    dark.change(true); refresh();
    expect(attrs.get("data-theme")).toBe("light");
    expect(attrs.get("data-motion")).toBe("reduce");
    update({ theme: "system", motion: "system" });
    expect(attrs.get("data-theme")).toBe("dark");
    expect(attrs.get("data-motion")).toBe("full");
  });

  it("merges immediate successive changes without losing the previous preference", () => {
    const { updatePreferences } = mount().props.value;
    updatePreferences({ theme: "dark" });
    updatePreferences({ diagnostics: true });
    expect(refresh().props.value.preferences).toEqual({ ...defaults, theme: "dark", diagnostics: true });
    expect(JSON.parse(values.get(appearanceStorageKey)!)).toEqual({ version: 1, preferences: { ...defaults, theme: "dark", diagnostics: true } });
  });

  it("keeps settings usable when reading or writing local storage is denied", () => {
    Object.defineProperty(surface, "localStorage", { get() { throw new Error("denied"); } });
    expect(mount().props.value.persistenceError).toBe(true);
    const tree = update({ theme: "dark", diagnostics: true });
    expect(tree.props.value.preferences).toMatchObject({ theme: "dark", diagnostics: true });
    expect(attrs.get("data-theme")).toBe("dark");
    expect(renderToStaticMarkup(render(createElement(AppearanceSettings)))).toContain("更改仅在当前页面生效");
  });

  it("reports quota failure and clears the warning after the next successful save", () => {
    mount();
    storage.setItem.mockImplementationOnce(() => { throw new Error("quota"); });
    expect(update({ readingFont: "sans" }).props.value.persistenceError).toBe(true);
    expect(attrs.get("data-reading-font")).toBe("sans");
    expect(update({ diagnostics: true }).props.value.persistenceError).toBe(false);
    expect(JSON.parse(values.get(appearanceStorageKey)!).preferences.readingFont).toBe("sans");
  });

  it("syncs other tabs without writing back and ignores unrelated storage changes", () => {
    mount();
    const incoming = JSON.stringify({ version: 1, preferences: { ...defaults, diagnostics: true, theme: "dark" } });
    emitStorage("another-key", incoming);
    emitStorage(appearanceStorageKey, incoming, {});
    expect(refresh().props.value.preferences).toEqual(defaults);
    emitStorage(appearanceStorageKey, incoming);
    expect(refresh().props.value.preferences.diagnostics).toBe(true);
    expect(attrs.get("data-theme")).toBe("dark");
    emitStorage(null, null);
    expect(refresh().props.value.preferences).toEqual(defaults);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it("removes listeners and restores root attributes when the provider unmounts", () => {
    attrs.set("data-theme", "previous");
    const tree = mount();
    hooks.effectSlots.forEach(index => (hooks.slots[index] as Effect).cleanup?.());
    hooks.effectSlots.clear();
    const previousSystem = hooks.slots[1];
    dark.change(true); reduce.change(true);
    expect(hooks.slots[1]).toBe(previousSystem);
    emitStorage(appearanceStorageKey, JSON.stringify({ version: 1, preferences: { ...defaults, diagnostics: true } }));
    expect(render().props.value.preferences.diagnostics).toBe(false);
    tree.props.value.updatePreferences({ diagnostics: true });
    expect(storage.setItem).not.toHaveBeenCalled();
    expect(Object.fromEntries(attrs)).toEqual({ "data-theme": "previous" });
  });
});
