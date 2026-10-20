import { teachingActivitySummarySchema, teachingAnswerKeySchema, learningAttemptSchema, learningObservationSchema } from "@aistudy/contracts";
import { z } from "zod";
import { OpeningApiError } from "../client/api";

export async function readTeachingJson(path: string, fetchImpl: typeof fetch = fetch): Promise<unknown> {
  const response = await fetchImpl(path, { cache: "no-store" });
  const body = await response.json();
  if (!response.ok) throw new OpeningApiError(response.status, body?.error?.message ?? "无法读取学习记录");
  return body;
}

export function createTeachingActivityClient(fetchImpl: typeof fetch = fetch) {
  return {
    async getSubmittedAttempt(activityId: string, blockId: string, contentVersion: number) {
      const query = new URLSearchParams({ blockId, contentVersion: String(contentVersion) });
      return z.object({ attempt: learningAttemptSchema, observation: learningObservationSchema.nullable() }).nullable().parse(
        await readTeachingJson(`/api/opening/teaching-activities/${activityId}/submitted-attempt?${query}`, fetchImpl));
    },
    async getAnswerKey(activityId: string, blockId: string, attemptId: string) {
      const query = new URLSearchParams({ blockId, attemptId });
      return teachingAnswerKeySchema.parse(await readTeachingJson(`/api/opening/teaching-activities/${activityId}/answer-key?${query}`, fetchImpl));
    },
    async getSummary(activityId: string) {
      return teachingActivitySummarySchema.parse(await readTeachingJson(`/api/opening/teaching-activities/${activityId}/summary`, fetchImpl));
    },
  };
}
