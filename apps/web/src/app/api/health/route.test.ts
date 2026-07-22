import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("web health route", () => {
  it("returns ok for self-host health checks", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      service: "aistudy-web",
    });
  });
});
