import { expect, it, vi } from "vitest";
import { createParserActivity } from "./parser-activity";

it("passes PDF inspection through without treating page count as decoded page evidence", async () => {
  const activity = createParserActivity(() => 0);
  const inspection = { exitCode: 0, stdout: JSON.stringify({ pageCount: 70 }) };
  let finish!: (result: typeof inspection) => void;
  const wrapped = activity.wrap(vi.fn().mockResolvedValueOnce(inspection)
    .mockImplementation(() => new Promise(done => { finish = done; })));
  expect(await wrapped(["--input", "document.pdf", "--inspect-pdf"], new AbortController().signal)).toEqual(inspection);
  const pending = wrapped(["--input", "document.pdf", "--page-start", "1", "--page-end", "10"], new AbortController().signal);
  expect(activity.canReuseHealth(1000)).toBe(false);
  finish({ exitCode: 4, stdout: "" }); await pending;
});

it("does not count malformed/empty output, check-only processes or aborted success as parse evidence", async () => {
  const activity = createParserActivity(() => 0);
  const controller = new AbortController();
  let finish!: (result: { exitCode: number; stdout: string }) => void;
  const run = activity.wrap(vi.fn().mockResolvedValueOnce({ exitCode: 0, stdout: "invalid" })
    .mockResolvedValueOnce({ exitCode: 0, stdout: JSON.stringify({ pages: [] }) })
    .mockResolvedValueOnce({ exitCode: 0, stdout: "check ok" })
    .mockImplementationOnce(async () => { controller.abort(); return { exitCode: 0, stdout: "" }; })
    .mockImplementation(() => new Promise(done => { finish = done; })));
  await expect(run(["--input", "bad"], new AbortController().signal)).rejects.toThrow();
  await run(["--input", "empty"], new AbortController().signal);
  await run(["--check"], new AbortController().signal);
  await expect(run(["--input", "cancelled"], controller.signal)).rejects.toThrow();
  const busy = run(["--input", "busy"], new AbortController().signal);
  expect(activity.canReuseHealth(1000)).toBe(false);
  finish({ exitCode: 4, stdout: "" }); await busy;
});

it("forwards stream callbacks and records accepted page evidence while the batch remains active", async () => {
  const activity = createParserActivity(() => 0);
  let emit!: (line: string) => Promise<void>;
  let finish!: () => void;
  const run = activity.wrap(async (_argv, _signal, stream) => {
    emit = stream!.onLine;
    await new Promise<void>(resolve => { finish = resolve; });
    return { exitCode: 4, stdout: "not aggregate JSON" };
  });
  const accepted: string[] = [];
  const pending = run(["--input", "pdf", "--ranges", "1-1,2-2"], new AbortController().signal, {
    onLine: async line => { accepted.push(line); },
  });
  expect(activity.canReuseHealth(1000)).toBe(false);
  await emit('{"range":[1,1],"pages":[{"page":1,"text":"valid","imagePath":null}]}');
  expect(accepted).toHaveLength(1);
  expect(activity.canReuseHealth(1000)).toBe(true);
  finish();
  await pending; // streamed stdout is not decoded as one JSON payload
  expect(activity.canReuseHealth(1000)).toBe(false);
});

it.each(["error", "empty", "pageCount", "rejected"])("does not record %s stream output as page evidence", async mode => {
  const activity = createParserActivity(() => 0);
  let emit!: (line: string) => Promise<void>;
  let finish!: () => void;
  const run = activity.wrap(async (_argv, _signal, stream) => {
    emit = stream!.onLine;
    await new Promise<void>(resolve => { finish = resolve; });
    return { exitCode: 0, stdout: "" };
  });
  const pending = run(["--input", "pdf", "--ranges", "1-1"], new AbortController().signal, {
    onLine: async () => { if (mode === "rejected") throw new Error("DB fence"); },
  });
  const line = mode === "error" ? '{"range":[1,1],"error":"timeout"}'
    : mode === "empty" ? '{"range":[1,1],"pages":[]}'
    : mode === "pageCount" ? '{"pageCount":1}' : '{"range":[1,1],"pages":[{"page":1,"text":"valid","imagePath":null}]}';
  if (mode === "rejected") await expect(emit(line)).rejects.toThrow("DB fence");
  else await emit(line);
  expect(activity.canReuseHealth(1000)).toBe(false);
  finish(); await pending;
});
