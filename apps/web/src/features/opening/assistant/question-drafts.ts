import { z } from "zod";
const schema = z.object({ version: z.literal(1), text: z.string().max(20000) });
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DraftMemory = { values: Map<string, string | null>; unavailable: boolean };
const memories = new WeakMap<DraftStorage, DraftMemory>();
const unavailableMemory: DraftMemory = { values: new Map(), unavailable: true };
function sessionStorageIfAvailable(): DraftStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}
export function createQuestionDraftStore(storage: DraftStorage | undefined = sessionStorageIfAvailable()) {
  let memory = storage ? memories.get(storage) : unavailableMemory;
  if (!memory) {
    memory = { values: new Map(), unavailable: false };
    memories.set(storage!, memory);
  }
  const state = memory;
  const key = (scope: string) => `opening:question-draft:${scope}`;
  const remove = (scope: string) => {
    // Keep a tombstone even if deleting the older persisted text fails.
    state.values.set(scope, null);
    try { storage?.removeItem(key(scope)); } catch { state.unavailable = true; }
  };
  return {
    get unavailable(): boolean { return state.unavailable; },
    read(scope: string): string | null {
      if (state.values.has(scope)) return state.values.get(scope) ?? null;
      try {
        const raw = storage?.getItem(key(scope));
        const value = raw ? schema.safeParse(JSON.parse(raw)) : null;
        const text = value?.success ? value.data.text : null;
        state.values.set(scope, text);
        return text;
      } catch { state.unavailable = true; return null; }
    },
    write(scope: string, text: string): void {
      if (!text.trim() || text.length > 20000) { remove(scope); return; }
      // Memory is authoritative within this document, including after a quota error.
      state.values.set(scope, text);
      try { storage?.setItem(key(scope), JSON.stringify({ version: 1, text })); }
      catch { state.unavailable = true; }
    },
    remove,
  };
}
