"use client";
import { useEffect, useState } from "react";
import { z } from "zod";
import { spanProblemSchema, spanTargetedExplanationSchema } from "@aistudy/contracts";
import { spanLessonRequest } from "./span-session-client";
import { acknowledgeStudyExposure } from "../../assistant/study-exposure-ack";
import { userFacingMessage } from "../../../../lib/user-facing-error";
const pair = z.tuple([z.string(), z.string()]);
export const spanPresentationSchema = z.object({ problem: spanProblemSchema, exposureReceipt: z.object({ id: z.string().uuid() }),
  targetedExplanation: spanTargetedExplanationSchema.optional(),
  solution: z.discriminatedUnion("kind", [z.object({ kind: z.literal("unique"), coefficients: pair }), z.object({ kind: z.literal("infinite"), particular: pair, directions: z.array(pair) }), z.object({ kind: z.literal("none") }), z.object({ kind: z.literal("unknown"), reason: z.string() })]) });
const pending = new Map<string, Promise<z.infer<typeof spanPresentationSchema>>>();
export type SpanRepairPresentationBinding = { activityId: string; repairVersion: 1 };
export function useSpanPresentation(courseId: string, sourceId: string | undefined, kind: "worked" | "simulation" | "overview", sessionId?: string, repair?: SpanRepairPresentationBinding) {
  const [content, setContent] = useState<z.infer<typeof spanPresentationSchema> | null>(null), [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setContent(null); setError("");
    if (!sourceId) { setError("先关联一份可用课程材料，再读取有版本记录的教学示范。"); return; }
    const clientKey = repair ? `span-repair:${repair.activityId}:v${repair.repairVersion}:example` : `span-demo:${sessionId ?? courseId}:${sourceId}:${kind}:v1`;
    let request = pending.get(clientKey);
    if (!request) {
      request = spanLessonRequest("/api/opening/teaching/span/presentation", spanPresentationSchema, { method: "POST", body: JSON.stringify(repair
        ? { activityId: repair.activityId, repairVersion: repair.repairVersion, stage: "example", clientKey } : { courseId, sourceId, kind, clientKey, ...(sessionId ? { sessionId } : {}) }) })
        .finally(() => pending.delete(clientKey));
      pending.set(clientKey, request);
    }
    void request.then(result => { if (active) { setContent(result); void acknowledgeStudyExposure(result.exposureReceipt).catch(() => undefined); } })
      .catch(reason => { if (active) setError(userFacingMessage(reason, "示范暂不可读取")); });
    return () => { active = false; };
  }, [courseId, sourceId, kind, sessionId, repair?.activityId, repair?.repairVersion, revision]);
  return { content, error, reload: () => setRevision(value => value + 1) };
}
