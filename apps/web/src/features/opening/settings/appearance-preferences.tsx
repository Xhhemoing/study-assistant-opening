"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

export type AppearancePreferences = {
  theme: "system" | "light" | "dark";
  readingFont: "serif" | "sans";
  motion: "system" | "reduce";
  diagnostics: boolean;
};

export const appearanceStorageKey = "aistudy.appearance.v1";
const defaultPreferences: AppearancePreferences = { theme: "system", readingFont: "serif", motion: "system", diagnostics: false };
type AppearanceState = { preferences: AppearancePreferences; hydrated: boolean; persistenceError: boolean };
type AppearanceContextValue = AppearanceState & { resolvedTheme: "light" | "dark"; updatePreferences: (patch: Partial<AppearancePreferences>) => void };
const initialState: AppearanceState = { preferences: defaultPreferences, hydrated: false, persistenceError: false };
const AppearanceContext = createContext<AppearanceContextValue>({ ...initialState, resolvedTheme: "light", updatePreferences: () => {} });

function readPreferences(raw: string | null, defaults: AppearancePreferences): AppearancePreferences {
  if (!raw) return defaults;
  try {
    const data: unknown = JSON.parse(raw);
    if (typeof data !== "object" || data === null || !("version" in data) || data.version !== 1 || !("preferences" in data)) return defaults;
    const value = data.preferences;
    if (typeof value !== "object" || value === null) return defaults;
    return {
      theme: "theme" in value && (value.theme === "light" || value.theme === "dark" || value.theme === "system") ? value.theme : defaults.theme,
      readingFont: "readingFont" in value && (value.readingFont === "serif" || value.readingFont === "sans") ? value.readingFont : defaults.readingFont,
      motion: "motion" in value && (value.motion === "system" || value.motion === "reduce") ? value.motion : defaults.motion,
      diagnostics: "diagnostics" in value && typeof value.diagnostics === "boolean" ? value.diagnostics : false,
    };
  } catch {
    return defaults;
  }
}

/** Local display choices only; workspace learning preferences retain their server API. */
export function AppearancePreferencesProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppearanceState>(initialState);
  const [system, setSystem] = useState({ dark: false, reduce: false });
  const current = useRef<AppearancePreferences | null>(null);

  useEffect(() => {
    const defaults: AppearancePreferences = { ...defaultPreferences, readingFont: /Win/i.test(navigator.platform) ? "sans" : "serif" };
    let storage: Storage | null = null;
    let preferences = defaults;
    let persistenceError = false;
    try {
      storage = window.localStorage;
      preferences = readPreferences(storage.getItem(appearanceStorageKey), defaults);
    } catch {
      persistenceError = true;
    }
    current.current = preferences;
    setState({ preferences, hydrated: true, persistenceError });

    const dark = window.matchMedia("(prefers-color-scheme: dark)");
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const syncSystem = () => setSystem({ dark: dark.matches, reduce: reduce.matches });
    syncSystem();
    dark.addEventListener("change", syncSystem);
    reduce.addEventListener("change", syncSystem);
    const syncStorage = (event: StorageEvent) => {
      if (!storage || event.storageArea !== storage || (event.key !== null && event.key !== appearanceStorageKey)) return;
      const next = readPreferences(event.newValue, defaults);
      current.current = next;
      setState({ preferences: next, hydrated: true, persistenceError: false });
    };
    window.addEventListener("storage", syncStorage);
    return () => {
      current.current = null;
      dark.removeEventListener("change", syncSystem);
      reduce.removeEventListener("change", syncSystem);
      window.removeEventListener("storage", syncStorage);
    };
  }, []);

  useEffect(() => {
    if (!state.hydrated) return;
    const root = document.documentElement;
    const attributes = {
      "data-theme": state.preferences.theme === "system" ? (system.dark ? "dark" : "light") : state.preferences.theme,
      "data-reading-font": state.preferences.readingFont,
      "data-motion": state.preferences.motion === "reduce" || system.reduce ? "reduce" : "full",
    };
    const previous = Object.keys(attributes).map(key => [key, root.getAttribute(key)] as const);
    Object.entries(attributes).forEach(([key, value]) => root.setAttribute(key, value));
    return () => previous.forEach(([key, value]) => value === null ? root.removeAttribute(key) : root.setAttribute(key, value));
  }, [state.hydrated, state.preferences, system]);

  const updatePreferences = useCallback((patch: Partial<AppearancePreferences>) => {
    if (!current.current) return;
    const preferences = { ...current.current, ...patch };
    current.current = preferences;
    let persistenceError = false;
    try {
      window.localStorage.setItem(appearanceStorageKey, JSON.stringify({ version: 1, preferences }));
    } catch {
      persistenceError = true;
    }
    setState({ preferences, hydrated: true, persistenceError });
  }, []);

  return <AppearanceContext.Provider value={{ ...state, resolvedTheme: state.preferences.theme === "system" ? (system.dark ? "dark" : "light") : state.preferences.theme, updatePreferences }}>{children}</AppearanceContext.Provider>;
}

export function useAppearancePreferences() {
  return useContext(AppearanceContext);
}

export function useDiagnosticsEnabled() {
  const { hydrated, preferences } = useAppearancePreferences();
  return hydrated && preferences.diagnostics;
}
