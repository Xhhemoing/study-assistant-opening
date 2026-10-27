import { expect, it } from "vitest";
import { resolveOpeningDailyQuota } from "./effective-cap";

it("requires explicit unlimited mode without reinterpreting old zero or null caps", () => {
  const legacy = { envCapCents: 0, workspaceCapCents: null, confirmed: false };
  expect(resolveOpeningDailyQuota(legacy)).toEqual({ mode: "limited", capCents: 0 });
  expect(resolveOpeningDailyQuota({ ...legacy, mode: "unlimited" })).toEqual({ mode: "unlimited" });
  expect(resolveOpeningDailyQuota({ envCapCents: 100, workspaceCapCents: 40, confirmed: true })).toEqual({ mode: "limited", capCents: 40 });
});
