import { describe, expect, it } from "vitest";
import { buildHealthResponse } from "../../../server/health";

describe("web health route helpers", () => {
  it("maps all-up checks to ok", () => {
    const body = buildHealthResponse({
      service: "aistudy-web",
      checks: {
        database: { status: "up", latencyMs: 1 },
        redis: { status: "up", latencyMs: 1 },
        storage: { status: "up", latencyMs: 1 },
      },
    });
    expect(body.status).toBe("ok");
  });
});
