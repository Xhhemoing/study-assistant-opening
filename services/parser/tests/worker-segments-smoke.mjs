// Dependency-free smoke for Node 24+: executes the real TypeScript modules.
// Only module resolution is adapted. Does not replace Vitest/SQL/Docling tests.
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../../../", import.meta.url));
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "@aistudy/database") {
    return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent([
      `export * from ${JSON.stringify(new URL("../../../packages/database/src/repositories/opening-parser-health.ts", import.meta.url).href)};`,
      `export * from ${JSON.stringify(new URL("../../../packages/database/src/repositories/opening-pdf-segments.ts", import.meta.url).href)};`,
    ].join("\n"))}` };
  }
  if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
    const target = new URL(specifier, context.parentURL);
    if (existsSync(fileURLToPath(target) + ".ts")) return nextResolve(target.href + ".ts", context);
  }
  return nextResolve(specifier, context);
} });

const { parsePdfSegments, watchPdfExecution } = await import("../../../apps/worker/src/parsers/pdf-segments.ts");
const { createNodeRunner } = await import("../../../apps/worker/src/parsers/docling-process.ts");
const { probeParserOcr, pdfParserProfile } = await import("../../../apps/worker/src/parsers/ocr-health.ts");
const { parserOcrReadinessItem } = await import("../../../apps/web/src/features/opening/assistant/ai-readiness-model.ts");

const cache = new Map();
const calls = [];
let fail = true;
const input = {
  path: "/unit.pdf", sourceId: "source", sourceVersion: 0, scope: { workspaceId: "w", ownerUserId: "u" },
  signal: new AbortController().signal, parserProfile: "smoke-v1",
  segments: { read: async (_scope, key) => cache.get(JSON.stringify(key)),
    save: async (_scope, key, value) => { cache.set(JSON.stringify(key), value); } },
  runner: async argv => {
    if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: '{"pageCount":23}' };
    const start = Number(argv[argv.indexOf("--page-start") + 1]), end = Number(argv[argv.indexOf("--page-end") + 1]);
    calls.push([start, end]);
    if (start === 11 && fail) return { exitCode: 4, stdout: "" };
    return { exitCode: 0, stdout: JSON.stringify({ pages: Array.from({ length: end - start + 1 }, (_, i) => ({ page: start + i, text: `p${start + i}`, imagePath: null })) }) };
  },
};
await assert.rejects(parsePdfSegments(input), /11-20/);
assert.deepEqual(calls, [[1, 10], [11, 20], [21, 23]]);
assert.deepEqual([...cache.values()].map(s => s.state), ["ready", "failed", "ready"]);
fail = false; calls.length = 0;
const result = await parsePdfSegments(input);
assert.deepEqual(calls, [[11, 20]]);
assert.deepEqual(result.map(p => p.page), Array.from({ length: 23 }, (_, i) => i + 1));
console.log("PASS actual segment implementation: 10-page bounds, physical pages, failed-only retry");
assert.ok([...cache.keys()].every(key => JSON.parse(key).sourceVersion === 0));
calls.length = 0;
await parsePdfSegments(input);
assert.deepEqual(calls, []);
const oldProfile = "docling-2.126.0/pdf-segments-v1/text";
await parsePdfSegments({ ...input, parserProfile: oldProfile });
const profile = pdfParserProfile({});
assert.notEqual(profile, oldProfile);
calls.length = 0;
await parsePdfSegments({ ...input, parserProfile: profile });
assert.deepEqual(calls, [[1, 10], [11, 20], [21, 23]]);
calls.length = 0;
await parsePdfSegments({ ...input, parserProfile: profile });
assert.deepEqual(calls, []);
console.log("PASS cache identity: zero source version retained; old charspan profile not reused");

const controller = new AbortController();
let writes = 0;
await assert.rejects(parsePdfSegments({ ...input, signal: controller.signal,
  segments: { read: async () => null, save: async () => { writes++; } },
  runner: async argv => { const res = await input.runner(argv); if (!argv.includes("--inspect-pdf")) controller.abort(); return res; },
}), { name: "AbortError" });
assert.equal(writes, 0);
console.log("PASS actual segment implementation: late success after cancellation cannot write cache");

let polls = 0;
const watcher = await watchPdfExecution(async () => { if (++polls > 1) throw new Error("lease revoked"); }, 5);
await new Promise(resolve => {
  const hold = setTimeout(resolve, 500);
  watcher.signal.addEventListener("abort", () => { clearTimeout(hold); resolve(); }, { once: true });
});
assert.equal(watcher.signal.aborted, true);
await watcher.stop();
console.log("PASS execution watcher: lease revocation aborts running operation");

const runner = createNodeRunner({ pythonExecutable: process.execPath, cwd: root });
const folder = await mkdtemp(path.join(os.tmpdir(), "parser-tree-smoke-"));
const pidFile = path.join(folder, "pids");
const abort = new AbortController();
const code = `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'inherit'});fs.writeFileSync(process.argv[1],JSON.stringify([process.pid,c.pid]));setInterval(()=>{},1000);`;
const child = runner(["-e", code, pidFile], abort.signal);
const rejected = assert.rejects(child, { name: "AbortError" });
try {
  let pids;
  for (let i = 0; i < 100 && !pids; i++) {
    try { pids = JSON.parse(await readFile(pidFile, "utf8")); }
    catch { await new Promise(resolve => setTimeout(resolve, 10)); }
  }
  assert.equal(pids?.length, 2);
  abort.abort(); await rejected;
  assert.throws(() => process.kill(pids[0], 0));
  if (process.platform === "linux") {
    try { assert.match(await readFile(`/proc/${pids[1]}/stat`, "utf8"), /\) Z /); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  console.log("PASS real Node child tree: SIGTERM-resistant parent/descendant killed before promise settles");
} finally { abort.abort(); await child.catch(() => {}); await rm(folder, { recursive: true, force: true }); }
await assert.rejects(runner(["-e", "setInterval(()=>{},1000)"], AbortSignal.timeout(30)), { name: "TimeoutError" });
console.log("PASS real Node child: deadline force-kills process");
const unconfigured = await probeParserOcr(async () => { throw new Error("should not run"); }, {});
assert.equal(unconfigured.status, "not_configured");
const bad = await probeParserOcr(async () => ({ exitCode: 0, stdout: '{"status":"ready","directoryConfigured":true,"directoryExists":true,"missingFiles":[],"inferenceMs":null}' }), { PARSER_OCR_MODEL_DIR: "/fake" });
assert.equal(bad.status, "preflight_failed");
assert.equal(parserOcrReadinessItem(null).status, "unknown");
console.log("PASS OCR/readiness: missing measurements cannot become ready");
