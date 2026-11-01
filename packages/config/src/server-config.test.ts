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
    // These Next build literals describe the artifact, not operator runtime settings.
    // The release script supplies COMMIT; next.config pins it with the build timestamp.
    const ignored = new Set(["NEXT_RUNTIME", "CI", "AISTUDY_BUILD_CONFIG_DIGEST", "AISTUDY_COMMIT", "AISTUDY_BUILT_AT"]);
    expect([...names].filter((n) => !known.has(n) && !ignored.has(n)).sort()).toEqual([]);
  });
});

describe("startup validation", () => {
  it("missing required value fails with the variable name", () => {
    const env = devEnv();
    delete env.DATABASE_URL;
    expect(issuesOf(() => loadServerConfig(env, "web")).join("\n")).toMatch(/DATABASE_URL/);
  });

  it.each(["OPENING_TEACHING_LOOP", "OPENING_RELEASE"])("invalid boolean %s fails", (name) => {
    const issues = issuesOf(() => loadServerConfig({ ...devEnv(), [name]: "enabled" }, "web"));
    expect(issues).toContain(`${name}: invalid boolean "enabled" (use 1/0/true/false)`);
  });

  it("accepts 1/0/true/false/yes/no case-insensitively", () => {
    for (const [raw, value] of [["1", true], ["TRUE", true], ["yes", true], ["0", false], ["False", false], ["no", false]] as const) {
      expect(loadFeatureSwitches({ OPENING_TEACHING_LOOP: raw }).teachingLoop.api).toBe(value);
    }
  });

  it("missing dependency: UI shown without API enabled", () => {
    expect(issuesOf(() => loadFeatureSwitches({ OPENING_TEACHING_WORKSPACE: "1", OPENING_TEACHING_LOOP: "0" })).join()).toMatch(/OPENING_TEACHING_WORKSPACE=1 .* requires OPENING_TEACHING_LOOP=1/);
  });

  it("ignores retired server controls at startup without changing fixed public capabilities", () => {
    const config = loadServerConfig({ ...devEnv(), OPENING_TEACHING_LOOP: "0",
      OPENING_MATRIX_TRANSFORM_INTERACTIVE: "invalid", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "101", OPENING_PLAN_AGENT: "invalid" }, "web");
    expect(resolveCapabilities(config.switches, "owner")).toMatchObject({
      teachingLoop: { api: false, ui: false }, matrixTransformInteractive: true, planAgent: false,
    });
  });

  it("missing dependency: connection key id without key, partial DingTalk callback", () => {
    expect(collectEnvIssues({ ...devEnv(), OPENING_CONNECTION_KEY_ID: "k2" }, "web").join()).toMatch(/require OPENING_CONNECTION_KEY/);
    expect(collectEnvIssues({ ...devEnv(), OPENING_DINGTALK_CORP_ID: "corp" }, "web").join()).toMatch(/DingTalk callback needs all/);
  });

  it("rejects NEXT_PUBLIC_* (removed twins name their server switch)", () => {
    const issues = collectEnvIssues({ ...devEnv(), NEXT_PUBLIC_OPENING_TEACHING_LOOP: "1", NEXT_PUBLIC_FOO: "x" }, "web");
    expect(issues.join("\n")).toMatch(/NEXT_PUBLIC_OPENING_TEACHING_LOOP: removed build-time twin; set the server switch OPENING_TEACHING_LOOP/);
    expect(issues.join("\n")).toMatch(/NEXT_PUBLIC_FOO: build-time public variables are not allowed/);
    expect(collectEnvIssues({ ...devEnv(), NEXT_PUBLIC_OPENING_MATRIX_TRANSFORM_INTERACTIVE: "0" }, "web").join())
      .toMatch(/NEXT_PUBLIC_OPENING_MATRIX_TRANSFORM_INTERACTIVE: build-time public variables are not allowed/);
  });

  it("build digest mismatch fails; matching digest passes", () => {
    const env = devEnv();
    expect(() => loadServerConfig(env, "web", { compiledBuildDigest: computeBuildConfigDigest({}) })).not.toThrow();
    expect(issuesOf(() => loadServerConfig(env, "web", { compiledBuildDigest: computeBuildConfigDigest({ NEXT_PUBLIC_X: "1" }) })).join()).toMatch(/digest mismatch/);
  });

  it("invalid study session account IDs fail startup without echoing the list", () => {
    const issues = issuesOf(() => loadServerConfig({ ...devEnv(), OPENING_STUDY_SESSION_V2_USERS: "private-account,*" }, "web"));
    expect(issues).toContain("OPENING_STUDY_SESSION_V2_USERS: expected at most 100 explicit account IDs (no wildcard)");
    expect(issues.join("\n")).not.toContain("private-account");
  });

  it("issues never echo secret values", () => {
    const issues = collectEnvIssues({ ...devEnv(), AUTH_SECRET: "short-secret-marker" }, "web");
    expect(issues.join("\n")).not.toContain("short-secret-marker");
  });
});

