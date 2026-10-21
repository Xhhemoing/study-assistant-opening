import { useCallback, useEffect, useRef, useState } from "react";
import { createJobStream, type StreamingReply } from "./job-stream";

export function useJobStream(jobId: string | null, conversationId: string | null) {
  const [reply, setReply] = useState<StreamingReply | null>(null);
  const connection = useRef<ReturnType<typeof createJobStream> | null>(null);
  useEffect(() => {
    if (!jobId || !conversationId) return;
    const stream = createJobStream({ jobId, conversationId, onReply: setReply });
    connection.current = stream;
    stream.start();
    return () => { stream.cancel(); if (connection.current === stream) connection.current = null; };
  }, [jobId, conversationId]);
  const cancel = useCallback(() => connection.current?.cancel(), []);
  return { reply: reply?.jobId === jobId && reply.conversationId === conversationId ? reply : null, cancel };
}
