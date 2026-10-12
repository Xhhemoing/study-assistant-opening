import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EnvValidationError } from "./env";
import { renderEnvTemplate, ENV_TEMPLATE_FILES } from "./env-template";
import { ENV_REGISTRY, SECRET_ENV_NAMES } from "./registry";
import {
  collectEnvIssues,
  loadFeatureSwitches,
  loadServerConfig,
  resolveCapabilities,
  rolloutBucket,
} from "./server-config";
import { acceptCapabilitiesResponse, CLOSED_CAPABILITIES, computeBuildConfigDigest } from "./public";

const repoRoot = path.resolve(__dirname, "../../..");

function parseTemplate(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}

const devEnv = () => parseTemplate(renderEnvTemplate("dev"));
const dockerEnv = () => parseTemplate(renderEnvTemplate("docker"));

function issuesOf(fn: () => unknown): string[] {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as EnvValidationError).issues;
  }
  throw new Error("expected EnvValidationError");
}

describe("env templates (single definition)", () => {
  it("committed templates equal the registry rendering", () => {
    for (const [target, file] of Object.entries(ENV_TEMPLATE_FILES)) {
      expect(readFileSync(path.join(repoRoot, file), "utf8"), file).toBe(renderEnvTemplate(target as "dev" | "docker"));
    }
  });

  it("templates set no NEXT_PUBLIC_* variable", () => {
    expect(Object.keys({ ...devEnv(), ...dockerEnv() }).filter((n) => n.startsWith("NEXT_PUBLIC_"))).toEqual([]);
  });

  it("both templates start web and worker cleanly", () => {
    for (const env of [devEnv(), dockerEnv()]) {
      expect(loadServerConfig(env, "web").role).toBe("web");
      expect(loadServerConfig(env, "worker").role).toBe("worker");
    }
  });

  it("every process.env name read by apps/packages is in the registry", () => {
    const names = new Set<string>();
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules" || entry === ".next" || entry === "dist") continue;
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx|mjs)$/.test(entry) && !/\.test\./.test(entry)) {
          const text = readFileSync(full, "utf8");
          for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g)) names.add((m[1] ?? m[2])!);
        }
      }
    };
    for (const dir of ["apps/web/src", "apps/worker/src", "packages"]) walk(path.join(repoRoot, dir));
    const known = new Set(ENV_REGISTRY.map((s) => s.name));
    // AISTUDY_BUILD_CONFIG_DIGEST is injected by next.config `env` at build, never set by operators.
    const ignored = new Set(["NEXT_RUNTIME", "CI", "AISTUDY_BUILD_CONFIG_DIGEST"]);
    expect([...names].filter((n) => !known.has(n) && !ignored.has(n)).sort()).toEqual([]);
  });
});