describe("capabilities", () => {
  const sw = (env: Record<string, string>) => loadFeatureSwitches(env);

  it("closes production registration unless explicitly opened", () => {
    expect(resolveCapabilities(sw({ NODE_ENV: "production" }), null).registrationOpen).toBe(false);
    expect(resolveCapabilities(sw({ NODE_ENV: "production", OPENING_RELEASE: "0" }), null).registrationOpen).toBe(true);
    expect(resolveCapabilities(sw({ NODE_ENV: "development" }), null).registrationOpen).toBe(true);
  });

  it("anonymous users never get the loop", () => {
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" }), null).teachingLoop).toEqual({ api: false, ui: false });
  });

  it("retains authenticated API/UI controls after retiring rollout", () => {
    expect(resolveCapabilities(sw({}), "u1").teachingLoop).toEqual({ api: true, ui: true });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "0" }), "u1").teachingLoop).toEqual({ api: false, ui: false });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_WORKSPACE: "0" }), "u1").teachingLoop).toEqual({ api: true, ui: false });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "0" }), "u1").teachingLoop).toEqual({ api: true, ui: true });
    expect(resolveCapabilities(sw({}), null).teachingLoop).toEqual({ api: false, ui: false });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1" }), "u1").teachingLoop).toEqual({ api: true, ui: true });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1" }), "u1").teachingLoop).toEqual({ api: true, ui: true });
    expect(resolveCapabilities(sw({ OPENING_TEACHING_LOOP: "1", OPENING_TEACHING_WORKSPACE: "1", OPENING_TEACHING_LOOP_ROLLOUT_PERCENT: "0" }), "u1").teachingLoop).toEqual({ api: true, ui: true });
  });

  it("keeps the fixed compatibility fields and never grants anonymous teaching access", () => {
    const switches = sw({ OPENING_MATRIX_TRANSFORM_INTERACTIVE: "0", OPENING_PLAN_AGENT: "1", OPENING_ADAPTIVE_PLANNING: "1" });
    for (const userId of [null, "user-a", "USER-A", "user-b"]) {
      expect(resolveCapabilities(switches, userId)).toMatchObject({ matrixTransformInteractive: true, planAgent: false,
        teachingLoop: { api: userId !== null, ui: userId !== null } });
    }
  });

  it("enables study session V2 only for explicit accounts when the global switch is off", () => {
    const switches = sw({ OPENING_STUDY_SESSION_V2: "0", OPENING_STUDY_SESSION_V2_USERS: " learner-1, Learner_2, ," });
    expect(resolveCapabilities(switches, "learner-1").studySessionV2).toBe(true);
    expect(resolveCapabilities(switches, "Learner_2").studySessionV2).toBe(true);
    for (const userId of ["other", "learner", "learner_2", null]) {
      expect(resolveCapabilities(switches, userId).studySessionV2).toBe(false);
    }
  });

  it("keeps the global study session switch compatible and anonymous access closed", () => {
    const switches = sw({ OPENING_STUDY_SESSION_V2: "1", OPENING_STUDY_SESSION_V2_USERS: "learner" });
    for (const userId of ["learner", "other"]) expect(resolveCapabilities(switches, userId).studySessionV2).toBe(true);
    expect(resolveCapabilities(switches, null).studySessionV2).toBe(false);
    for (const env of [{ OPENING_TEACHING_LOOP: "0" }, { OPENING_TEACHING_WORKSPACE: "0" }]) {
      const disabled = sw({ ...env, OPENING_STUDY_SESSION_V2: "1", OPENING_STUDY_SESSION_V2_USERS: "learner", OPENING_STUDY_SESSION_V2_PHOTO_ANSWER: "1" });
      expect(resolveCapabilities(disabled, "learner")).toMatchObject({ studySessionV2: false, studySessionV2PhotoAnswer: false });
    }
  });

  it.each(["0", "1"])("photo answers require per-account V2 access and photo switch=%s", (photo) => {
    const switches = sw({ OPENING_STUDY_SESSION_V2_USERS: "learner", OPENING_STUDY_SESSION_V2_PHOTO_ANSWER: photo });
    expect(resolveCapabilities(switches, "learner")).toMatchObject({ studySessionV2: true, studySessionV2PhotoAnswer: photo === "1" });
    for (const userId of ["other", null]) {
      expect(resolveCapabilities(switches, userId)).toMatchObject({ studySessionV2: false, studySessionV2PhotoAnswer: false });
    }
    const global = sw({ OPENING_STUDY_SESSION_V2: "1", OPENING_STUDY_SESSION_V2_PHOTO_ANSWER: photo });
    expect(resolveCapabilities(global, "other").studySessionV2PhotoAnswer).toBe(photo === "1");
    expect(resolveCapabilities(global, null).studySessionV2PhotoAnswer).toBe(false);
  });

  it("chat 图解 is off by default and follows OPENING_CHAT_ARTIFACTS", () => {
    expect(resolveCapabilities(sw({}), "u1").chatArtifacts).toBe(false);
    expect(resolveCapabilities(sw({ OPENING_CHAT_ARTIFACTS: "1" }), "u1").chatArtifacts).toBe(true);
  });

  it("chat prose rendering is on by default and can be switched off", () => {
    expect(resolveCapabilities(sw({}), "u1").chatProse).toBe(true);
    expect(resolveCapabilities(sw({ OPENING_CHAT_PROSE: "0" }), "u1").chatProse).toBe(false);
  });

  it("SenseWeave defaults to shadow, accepts off/shadow/on and needs prose", () => {
    expect(resolveCapabilities(sw({}), "u1").chatSenseWeave).toBe("shadow");
    expect(resolveCapabilities(sw({ OPENING_CHAT_SENSEWEAVE: "on" }), "u1").chatSenseWeave).toBe("shadow");
    expect(resolveCapabilities(sw({ OPENING_CHAT_SENSEWEAVE: "on", OPENING_CHAT_SENSEWEAVE_BETA_USERS: "u1" }), "u1").chatSenseWeave).toBe("on");
    expect(resolveCapabilities(sw({ OPENING_CHAT_SENSEWEAVE: "on", OPENING_CHAT_SENSEWEAVE_BETA_USERS: "u1" }), "u2").chatSenseWeave).toBe("shadow");
    expect(resolveCapabilities(sw({}), null).chatSenseWeave).toBe("off");
    expect(resolveCapabilities(sw({ OPENING_CHAT_SENSEWEAVE: "on", OPENING_CHAT_PROSE: "0" }), "u1").chatSenseWeave).toBe("off");
    expect(() => sw({ OPENING_CHAT_SENSEWEAVE: "maybe" })).toThrow(/OPENING_CHAT_SENSEWEAVE/);
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
