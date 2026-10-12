import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const run = (webRoot?: string) =>
  spawnSync(process.execPath, [path.join(root, "scripts/check-server-boundary.mjs")], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(webRoot ? { BOUNDARY_WEB_ROOT: webRoot } : {}) },
  });

describe("scripts/check-server-boundary.mjs (plan §7.4)", () => {
  it("passes for the real apps/web graph", () => {
    const r = run();
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("fails on transitive re-export and dynamic import from a Client Component", () => {
    const r = run("tests/fixtures/server-boundary/bad");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/client\.tsx reaches .*data\.ts \(server-only\)/);
    expect(r.stderr).toMatch(/helper\.ts:1 -> \.\/data \[reexport\]/);
    expect(r.stderr).toMatch(/lazy\.ts:1 -> postgres \[dynamic\]/);
  });

  it("ignores type-only imports (erased at compile time)", () => {
    const r = run("tests/fixtures/server-boundary/good");
    expect(r.status).toBe(0);
  });
});