describe("startup validation", () => {
  it("missing required value fails with the variable name", () => {
    const env = devEnv();
    delete env.DATABASE_URL;
    expect(issuesOf(() => loadServerConfig(env, "web")).join("\n")).toMatch(/DATABASE_URL/);
  });

  it.each(["OPENING_TEACHING_LOOP", "OPENING_RELEASE", "OPENING_MATRIX_TRANSFORM_INTERACTIVE"])("invalid boolean %s fails", (name) => {
    const issues = issuesOf(() => loadServerConfig({ ...devEnv(), [name]: "enabled" }, "web"));
    expect(issues).toContain(`${name}: invalid boolean "enabled" (use 1/0/true/false)`);
  });

  it("accepts 1/0/true/false/yes/no case-insensitively", () => {
    for (const [raw, value] of [["1", true], ["TRUE", true], ["yes", true], ["0", false], ["False", false], ["no", false]] as const) {
      expect(loadFeatureSwitches({ OPENING_TEACHING_LOOP: raw }).teachingLoop.api).toBe(value);
    }
  });

  it("missing dependency: UI shown without API enabled", () => {
    expect(issuesOf(() => loadFeatureSwitches({ OPENING_TEACHING_WORKSPACE: "1" })).join()).toMatch(/OPENING_TEACHING_WORKSPACE=1 .* requires OPENING_TEACHING_LOOP=1/);
  });

  it("missing dependency: rollout without API, and rollout out of range", () => {
    expect(issuesOf(() => loadFeatureSwitches({ OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "50" })).join()).toMatch(/ROLLOUT_PERCENT is set/);
    expect(issuesOf(() => loadFeatureSwitches({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "101" })).join()).toMatch(/0-100/);
    expect(issuesOf(() => loadFeatureSwitches({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "12.5" })).join()).toMatch(/0-100/);
  });

  it("missing dependency: connection key id without key, partial DingTalk callback", () => {
    expect(collectEnvIssues({ ...devEnv(), OPENING_CONNECTION_KEY_ID: "k2" }, "web").join()).toMatch(/require OPENING_CONNECTION_KEY/);
    expect(collectEnvIssues({ ...devEnv(), OPENING_DINGTALK_CORP_ID: "corp" }, "web").join()).toMatch(/DingTalk callback needs all/);
  });

  it("rejects NEXT_PUBLIC_* (removed twins name their server switch)", () => {
    const issues = collectEnvIssues({ ...devEnv(), NEXT_PUBLIC_OPENING_TEACHING_LOOP: "1", NEXT_PUBLIC_FOO: "x" }, "web");
    expect(issues.join("\n")).toMatch(/NEXT_PUBLIC_OPENING_TEACHING_LOOP: removed build-time twin; set the server switch OPENING_TEACHING_LOOP/);
    expect(issues.join("\n")).toMatch(/NEXT_PUBLIC_FOO: build-time public variables are not allowed/);
  });

  it("build digest mismatch fails; matching digest passes", () => {
    const env = devEnv();
    expect(() => loadServerConfig(env, "web", { compiledBuildDigest: computeBuildConfigDigest({}) })).not.toThrow();
    expect(issuesOf(() => loadServerConfig(env, "web", { compiledBuildDigest: computeBuildConfigDigest({ NEXT_PUBLIC_X: "1" }) })).join()).toMatch(/digest mismatch/);
  });

  it("issues never echo secret values", () => {
    const issues = collectEnvIssues({ ...devEnv(), AUTH_SECRET: "short-secret-marker" }, "web");
    expect(issues.join("\n")).not.toContain("short-secret-marker");
  });
});

describe("capabilities", () => {
  const sw = (env: Record<string, string>) => loadFeatureSwitches(env);

  it("anonymous users never get the loop", () => {
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" }), null).teachingLoop).toEqual({ api: false, ui: false });
  });

  it("api/ui/rollout combinations", () => {
    expect(resolveCapabilities(sw({}), "u1").teachingLoop).toEqual({ api: false, ui: false });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1" }), "u1").teachingLoop).toEqual({ api: true, ui: false });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" }), "u1").teachingLoop).toEqual({ api: true, ui: true });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "0" }), "u1").teachingLoop).toEqual({ api: false, ui: false });
  });

  it("rollout bucket is stable and roughly proportional", () => {
    expect(rolloutBucket("user-a")).toBe(rolloutBucket("USER-A"));
    const switches = sw({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "30" });
    const on = Array.from({ length: 2000 }, (_, i) => resolveCapabilities(switches, `user-${i}`).teachingLoop.api).filter(Boolean).length;
    expect(on).toBeGreaterThan(450);
    expect(on).toBeLessThan(750);
  });

  it("capabilities contain only booleans (no secret names or values)", () => {
    const caps = resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1" }), "u1");
    const text = JSON.stringify(caps);
    for (const name of SECRET_ENV_NAMES) expect(text).not.toContain(name);
  });

  it("client fails closed on protocol/digest mismatch", () => {
    const digest = computeBuildConfigDigest({});
    const ok = { protocolVersion: 1, buildConfigDigest: digest, authenticated: true, capabilities: { ...CLOSED_CAPABILITIES, registrationOpen: true } };
    expect(acceptCapabilitiesResponse(ok, digest).compatible).toBe(true);
    expect(acceptCapabilitiesResponse(ok, "v1-other")).toMatchObject({ compatible: false, capabilities: CLOSED_CAPABILITIES });
    expect(acceptCapabilitiesResponse({ ...ok, protocolVersion: 2 }, digest)).toMatchObject({ compatible: false, capabilities: CLOSED_CAPABILITIES });
    expect(acceptCapabilitiesResponse({ ...ok, capabilities: { ...ok.capabilities, secret: "x" } }, digest).compatible).toBe(false);
  });
});
