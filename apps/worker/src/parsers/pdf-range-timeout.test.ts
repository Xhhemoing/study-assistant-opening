import { expect, it } from "vitest";
import { createNodeRunner, ConversionFailedError } from "./docling-process";
import { parsePdfSegments } from "./pdf-segments";
import type { ParserRunner } from "./types";

it("kills a live parser on a timeout receipt, preserves prior cache and never admits another range", async () => {
  const child = createNodeRunner({ pythonExecutable: process.execPath, cwd: process.cwd() });
  const first = { range: [1, 1], pages: [{ page: 1, text: "saved", imagePath: null }] };
  const timeout = { range: [2, 2], error: "timeout" };
  const run: ParserRunner = (argv, signal, stream) => argv.includes("--inspect-pdf")
    ? child(["-e", "console.log('{\"pageCount\":3}')"], signal)
    : child(["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(first) + "\n" + JSON.stringify(timeout) + "\n")});setInterval(()=>{},1000);`], signal, stream);
  const saves: unknown[] = [];
  const controller = new AbortController();
  const guard = setTimeout(() => controller.abort(new Error("timeout receipt did not terminate parser")), 3000);
  try {
    await expect(parsePdfSegments({ path: "/synthetic.pdf", sourceId: "s", sourceVersion: 0,
      scope: { workspaceId: "w", ownerUserId: "u" }, signal: controller.signal, runner: run, segmentPages: 1,
      segments: { assertCurrent: async () => {}, read: async () => null,
        save: async (_scope, identity, value) => { saves.push([identity.pageStart, value]); } },
    })).rejects.toBeInstanceOf(ConversionFailedError);
    expect(controller.signal.aborted).toBe(false);
    expect(saves).toEqual([[1, { state: "ready", pages: first.pages }], [2, { state: "failed", errorCode: "timeout" }]]);
  } finally { clearTimeout(guard); controller.abort(); }
});
