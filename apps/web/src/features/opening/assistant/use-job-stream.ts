import { useCallback, useEffect, useRef, useState } from "react";
import { createJobStream, type StreamingReply } from "./job-stream";
import { recordLearningExperience } from "../client/learning-experience";
export type FirstTextTiming = { jobId: string; clientKey: string; startedAt: number };

export function useJobStream(jobId: string | null, conversationId: string | null, timing: FirstTextTiming | null = null) {
  const [reply, setReply] = useState<StreamingReply | null>(null);
  const connection = useRef<ReturnType<typeof createJobStream> | null>(null);
  useEffect(() => {
    if (!jobId || !conversationId) return;
    const stream = createJobStream({ jobId, conversationId, onReply: setReply });
    connection.current = stream;
    stream.start();
    return () => { stream.cancel(); if (connection.current === stream) connection.current = null; };
  }, [jobId, conversationId]);
  const measured = useRef<string | null>(null);
  const hasText = reply?.jobId === jobId && reply.conversationId === conversationId && Boolean(reply.text.trim());
  useEffect(() => {
    if (!timing || timing.jobId !== jobId || !hasText
      || measured.current === jobId || document.hidden) return;
    const frame = requestAnimationFrame(() => {
      if (document.hidden) return;
      const durationMs = Math.round(performance.now() - timing.startedAt);
      if (durationMs < 1 || durationMs > 600_000) return;
      measured.current = timing.jobId;
      void recordLearningExperience({ kind: "first_text", jobId: timing.jobId, clientKey: timing.clientKey, durationMs,
        ...(reply?.executionId ? { executionId: reply.executionId, observedAt: new Date().toISOString() } : {}) });
    });
    return () => cancelAnimationFrame(frame);
  }, [hasText, jobId, conversationId, timing, reply?.executionId]);
  const cancel = useCallback(() => connection.current?.cancel(), []);
  return { reply: reply?.jobId === jobId && reply.conversationId === conversationId ? reply : null, cancel };
}
