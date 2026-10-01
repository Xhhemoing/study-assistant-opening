const channelName = "aistudy:opening-privacy-change";
const signal = "changed";
const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function publishLocally() { for (const listener of listeners) listener(); }
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
