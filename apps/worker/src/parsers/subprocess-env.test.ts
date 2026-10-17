import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeRunner } from "./docling-process";
import { createNodeMediaRunner } from "./media-process";
import { createParserSubprocessEnv } from "./subprocess-env";

afterEach(() => { vi.unstubAllEnvs(); });

const secrets = ["DATABASE_URL", "REDIS_URL", "S3_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "OPENAI_API_KEY", "OPENING_CONNECTION_KEY", "HF_TOKEN", "CUSTOM_SECRET"];

describe("parser subprocess environment", () => {
  it("allows runtime/cache settings, rejects credentials and loader hooks, and forces offline Python", () => {
    const source = {
      PATH: "/bin", HOME: "/home/worker", TMPDIR: "/tmp/worker", LANG: "zh_CN.UTF-8",
      HF_HOME: "/models/hf", PARSER_OCR_MODEL_DIR: "/models/ocr", OMP_NUM_THREADS: "2",
      PYTHONPATH: "/untrusted/python", PYTHONHOME: "/untrusted/home", NODE_OPTIONS: "--require=/untrusted/node",
      LD_PRELOAD: "/untrusted/lib.so", LD_LIBRARY_PATH: "/untrusted/lib", HTTPS_PROXY: "https://user:password@proxy",
      HF_HUB_OFFLINE: "0", PYTHONNOUSERSITE: "0", ...Object.fromEntries(secrets.map(key => [key, "sensitive"])),
    };
    expect(createParserSubprocessEnv("python", source)).toEqual({
      PATH: "/bin", HOME: "/home/worker", TMPDIR: "/tmp/worker", LANG: "zh_CN.UTF-8",
      HF_HOME: "/models/hf", PARSER_OCR_MODEL_DIR: "/models/ocr", OMP_NUM_THREADS: "2",
      PYTHONIOENCODING: "utf-8", PYTHONNOUSERSITE: "1", HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1", HF_HUB_DISABLE_IMPLICIT_TOKEN: "1",
    });
    expect(source.HF_HUB_OFFLINE).toBe("0");
  });

  it("gives ffmpeg only OS runtime settings", () => {
    expect(createParserSubprocessEnv("media", { PATH: "/bin", TEMP: "/tmp", HF_HOME: "/models", PARSER_OCR_MODEL_DIR: "/ocr", S3_SECRET_ACCESS_KEY: "secret" }))
      .toEqual({ PATH: "/bin", TEMP: "/tmp", AV_LOG_FORCE_NOCOLOR: "1" });
  });

  it.each(["python", "media"] as const)("actually excludes credentials from a spawned %s runner", async (kind) => {
    for (const key of secrets) vi.stubEnv(key, "sensitive-parent-value");
    vi.stubEnv("NODE_OPTIONS", "--trace-warnings");
    vi.stubEnv("HF_HOME", "/models/offline-cache");
    const script = `console.log(JSON.stringify({ leaked: ${JSON.stringify([...secrets, "NODE_OPTIONS"])}.filter(key => process.env[key] !== undefined), encoding: process.env.PYTHONIOENCODING, offline: process.env.HF_HUB_OFFLINE, cache: process.env.HF_HOME, noColor: process.env.AV_LOG_FORCE_NOCOLOR }))`;
    const signal = new AbortController().signal;
    const result = kind === "python"
      ? await createNodeRunner({ pythonExecutable: process.execPath, cwd: process.cwd() })(["-e", script], signal)
      : await createNodeMediaRunner({ ffmpegPath: process.execPath })("ffmpeg", ["-e", script], signal);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(kind === "python"
      ? { leaked: [], encoding: "utf-8", offline: "1", cache: "/models/offline-cache" }
      : { leaked: [], noColor: "1" });
  });
});
