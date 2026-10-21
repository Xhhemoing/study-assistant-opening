export type ServerEvent = { event: string; data: string };

/** Decode SSE independently of network chunks; returning false finishes the read. */
export async function readServerEvents(
  response: Response,
  onEvent: (event: ServerEvent) => void | false,
  signal?: AbortSignal,
): Promise<void> {
  if (!response.body) throw new Error("回答连接没有返回内容。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  let stopped = false;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  const checkAbort = () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  };
  function line(value: string) {
    if (!value) {
      if (data.length) stopped = onEvent({ event, data: data.join("\n") }) === false;
      event = "message";
      data = [];
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const field = colon < 0 ? value : value.slice(0, colon);
    let content = colon < 0 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (field === "event") event = content;
    if (field === "data") data.push(content);
  }
  signal?.addEventListener("abort", abort, { once: true });
  try {
    checkAbort();
    while (!stopped) {
      const { value, done } = await reader.read();
      checkAbort();
      buffer += decoder.decode(value, { stream: !done });
      let end: number;
      while (!stopped && (end = buffer.search(/[\r\n]/)) >= 0) {
        if (!done && buffer[end] === "\r" && end === buffer.length - 1) break;
        const length = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1;
        line(buffer.slice(0, end));
        buffer = buffer.slice(end + length);
      }
      if (done) break;
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
