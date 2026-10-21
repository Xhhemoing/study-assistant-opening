import { z } from "zod";
import { getVerifiedSessionNamespace } from "../../auth/session-identity";
const schema = z.object({ version: z.literal(1), text: z.string().max(20000) });
type DraftStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type DraftMemory = { values: Map<string, string | null>; unavailable: boolean };
const memories = new WeakMap<object, Map<string, DraftMemory>>();
function sessionStorageIfAvailable(): DraftStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}
export function createQuestionDraftStore(storage: DraftStorage | undefined = sessionStorageIfAvailable()) {
  // Capture ownership once: a late callback from A must never start writing B's draft.
  const namespace = getVerifiedSessionNamespace();
  const owner = storage ?? (typeof window === "undefined" ? undefined : window);
  const partitions = owner && namespace ? memories.get(owner) ?? new Map<string, DraftMemory>() : undefined;
  const state = (namespace ? partitions?.get(namespace) : undefined) ?? { values: new Map<string, string | null>(), unavailable: !storage || !namespace };
  if (owner && namespace && partitions) {
    partitions.set(namespace, state);
    memories.set(owner, partitions);
  }
  // Unowned legacy keys stay untouched; they cannot safely be assigned to the next login.
  const key = (scope: string) => `opening:question-draft:v2:${encodeURIComponent(namespace ?? "")}:${scope}`;
  const remove = (scope: string) => {
    // Keep a tombstone even if deleting the older persisted text fails.
    state.values.set(scope, null);
    try { if (namespace) storage?.removeItem(key(scope)); } catch { state.unavailable = true; }
  };
  return {
    get unavailable(): boolean { return state.unavailable; },
    read(scope: string): string | null {
      if (state.values.has(scope)) return state.values.get(scope) ?? null;
      if (!namespace) return null;
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
      try { if (namespace) storage?.setItem(key(scope), JSON.stringify({ version: 1, text })); }
      catch { state.unavailable = true; }
    },
    remove,
  };
}
