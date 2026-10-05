import { describe, expect, it } from "vitest";
import { summarizeOpeningHealth } from "./route";

describe("opening health response", () => {
  it("returns only coarse status and never exposes probe details", () => {
    const result = summarizeOpeningHealth({
      database: { ok: true, detail: "reachable postgres://secret" },
      redis: { ok: false, detail: "unreachable (ECONNREFUSED)" },
      storage: { ok: true, detail: "bucket reachable" },
      workerBacklog: { ok: true, detail: "no stale backlog" },
    });

    expect(result).toEqual({
      status: "down",
      checks: {
        database: "up",
        redis: "down",
        storage: "up",
        workerBacklog: "up",
      },
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("is healthy only when every required runtime check is up", () => {
    expect(summarizeOpeningHealth({
      database: { ok: true },
      redis: { ok: true },
      storage: { ok: true },
      workerBacklog: { ok: true },
    }).status).toBe("ok");
  });
});
