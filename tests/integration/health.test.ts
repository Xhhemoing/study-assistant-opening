import { describe, expect, it } from "vitest";
import { healthResponseSchema } from "@aistudy/contracts";
import { buildHealthResponse } from "../../apps/web/src/server/health";

describe("health response contract", () => {
  it("reports dependency statuses without secrets", () => {
    const body = buildHealthResponse({
      service: "aistudy-web",
      checks: {
        database: { status: "up", latencyMs: 3 },
        redis: { status: "up", latencyMs: 1 },
        storage: { status: "down", errorCode: "unreachable" },
      },
    });

    const parsed = healthResponseSchema.parse(body);
    expect(parsed.status).toBe("degraded");
    expect(parsed.checks.database.status).toBe("up");
    expect(parsed.checks.storage.status).toBe("down");

    const serialized = JSON.stringify(parsed);
    expect(serialized).not.toMatch(/postgres:\/\//i);
    expect(serialized).not.toMatch(/password/i);
    expect(serialized).not.toMatch(/secret/i);
  });

  it("is ok only when all dependencies are up", () => {
    const body = buildHealthResponse({
      service: "aistudy-web",
      checks: {
        database: { status: "up", latencyMs: 2 },
        redis: { status: "up", latencyMs: 2 },
        storage: { status: "up", latencyMs: 5 },
      },
    });
    expect(body.status).toBe("ok");
  });
});
