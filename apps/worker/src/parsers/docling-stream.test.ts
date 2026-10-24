import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BoundsExceededError, createNodeRunner } from "./docling-process";
import { parsePdfSegments } from "./pdf-segments";
import type { ParserRunner } from "./types";

const nodeRunner = createNodeRunner({ pythonExecutable: process.execPath, cwd: process.cwd() });
const active = new Map<Promise<unknown>, AbortController>();
const runner: ParserRunner = (argv, childSignal, stream) => {
  const controller = new AbortController();
  const running = nodeRunner(argv, AbortSignal.any([childSignal, controller.signal, AbortSignal.timeout(4000)]), stream);
  active.set(running, controller);
  void running.then(() => { active.delete(running); }, () => { active.delete(running); });
  return running;
};
afterEach(async () => {
  for (const controller of active.values()) controller.abort();
  await Promise.allSettled([...active.keys()]);
  vi.restoreAllMocks();
});
const signal = () => new AbortController().signal;
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(promise: Promise<void>) {
  let timer!: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("child callback did not start")), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function gone(pid: number) {
  try { expect(await readFile(`/proc/${pid}/stat`, "utf8")).toMatch(/\) Z /); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

describe("real streaming parser subprocess", () => {
  it("decodes split UTF-8 JSONL, CRLF and a final unterminated line without retaining stdout", async () => {
    const lines: string[] = [];
    const code = `const b=Buffer.from(JSON.stringify({text:'中文∞'})+'\\r\\n'+JSON.stringify({text:'末行'}));
      process.stdout.write(b.subarray(0,11));setTimeout(()=>process.stdout.end(b.subarray(11)),20);`;
    const result = await runner(["-e", code], signal(), { onLine: async line => { lines.push(line); } });
    expect(lines.map(line => JSON.parse(line))).toEqual([{ text: "中文∞" }, { text: "末行" }]);
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
  });

  it("serially awaits slow callbacks, including a callback after process close, before settling", async () => {
    const entered = deferred(), release = deferred();
    const lines: string[] = [];
    let settled = false;
    const running = runner(["-e", "process.stdout.end('first\\nsecond\\n')"], signal(), { onLine: async line => {
      lines.push(line);
      if (line === "first") { entered.resolve(); await release.promise; }
    } });
    void running.then(() => { settled = true; }, () => { settled = true; });
    try {
      await waitFor(entered.promise);
      await pause(30);
      expect(lines).toEqual(["first"]);
      expect(settled).toBe(false);
    } finally { release.resolve(); }
    await running;
    expect(lines).toEqual(["first", "second"]);
    expect(settled).toBe(true);
  });

  it("rejects invalid UTF-8 instead of silently replacing bytes", async () => {
    let called = false;
    await expect(runner(["-e", "process.stdout.end(Buffer.from([0xff,10]))"], signal(), { onLine: async () => { called = true; } })).rejects.toThrow();
    expect(called).toBe(false);
  });

  it("bounds an unterminated single line at 8MB", async () => {
    await expect(runner(["-e", "process.stdout.write('x'.repeat(8*1024*1024+1))"], signal(), { onLine: async () => {} }))
      .rejects.toBeInstanceOf(BoundsExceededError);
  });

  it("bounds cumulative JSONL stdout at 8MB even when every individual line is short", async () => {
    let called = 0;
    const code = `const {once}=require('node:events'); (async()=>{for(let i=0;i<9000;i++){
      if(!process.stdout.write('x'.repeat(1023)+'\\n'))await once(process.stdout,'drain');}})();`;
    await expect(runner(["-e", code], signal(), { onLine: async () => { called++; } })).rejects.toBeInstanceOf(BoundsExceededError);
    expect(called).toBeGreaterThan(0);
    expect(called).toBeLessThanOrEqual(8192);
  });

  it.each([true, false])("assembles an 8MB fragmented line with linear copy volume (newline=%s)", async terminated => {
    const bound = 8 * 1024 * 1024;
    const payloadBytes = bound - (terminated ? 1 : 0);
    const concat = Buffer.concat;
    let copiedBytes = 0;
    // Observe actual byte-copy work, not source spelling or wall-clock timing.
    // Re-concatenating the growing prefix exceeds this budget by orders of magnitude.
    vi.spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
      copiedBytes += totalLength ?? list.reduce((sum, item) => sum + item.length, 0);
      // Fail early rather than letting a regressed quadratic path allocate GBs.
      if (copiedBytes > 4 * bound) throw new Error("fragmented stdout copied beyond linear budget");
      return concat(list, totalLength);
    });
    const code = `const {once}=require('node:events'); (async()=>{
      const chunk=Buffer.alloc(4096,120); let remaining=${payloadBytes};
      while(remaining){const n=Math.min(remaining,chunk.length);
        if(!process.stdout.write(chunk.subarray(0,n)))await once(process.stdout,'drain');
        remaining-=n;
      } process.stdout.end(${terminated ? "'\\n'" : ""});})();`;
    const lines: string[] = [];
    const result = await runner(["-e", code], signal(), { onLine: async line => { lines.push(line); } });
    expect(result).toMatchObject({ exitCode: 0, stdout: "" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe("x".repeat(payloadBytes));
    expect(copiedBytes).toBeLessThanOrEqual(2 * bound);
  });

  it("resets fragmented line state before later CRLF, empty and unterminated lines", async () => {
    const lines: string[] = [];
    const code = `process.stdout.write('x'.repeat(128*1024));
      setTimeout(()=>process.stdout.end('y\\r\\n\\nlast'),20);`;
    await runner(["-e", code], signal(), { onLine: async line => { lines.push(line); } });
    expect(lines).toEqual(["x".repeat(128 * 1024) + "y", "", "last"]);
  });

  it("accepts exactly 8MB of streamed stdout", async () => {
    let bytes = 0;
    const result = await runner(["-e", "process.stdout.end('x'.repeat(8*1024*1024-1)+'\\n')"], signal(), {
      onLine: async line => { bytes += Buffer.byteLength(line) + 1; },
    });
    expect(bytes).toBe(8 * 1024 * 1024);
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it.skipIf(process.platform !== "linux")("kills the entire group on callback rejection and returns the original rejection", async () => {
    let pids: number[] = [];
    const failure = new Error("DB claim fence failed");
    const code = `const {spawn}=require('node:child_process');
      process.on('SIGTERM',()=>{});
      const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
      console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
    await expect(runner(["-e", code], signal(), { onLine: async line => {
      pids = JSON.parse(line) as number[];
      throw failure;
    } })).rejects.toBe(failure);
    expect(pids).toHaveLength(2);
    for (const pid of pids) await gone(pid);
  });

  it.skipIf(process.platform !== "linux")("cancels a process tree promptly but waits for an in-flight callback to drain", async () => {
    const entered = deferred(), release = deferred();
    const controller = new AbortController();
    let pids: number[] = [], settled = false;
    const code = `const {spawn}=require('node:child_process');
      const c=spawn(process.execPath,['-e',"setInterval(()=>{},1000)"],{stdio:'inherit'});
      console.log(JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
    const running = runner(["-e", code], controller.signal, { onLine: async line => {
      pids = JSON.parse(line) as number[];
      entered.resolve(); await release.promise;
    } });
    void running.then(() => { settled = true; }, () => { settled = true; });
    const rejected = expect(running).rejects.toMatchObject({ name: "AbortError" });
    try {
      await waitFor(entered.promise);
      controller.abort();
      // Death can be asynchronous; a bounded poll observes the tree, not a mock.
      for (let i = 0; i < 100; i++) {
        try { process.kill(pids[0]!, 0); await pause(10); }
        catch { break; }
      }
      for (const pid of pids) await gone(pid);
      expect(settled).toBe(false);
    } finally { controller.abort(); release.resolve(); await rejected; }
  });

  it.each(["bad", "missing", "out-of-order", "crash", "timeout"])("real JSONL %s fails the PDF batch and preserves prior successful saves", async mode => {
    const ready = { range: [1, 1], pages: [{ page: 1, text: "first", imagePath: null }] };
    const lines = [JSON.stringify(ready)];
    if (mode === "bad") lines.push("not JSON");
    if (mode === "timeout") lines.push(JSON.stringify({ range: [2, 2], error: "timeout" }));
    if (mode === "out-of-order") lines.push(JSON.stringify({ ...ready, range: [3, 3] }));
    const run: ParserRunner = (argv, childSignal, stream) => {
      if (argv.includes("--inspect-pdf")) return runner(["-e", "console.log('{\"pageCount\":2}')"], childSignal);
      return runner(["-e", `process.stdout.end(${JSON.stringify(lines.join("\n") + "\n")});process.exitCode=${mode === "crash" || mode === "timeout" ? 4 : 0};`], childSignal, stream);
    };
    const saves: unknown[] = [];
    await expect(parsePdfSegments({ path: "/simulated.pdf", sourceId: "s", sourceVersion: 0,
      scope: { workspaceId: "w", ownerUserId: "u" }, signal: signal(), runner: run, segmentPages: 1,
      segments: { assertCurrent: async () => {}, read: async () => null, save: async (_scope, identity, value) => { saves.push([identity.pageStart, value]); } },
    })).rejects.toThrow();
    expect(saves).toEqual([[1, { state: "ready", pages: ready.pages }],
      ...(mode === "timeout" ? [[2, { state: "failed", errorCode: "timeout" }]] : [])]);
  });
});
