import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const workflowPath = path.join(root, ".github/workflows/ci.yml");

describe("CI workflow contract", () => {
  it("exists at .github/workflows/ci.yml", () => {
    expect(existsSync(workflowPath)).toBe(true);
  });

  it("runs install, lint, typecheck, test, integration, and build gates", () => {
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
      "npm run build",
    ]) {
      expect(yaml).toContain(command);
    }

    expect(yaml).toMatch(/services:/);
    expect(yaml).toMatch(/postgres:/i);
    expect(yaml).toMatch(/redis:/i);
    expect(yaml).toMatch(/minio/i);

    expect(yaml).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(yaml).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(yaml).not.toMatch(/BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
  });
});
