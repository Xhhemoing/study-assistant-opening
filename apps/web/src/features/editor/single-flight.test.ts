/** J1 / G5 (frontend): one create per explicit attempt, StrictMode-safe. */
import { describe, expect, it, vi } from "vitest";
import { createSingleFlight } from "./single-flight";

describe("createSingleFlight", () => {
  it("re-running the effect for the same attempt reuses the in-flight request", async () => {
    const flight = createSingleFlight<string>();
    const create = vi.fn(async () => "doc-1");
    // StrictMode: effect mount → cleanup → mount with the same attempt.
    const a = flight.run(0, create);
    const b = flight.run(0, create);
    expect(a).toBe(b);
    expect(await b).toBe("doc-1");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("an explicit retry (new attempt) issues a new request", async () => {
    const flight = createSingleFlight<string>();
    const create = vi.fn().mockRejectedValueOnce(new Error("net")).mockResolvedValueOnce("doc-2");
    await expect(flight.run(0, create)).rejects.toThrow("net");
    await expect(flight.run(0, create)).rejects.toThrow("net");
    expect(await flight.run(1, create)).toBe("doc-2");
    expect(create).toHaveBeenCalledTimes(2);
  });
});
