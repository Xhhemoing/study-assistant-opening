import { describe, expect, it } from "vitest";
import { assertStreamRedisUrl, RUNTIME_SAFETY_CASES, STREAM_SAFETY_CASES } from "../../../../scripts/lib/tutor-dialogue";

describe("bounded opt-in stream collector", () => {
  it("keeps the old fourteen runtime cases separate from the two stream cases", () => {
    expect(RUNTIME_SAFETY_CASES).toHaveLength(14);
    expect(STREAM_SAFETY_CASES).toEqual(["stream_success", "stream_cancel"]);
    expect(RUNTIME_SAFETY_CASES.some(id => String(id).startsWith("stream_"))).toBe(false);
  });
  it.each(["redis://127.0.0.1:6387", "redis://localhost:6387", "rediss://[::1]:6387"])("accepts explicit loopback %s", value => {
    expect(assertStreamRedisUrl(value)).toBeInstanceOf(URL);
  });
  it.each(["redis://remote.invalid:6379", "https://localhost:6387"])("rejects non-test Redis endpoint %s", value => {
    expect(() => assertStreamRedisUrl(value)).toThrow("loopback Redis");
  });
});
