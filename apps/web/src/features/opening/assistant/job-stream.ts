import { createSessionFetch } from "../../auth/session-expiry";
import { readServerEvents } from "../client/sse";

export type StreamingReply = {
  jobId: string;
  conversationId: string;
  assistantTurnId: string;
  text: string;
};

type Visibility = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;
type StreamPayload = { text: string; sequence: number; assistantTurnId: string; conversationId: string };
function isPayload(value: unknown): value is StreamPayload {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StreamPayload>;
  return typeof item.text === "string" && typeof item.assistantTurnId === "string"
    && typeof item.conversationId === "string" && Number.isSafeInteger(item.sequence) && item.sequence! >= 0;
}

/** Redis text is provisional. The separate job poller still restores the saved turn. */
export function createJobStream({ jobId, conversationId, onReply, fetchImpl = fetch,
  visibility = typeof document === "undefined" ? undefined : document,
}: {
  jobId: string;
  conversationId: string;
  onReply: (reply: StreamingReply) => void;
  fetchImpl?: typeof fetch;
  visibility?: Visibility;
}) {
  const read = createSessionFetch(fetchImpl);
  let active = false;
  let request: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let sequence = -1;
  let text = "";
  let assistantTurnId: string | null = null;
  let failures = 0;
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  function cancel() {
    active = false;
    clearTimer();
    request?.abort();
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
  }
  function schedule(delay: number) {
    if (!active || visibility?.hidden) return;
    clearTimer();
    timer = setTimeout(() => { timer = null; void connect(); }, delay);
  }
  async function connect() {
    if (!active || request || visibility?.hidden) return;
    const controller = new AbortController();
    request = controller;
    const current = () => active && !controller.signal.aborted && !visibility?.hidden;
    try {
      const response = await read(`/api/opening/jobs/${encodeURIComponent(jobId)}/stream`, {
        signal: controller.signal, headers: { accept: "text/event-stream" }, cache: "no-store",
      });
      if (!current()) { await response.body?.cancel().catch(() => undefined); return; }
      if ([400, 401, 403, 404, 405].includes(response.status)
        || response.ok && !response.headers.get("content-type")?.includes("text/event-stream")) {
        // Older servers / unsupported jobs keep working through the existing poller.
        cancel();
        return;
      }
      if (!response.ok) throw new Error("stream unavailable");
      await readServerEvents(response, (event) => {
        if (!current()) return false;
        if (event.event === "terminal") {
          const payload: unknown = JSON.parse(event.data);
          if (payload && typeof payload === "object" && "conversationId" in payload && payload.conversationId === conversationId) {
            cancel();
            return false;
          }
          return;
        }
        if (event.event !== "snapshot" && event.event !== "delta") return;
        const payload: unknown = JSON.parse(event.data);
        if (!isPayload(payload) || payload.conversationId !== conversationId
          || assistantTurnId && payload.assistantTurnId !== assistantTurnId) return;
        if (payload.sequence <= sequence) return;
        if (event.event === "delta" && payload.sequence !== sequence + 1) throw new Error("stream gap");
        sequence = payload.sequence;
        assistantTurnId = payload.assistantTurnId;
        text = event.event === "snapshot" ? payload.text : text + payload.text;
        failures = 0;
        onReply({ jobId, conversationId, assistantTurnId, text });
      }, controller.signal);
    } catch {
      if (current()) failures += 1;
    } finally {
      request = null;
      schedule(controller.signal.aborted ? 0 : Math.min(10000, 1000 * 2 ** Math.min(failures, 4)));
    }
  }
  function onVisibilityChange() {
    clearTimer();
    if (visibility?.hidden) request?.abort();
    else if (!request) void connect();
  }
  return {
    start() {
      if (active) return;
      active = true;
      visibility?.addEventListener("visibilitychange", onVisibilityChange);
      void connect();
    },
    cancel,
  };
}
