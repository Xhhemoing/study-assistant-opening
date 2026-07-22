import { describe, expect, it } from "vitest";
import { GET } from "./app/api/health/route";

describe("Next.js App Router health route", () => {
  it("returns ok JSON suitable for self-hosted health checks", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "aistudy-web-spike",
    });
  });
});
