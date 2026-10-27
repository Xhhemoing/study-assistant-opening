import { expect, it } from "vitest";
import { assertCardSessionStop } from "./opening-long-term-card-session";
it("rejects a client active clock beyond either server elapsed time or its approved cap", () => {
  const base = { budgetMinutes: 10, startedAt: "2026-11-01T09:00:00Z", now: new Date("2026-11-01T09:05:00Z") };
  expect(() => assertCardSessionStop({ ...base, elapsedSeconds: 400 })).toThrow("时间");
  expect(() => assertCardSessionStop({ ...base, now: new Date("2026-11-01T10:00:00Z"), elapsedSeconds: 601 })).toThrow("时长");
  expect(() => assertCardSessionStop({ ...base, elapsedSeconds: 180 })).not.toThrow();
});
