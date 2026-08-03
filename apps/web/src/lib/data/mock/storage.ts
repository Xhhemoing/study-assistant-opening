export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function mockKey(userId: string, domain: string): string {
  return `aistudy:mock:v1:${userId}:${domain}`;
}

export function loadDomain<T>(storage: StorageLike, userId: string, domain: string, fallback: T): T {
  const raw = storage.getItem(mockKey(userId, domain));
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function saveDomain<T>(storage: StorageLike, userId: string, domain: string, value: T): void {
  storage.setItem(mockKey(userId, domain), JSON.stringify(value));
}

export function resetDomains(storage: StorageLike, userId: string, domains: string[]): void {
  for (const domain of domains) {
    storage.removeItem(mockKey(userId, domain));
  }
}

export function browserStorage(): StorageLike {
  if (typeof window === "undefined" || !window.localStorage) {
    throw new Error("browserStorage 只能在浏览器环境中使用");
  }
  return window.localStorage;
}
