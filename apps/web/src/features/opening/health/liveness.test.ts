import { describe, expect, it, vi } from "vitest";
import { GET } from "../../../app/api/opening/health/route";

vi.mock("../../../../../../scripts/opening-readiness-probes.mjs", () => ({
  runReadinessProbes: () => { throw new Error("Public liveness must not run dependency probes"); },
}));

describe("public opening liveness", () => {
  it("stays cheap and discloses no dependency state, even when probes are unavailable", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", kind: "liveness" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
