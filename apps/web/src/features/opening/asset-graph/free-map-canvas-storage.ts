import type { SessionIdentity } from "../../auth/session-identity";
import type { MapPoint } from "./free-map-canvas-geometry";

/**
 * Isolate persisted FreeMapCanvas geometry strictly by `userId:workspaceId:contextKey`.
 * Returns `undefined` when verified identity is unavailable so anonymous/unverified sessions never leak or share layout keys.
 */
export function buildFreeMapPersistKey(
  identity: SessionIdentity | null,
  contextKey: string,
): string | undefined {
  if (!identity || !identity.id || !identity.workspaceId || !contextKey) {
    return undefined;
  }
  return `${identity.id}:${identity.workspaceId}:${contextKey}`;
}

export function freeMapStorageKey(persistKey: string | undefined): string | null {
  return persistKey ? `aistudy/free-map/geometry/${encodeURIComponent(persistKey)}` : null;
}

/** localStorage is an untrusted boundary. Retain finite numeric coordinates only, never captions or study evidence. */
export function decodeFreeMapPositions(raw: string | null): Record<string, MapPoint> {
  if (!raw || raw.length > 2_000_000) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).flatMap(([id, point]) => {
        if (!point || typeof point !== "object" || Array.isArray(point)) return [];
        const { x, y } = point as Record<string, unknown>;
        return typeof x === "number" &&
          typeof y === "number" &&
          Number.isFinite(x) &&
          Number.isFinite(y) &&
          Math.abs(x) <= 10_000_000 &&
          Math.abs(y) <= 10_000_000
          ? [[id, { x, y }]]
          : [];
      }),
    );
  } catch {
    return {};
  }
}

function getSafeLocalStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readFreeMapStorage(key: string): { ok: boolean; positions: Record<string, MapPoint> } {
  const storage = getSafeLocalStorage();
  if (!storage) return { ok: false, positions: {} };
  try {
    return { ok: true, positions: decodeFreeMapPositions(storage.getItem(key)) };
  } catch {
    return { ok: false, positions: {} };
  }
}

export function writeFreeMapStorage(
  key: string,
  positions: Readonly<Record<string, MapPoint>>,
): boolean {
  const storage = getSafeLocalStorage();
  if (!storage) return false;
  const sanitized: Record<string, MapPoint> = {};
  for (const [id, point] of Object.entries(positions)) {
    if (
      point &&
      typeof point.x === "number" &&
      typeof point.y === "number" &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y) &&
      Math.abs(point.x) <= 10_000_000 &&
      Math.abs(point.y) <= 10_000_000
    ) {
      sanitized[id] = { x: point.x, y: point.y };
    }
  }
  try {
    storage.setItem(key, JSON.stringify(sanitized));
    return true;
  } catch {
    return false;
  }
}

export function removeFreeMapStorage(key: string): boolean {
  const storage = getSafeLocalStorage();
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
