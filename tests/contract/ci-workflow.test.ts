import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/ci.yml");
const runHeavyPath = path.join(root, "scripts/run-heavy.sh");

describe("CI workflow contract", () => {
  it("exists at .github/workflows/ci.yml", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("runs install, lint, typecheck, test, handler, browser, integration, and build gates", () => {
    const yaml = readFileSync(workflowPath, "utf8");

    expect(yaml).toMatch(/name:\s*CI/i);
    expect(yaml).toMatch(/^on:/m);
    expect(yaml).toMatch(/pull_request:/);
    expect(yaml).toMatch(/push:/);

    for (const command of [
      "npm ci",
      "npm run lint",
      "npm run typecheck",
      "npm test",
      "npm run test:integration",
      "npm run test:handler",
      "npm run test:browser",
      "npm run build",
    ]) {
      expect(yaml).toContain(command);
    }

    expect(yaml).toMatch(/services:/);
    expect(yaml).toMatch(/postgres:/i);
    expect(yaml).toMatch(/postgres-e2e:/i);
    expect(yaml).toMatch(/5433:5432/);
    expect(yaml).toMatch(/redis:/i);
    expect(yaml).toMatch(/minio/i);

    expect(yaml).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(yaml).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(yaml).not.toMatch(/BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
  });

  it("runs the child and preserves its exit code when host scheduling tools are unavailable", () => {
    const result = spawnSync(
      "bash",
      [
        "-c",
        'command() { return 1; }; export -f command; HERMES_HEAVY_LOCK_HELD=1 bash "$1" bash -c \'printf wrapper-ran; exit 23\'',
        "run-heavy-contract",
        runHeavyPath,
      ],
      { cwd: root, encoding: "utf8" },
    );

    expect(result.stdout).toBe("wrapper-ran");
    expect(result.status).toBe(23);
  });
});
