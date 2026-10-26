import type IORedis from "ioredis";
import { expect, it, vi } from "vitest";
import { createTutorStreamWriter } from "./tutor-stream";

it("returns only confirmed publication sequences and includes the expected execution identity", async () => {
  const evalScript = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(0);
  const writer = createTutorStreamWriter({ eval: evalScript } as unknown as IORedis);
  expect(await writer.append("workspace", "job", "hello", "execution")).toBe(1);
  expect(await writer.append("workspace", "job", "stale", "old-execution")).toBe(0);
  expect(evalScript.mock.calls[0]?.at(-1)).toBe("execution");
  expect(await writer.append("workspace", "job", "", "execution")).toBe(0);
  expect(evalScript).toHaveBeenCalledTimes(2);
});
