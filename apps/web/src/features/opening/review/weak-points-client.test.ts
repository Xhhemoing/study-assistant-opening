import { expect, it, vi } from "vitest";
import { readWeakPoints } from "./weak-points-client";

it("reads one aggregate with no-store and carries the cancellation signal", async () => {
  const body = { points: [], evaluatedAt: "2026-10-23T00:00:00.000Z", incomplete: true };
  const transport = vi.fn(async () => Response.json(body));
  const controller = new AbortController();
  await expect(readWeakPoints(controller.signal, transport)).resolves.toEqual(body);
  expect(transport).toHaveBeenCalledExactlyOnceWith("/api/opening/review/weak-points", { method: "GET", cache: "no-store", signal: controller.signal });
});

it("does not turn HTTP failures or malformed aggregates into an empty successful list", async () => {
  await expect(readWeakPoints(undefined, vi.fn(async () => Response.json({}, { status: 503 })))).rejects.toThrow("易错点暂时无法读取");
  await expect(readWeakPoints(undefined, vi.fn(async () => Response.json({ points: [] })))).rejects.toThrow("服务器返回的数据暂时无法核验");
});
