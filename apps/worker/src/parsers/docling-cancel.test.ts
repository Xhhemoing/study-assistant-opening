import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { describe, expect, it } from "vitest";
import { createNodeRunner } from "./docling-process";

describe("parser process cancellation", () => {
  it.skipIf(process.platform !== "linux")("kills a SIGTERM-resistant process tree before cancellation settles", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "parser-cancel-"));
    const marker = path.join(directory, "pids");
    const controller = new AbortController();
    const runner = createNodeRunner({ pythonExecutable: process.execPath, cwd: process.cwd() });
    const code = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      process.on('SIGTERM',()=>{});
      const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});
      fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,child.pid])); setInterval(()=>{},1000);`;
    const result = runner(["-e", code, marker], controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: "AbortError" });
    try {
      let pids: number[] = [];
      for (let i = 0; i < 100 && !pids.length; i++) {
        try { pids = JSON.parse(await readFile(marker, "utf8")) as number[]; }
        catch { await new Promise(resolve => setTimeout(resolve, 10)); }
      }
      expect(pids).toHaveLength(2);
      controller.abort();
      await rejected;
      expect(() => process.kill(pids[0]!, 0)).toThrow();
      // An orphan can remain a zombie until init reaps it, but cannot execute.
      try { expect(await readFile(`/proc/${pids[1]}/stat`, "utf8")).toMatch(/\) Z /); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    } finally { controller.abort(); await result.catch(() => {}); await rm(directory, { recursive: true, force: true }); }
  });
});
