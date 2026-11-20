export const PAPER_REVIEW_STORAGE_PREFIX = "aistudy:paper-review:v1";
export const FREE_MAP_STORAGE_PREFIX = "aistudy/free-map/geometry/";
export const SERIES_CHECK_KEY = "aistudy-series-example-comparison-check-v1";

const cleanupListeners = new Set<() => void>();

export function registerOpeningPrivacyCleanup(cleanup: () => void): void {
  cleanupListeners.add(cleanup);
}

function clearStorage(kind: "sessionStorage" | "localStorage", prefixes: readonly string[]) {
  try {
    const storage = window[kind];
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key && prefixes.some(prefix => key.startsWith(prefix))) storage.removeItem(key);
    }
  } catch {
    // Browser storage can be unavailable.
  }
}

const channelName = "aistudy:opening-privacy-change";
const signal = "changed";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function publishLocally() {
  if (typeof window !== "undefined") {
    clearStorage("sessionStorage", [`${PAPER_REVIEW_STORAGE_PREFIX}:`]);
    clearStorage("localStorage", [FREE_MAP_STORAGE_PREFIX, SERIES_CHECK_KEY]);
  }
  for (const cleanup of cleanupListeners) cleanup();
  for (const listener of listeners) listener();
}
function connect() {
  if (channel || typeof window === "undefined" || typeof window.BroadcastChannel !== "function") return;
  try {
    const opened = new window.BroadcastChannel(channelName);
    opened.onmessage = event => { if (channel === opened && event.data === signal) publishLocally(); };
    channel = opened;
  } catch {
    // Some browser contexts deny this transport; same-page invalidation still works.
  }
}
function disconnect() {
  if (channel) { channel.onmessage = null; channel.close(); channel = null; }
}

/** A content-free hint, never authorization. The server remains the privacy authority. */
export function notifyOpeningPrivacyChange() {
  publishLocally();
  connect();
  try { channel?.postMessage(signal); }
  catch { /* Optional cross-tab delivery must not turn a committed action into a failure. */ }
  finally { if (listeners.size === 0) disconnect(); }
}

/** Same-page always; other same-origin tabs only where BroadcastChannel is available. */
export function subscribeOpeningPrivacyChange(listener: () => void): () => void {
  const subscription = () => listener();
  listeners.add(subscription);
  connect();
  return () => {
    listeners.delete(subscription);
    if (listeners.size === 0) disconnect();
  };
}
