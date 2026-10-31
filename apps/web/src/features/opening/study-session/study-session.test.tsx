import { expect, it } from "vitest";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { loadFeatureSwitches, resolveCapabilities } from "@aistudy/config";

it("keeps the new session closed by default and requires authenticated teaching access", () => {
  expect(CLOSED_CAPABILITIES.studySessionV2).toBe(false);
  expect(resolveCapabilities(loadFeatureSwitches({}), "learner").studySessionV2).toBe(false);
  expect(resolveCapabilities(loadFeatureSwitches({ OPENING_STUDY_SESSION_V2: "1" }), "learner").studySessionV2).toBe(true);
  expect(resolveCapabilities(loadFeatureSwitches({ OPENING_STUDY_SESSION_V2: "1" }), null).studySessionV2).toBe(false);
});
