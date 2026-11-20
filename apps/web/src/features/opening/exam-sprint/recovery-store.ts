const limit = 32;
const scopes = new Map<string, Map<string, string>>();

function restore(scope: string): Map<string, string> {
  const entries = new Map<string, string>();
  try {
    const saved: unknown = JSON.parse(window.sessionStorage.getItem(scope) ?? "[]");
    if (Array.isArray(saved)) {
      for (const entry of saved.slice(-limit)) {
        if (Array.isArray(entry) && typeof entry[0] === "string" && /^[a-f0-9]{64}$/.test(entry[0])
          && typeof entry[1] === "string" && entry[1].length >= 8 && entry[1].length <= 200) {
          entries.set(entry[0], entry[1]);
        }
      }
    }
  } catch { /* Storage may be disabled or corrupt. */ }
  return entries;
}

export function sprintRecoveryStore(workspaceId?: string, courseId?: string) {
  const scope = workspaceId || courseId ? `aistudy:sprint-recovery:${JSON.stringify([workspaceId ?? null, courseId ?? null])}` : null;
  const entries = scope ? scopes.get(scope) ?? restore(scope) : new Map<string, string>();
  if (scope) scopes.set(scope, entries);

  function save() {
    if (!scope) return;
    try {
      if (entries.size) window.sessionStorage.setItem(scope, JSON.stringify([...entries]));
      else window.sessionStorage.removeItem(scope);
    } catch { /* The in-memory entries survive component remounts. */ }
  }

  return {
    get(fingerprint: string) { return entries.get(fingerprint); },
    remember(fingerprint: string, key: string) {
      entries.delete(fingerprint);
      entries.set(fingerprint, key);
      if (entries.size > limit) entries.delete(entries.keys().next().value!);
      save();
    },
    confirm(fingerprint: string, key: string) {
      if (entries.get(fingerprint) === key) {
        entries.delete(fingerprint);
        save();
      }
    },
  };
}
