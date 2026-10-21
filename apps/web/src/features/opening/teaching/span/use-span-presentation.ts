"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import { spanProblemSchema } from "@aistudy/contracts";
import { acknowledgeStudyExposure } from "../../assistant/study-exposure-ack";
const pair = z.tuple([z.string(), z.string()]);
const schema = z.object({ problem: spanProblemSchema, exposureReceipt: z.object({ id: z.string().uuid() }),
  solution: z.discriminatedUnion("kind", [z.object({ kind: z.literal("unique"), coefficients: pair }), z.object({ kind: z.literal("infinite"), particular: pair, directions: z.array(pair) }), z.object({ kind: z.literal("none") }), z.object({ kind: z.literal("unknown"), reason: z.string() })]) });
const pending = new Map<string, Promise<z.infer<typeof schema>>>();
export function useSpanPresentation(courseId: string, sourceId: string | undefined, kind: "worked" | "simulation" | "overview", sessionId?: string) {
  const [content, setContent] = useState<z.infer<typeof schema> | null>(null), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setContent(null); setError("");
    if (!sourceId) { setError("先关联一份可用课程材料，再读取有版本记录的教学示范。"); return; }
    const clientKey = `span-demo:${sessionId ?? courseId}:${sourceId}:${kind}:v1`;
    let request = pending.get(clientKey);
    if (!request) {
      request = fetch("/api/opening/teaching/span/presentation", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ courseId, sourceId, kind, clientKey, ...(sessionId ? { sessionId } : {}) }) })
        .then(async response => { if (!response.ok) throw new Error("教学示范暂未读取，解法未显示；可重新读取。"); return schema.parse(await response.json()); })
        .finally(() => pending.delete(clientKey));
      pending.set(clientKey, request);
    }
    void request.then(result => { if (active) { setContent(result); void acknowledgeStudyExposure(result.exposureReceipt).catch(() => undefined); } })
      .catch(reason => { if (active) setError(reason instanceof Error ? reason.message : "示范暂不可读取"); });
    return () => { active = false; };
  }, [courseId, sourceId, kind, sessionId, revision]);
  return { content, error, reload: () => setRevision(value => value + 1) };
}
