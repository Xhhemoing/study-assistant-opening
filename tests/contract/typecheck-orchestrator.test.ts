import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const script = path.join(root, "scripts/typecheck.mjs");
const fake = path.join(root, "tests/fixtures/typecheck/fake-tsc.mjs");

function env(dir: string, extra: Record<string, string> = {}) {
  return {
    ...process.env,
    HERMES_HEAVY_LOCK_IMPL: "node",
    HERMES_HEAVY_LOCK: path.join(dir, "heavy.lock"),
    HERMES_HEAVY_LOCK_HELD: "",
    TYPECHECK_TSC_CMD: JSON.stringify([process.execPath, fake]),
    FAKE_TSC_DIR: dir,
    FAKE_TSC_MS: "200",
    ...extra,
  };
}
const peak = (d: string) => Math.max(...readFileSync(path.join(d, "peak.log"), "utf8").trim().split("\n").map(Number));

describe("scripts/typecheck.mjs", () => {
  it("derives the check set from config (no platform branching)", () => {
    const r = spawnSync(process.execPath, [script, "--list"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("apps/web");
    expect(r.stdout).toContain("packages/database");
    expect(r.stdout).toContain("tsconfig.e2e.json");
    expect(r.stdout.trim().split("\n")).toHaveLength(9);
  });

  it.each([1, 3])("respects --jobs %i as peak concurrency", (jobs) => {
    const d = mkdtempSync(path.join(os.tmpdir(), "tc test "));
    const r = spawnSync(process.execPath, [script, "--jobs", String(jobs)], { cwd: root, env: env(d), encoding: "utf8" });
    expect(r.status).toBe(0);
    expect(peak(d)).toBeLessThanOrEqual(jobs);
    expect(existsSync(path.join(d, "heavy.lock.d"))).toBe(false);
  }, 30000);

  it("returns the original nonzero code on failure", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "tc-fail-"));
    const r = spawnSync(process.execPath, [script], { cwd: root, env: env(d, { FAKE_TSC_FAIL: "packages_ai" }), encoding: "utf8" });
    expect(r.status).toBe(7);
    expect(existsSync(path.join(d, "heavy.lock.d"))).toBe(false);
  }, 30000);

  it("times out with 124 and releases the lock", () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "tc-to-"));
    const r = spawnSync(process.execPath, [script, "--timeout-ms", "500"], { cwd: root, env: env(d, { FAKE_TSC_MS: "5000" }), encoding: "utf8" });
    expect(r.status).toBe(124);
    expect(existsSync(path.join(d, "heavy.lock.d"))).toBe(false);
  }, 30000);

  it("rejects bad arguments with 2", () => {
    const r = spawnSync(process.execPath, [script, "--jobs", "0"], { cwd: root, encoding: "utf8" });
    expect(r.status).toBe(2);
  });

  it.skipIf(process.platform === "win32")("SIGTERM reclaims children and lock", async () => {
    const d = mkdtempSync(path.join(os.tmpdir(), "tc-sig-"));
    const c = spawn(process.execPath, [script], { cwd: root, env: env(d, { FAKE_TSC_MS: "10000" }) });
    await new Promise((r) => setTimeout(r, 1500));
    c.kill("SIGTERM");
    const code = await new Promise((r) => c.on("exit", (code, sig) => r(code ?? sig)));
    expect(code).toBe(143);
    await new Promise((r) => setTimeout(r, 300));
    const pids = readFileSync(path.join(d, "pids.log"), "utf8").trim().split("\n").map(Number);
    for (const p of pids) expect(() => process.kill(p, 0)).toThrow();
    expect(existsSync(path.join(d, "heavy.lock.d"))).toBe(false);
  }, 30000);
});
