const limit = 32;
type RecoveryEntry = { key: string; protected: boolean };
const scopes = new Map<string, Map<string, RecoveryEntry>>();

function restore(scope: string): Map<string, RecoveryEntry> {
  const entries = new Map<string, RecoveryEntry>();
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(scope) ?? "[]");
    if (Array.isArray(saved)) {
      for (const entry of saved.slice(-limit)) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && /^[a-f0-9]{64}$/.test(entry[0])
          && typeof entry[1] === "string" && entry[1].length >= 8 && entry[1].length <= 200) {
          // A persisted key may represent a request whose response was lost.
          // Keep it protected until the server confirms the operation.
          entries.set(entry[0], { key: entry[1], protected: true });
        }
      }
    }
  } catch { /* Storage may be disabled or corrupt. */ }
  return entries;
}

export function sprintRecoveryStore(workspaceId?: string, courseId?: string) {
  const scope = workspaceId || courseId ? `aistudy:sprint-recovery:${JSON.stringify([workspaceId ?? null, courseId ?? null])}` : null;
  const entries = scope ? scopes.get(scope) ?? restore(scope) : new Map<string, RecoveryEntry>();
  if (scope) scopes.set(scope, entries);

  function save() {
    if (!scope) return;
    try {
      if (entries.size) window.sessionStorage.setItem(scope, JSON.stringify([...entries].map(([fingerprint, entry]) => [fingerprint, entry.key])));
      else window.sessionStorage.removeItem(scope);
    } catch { /* The in-memory entries survive component remounts. */ }
  }

  return {
    get(fingerprint: string) { return entries.get(fingerprint)?.key; },
    remember(fingerprint: string, key: string, options: { protected?: boolean } = {}) {
      const previous = entries.get(fingerprint);
      entries.delete(fingerprint);
      entries.set(fingerprint, { key, protected: previous?.protected === true || options.protected === true });
      while (entries.size > limit) {
        const evictable = [...entries.entries()].find(([, entry]) => !entry.protected)?.[0];
        if (!evictable) break;
        entries.delete(evictable);
      }
      save();
    },
    protect(fingerprint: string, key: string) {
      const entry = entries.get(fingerprint);
      if (entry?.key === key && !entry.protected) {
        entry.protected = true;
        save();
      }
    },
    confirm(fingerprint: string, key: string) {
      if (entries.get(fingerprint)?.key === key) {
        entries.delete(fingerprint);
        save();
      }
    },
  };
}
