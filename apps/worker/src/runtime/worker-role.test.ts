import { describe, expect, it, vi } from "vitest";
import { loadWorkerEnv } from "@aistudy/config";
import { OPENING_QUEUE_KINDS } from "./queue";
import { prepareWorkerRole } from "./worker-role";

describe("worker parser isolation", () => {
  it("starts learning consumers without inspecting an unavailable Python parser", async () => {
    const unavailableParser = vi.fn(async () => { throw new Error("PARSER_PYTHON is not an executable"); });
    const env = loadWorkerEnv({ WORKER_ROLE: "learning", PARSER_PYTHON: "/missing/python" });
    const runtime = await prepareWorkerRole(env.workerRole, unavailableParser);
    expect(unavailableParser).not.toHaveBeenCalled();
    expect(runtime.parserRunner).toBeNull();
    expect([...runtime.queueKinds].sort()).toEqual([
      "build-course-knowledge", "compile-teaching-unit", "extract-study-actions", "index-source",
      "recognize-photo-question", "remind", "retest", "tutor", "tutor-metadata",
    ]);
  });

  it.each(["all", "parser"] as const)("rejects %s startup when parser checks fail", async role => {
    const failure = new Error("Parser startup failed: missing OCR dependency");
    const check = vi.fn(async () => { throw failure; });
    await expect(prepareWorkerRole(role, check)).rejects.toBe(failure);
    expect(check).toHaveBeenCalledOnce();
  });

  it.each(["all", "parser"] as const)("checks the parser before enabling %s consumers", async role => {
    const runner = vi.fn(async () => ({ exitCode: 0, stdout: "" }));
    const check = vi.fn(async () => runner);
    const runtime = await prepareWorkerRole(role, check);
    expect(check).toHaveBeenCalledOnce();
    expect(runtime.parserRunner).toBe(runner);
    expect([...runtime.queueKinds]).toEqual(role === "all" ? [...OPENING_QUEUE_KINDS] : ["parse", "parse-media"]);
  });
});
