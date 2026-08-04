import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function read(relativePath: string): string {
  const absolutePath = path.join(root, relativePath);
  expect(existsSync(absolutePath), `${relativePath} should exist`).toBe(true);
  return readFileSync(absolutePath, "utf8");
}

describe("cloud deployment contract", () => {
  it("provides a standalone Web container and Render blueprint", () => {
    const dockerfile = read("Dockerfile");
    const ignore = read(".dockerignore");
    const render = read("infra/deploy/render.yaml");

    expect(dockerfile).toContain("npm ci");
    expect(dockerfile).toContain("npx next build");
    expect(dockerfile).toContain(".next/standalone");
    expect(dockerfile).toContain("HOSTNAME=0.0.0.0");
    expect(dockerfile).toContain("apps/web/server.js");
    expect(dockerfile).toContain("HEALTHCHECK");
    expect(ignore).toContain(".env");
    expect(ignore).toContain("node_modules");
    expect(render).toContain("runtime: docker");
    expect(render).toContain("dockerfilePath: ./Dockerfile");
    expect(render).toContain("healthCheckPath: /api/health");
    expect(render).toContain("preDeployCommand: npm run db:migrate");
    expect(render).toContain("key: DATABASE_URL");
  });

  it("does not embed credentials in deployment files", () => {
    const content = [
      read("Dockerfile"),
      read(".dockerignore"),
      read("infra/deploy/render.yaml"),
      read("docs/operations/cloud-deployment.md"),
    ].join("\n");

    expect(content).not.toMatch(/postgres:\/\/[^\s]+:[^\s]+@/i);
    expect(content).not.toMatch(/minioadmin/);
    expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(content).not.toMatch(/BEGIN (RSA |OPENSSH )?PRIVATE KEY/);
  });

  it("documents every required production environment variable", () => {
    const guide = read("docs/operations/cloud-deployment.md");
    for (const variable of [
      "DATABASE_URL",
      "REDIS_URL",
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_BUCKET",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "PUBLIC_BASE_URL",
      "AUTH_SECRET",
      "SESSION_COOKIE_SECURE",
    ]) {
      expect(guide).toContain(variable);
    }
  });
});
