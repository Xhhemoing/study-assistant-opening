import { expect, it } from "vitest";
import { settingsHashTarget, settingsRedirectQuery } from "./settings-route-target";

it("maps old fragments to their owning page while preserving query values", () => {
  expect(settingsHashTarget("/opening/settings", "#planning", "?task=a&tag=1&tag=2")).toBe("/opening/settings/learning?task=a&tag=1&tag=2&planning=1#planning");
  expect(settingsHashTarget("/opening/settings", "#preferences")).toBe("/opening/settings/learning#preferences");
  expect(settingsHashTarget("/opening/settings", "#daily-budget", "?task=a")).toBe("/opening/settings/ai?task=a#daily-budget");
  expect(settingsHashTarget("/opening/settings", "#appearance")).toBeNull();
  expect(settingsHashTarget("/opening/settings", "#https://external.test")).toBeNull();
  expect(settingsHashTarget("/opening/settings", "#constructor")).toBeNull();
});

it("keeps repeated query parameters for the permanent path redirects", () => {
  expect(settingsRedirectQuery({ task: "a", tag: ["1", "2"], unused: undefined }, { planning: "1" })).toBe("?task=a&tag=1&tag=2&planning=1");
  expect(settingsRedirectQuery({})).toBe("");
});
