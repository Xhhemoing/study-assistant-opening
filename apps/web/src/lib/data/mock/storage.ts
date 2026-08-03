export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function mockKey(userId: string, domain: string): string {
  return `aistudy:mock:v1:${userId}:${domain}`;
}

export function loadDomain<T>(storage: StorageLike, userId: string, domain: string, fallback: T): T {
  const key = mockKey(userId, domain);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return fallback;
  }
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    try {
      storage.removeItem(key);
    } catch {
      // A storage failure should not prevent the fallback path.
    }
    return fallback;
  }
}

const volatileValues = new Map<string, string>();
const volatileStorage: StorageLike = {
  getItem: (key) => volatileValues.get(key) ?? null,
  setItem: (key, value) => volatileValues.set(key, value),
  removeItem: (key) => volatileValues.delete(key),
};

export function saveDomain<T>(storage: StorageLike, userId: string, domain: string, value: T): void {
  storage.setItem(mockKey(userId, domain), JSON.stringify(value));
}

export function resetDomains(storage: StorageLike, userId: string, domains: string[]): void {
  for (const domain of domains) {
    storage.removeItem(mockKey(userId, domain));
  }
}

export function browserStorage(): StorageLike {
  if (typeof window === "undefined") return volatileStorage;
  try {
    if (!window.localStorage) return volatileStorage;
    window.localStorage.getItem("aistudy:storage:probe");
    return window.localStorage;
  } catch {
    return volatileStorage;
  }
}
