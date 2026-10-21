import type { LearningExperienceInput } from "@aistudy/contracts";
import { createSessionFetch } from "../../auth/session-expiry";

/** Measurements contain identities and elapsed milliseconds only, never student work. */
export async function recordLearningExperience(input: LearningExperienceInput): Promise<boolean> {
  try {
    const response = await createSessionFetch(fetch)("/api/opening/learning-experience", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input), keepalive: true,
    });
    return response.ok;
  } catch { return false; }
}
