import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSprintPack, generateSprintPack } from "../fixtures/sprint-pack/generate.mjs";
import {
  loadPack, readArchive, verifyConjugate, verifyGbk, verifyImageOnly,
  verifyManifest, verifyPdfPages, verifyRepeatedQuestions, verifySpecialEntries,
} from "../fixtures/sprint-pack/verify.mjs";

const generator = fileURLToPath(new URL("../fixtures/sprint-pack/generate.mjs", import.meta.url));
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let temporary: string;
let pack: Awaited<ReturnType<typeof loadPack>>;

beforeAll(async () => {
  temporary = await mkdtemp(path.join(os.tmpdir(), "aistudy-sprint-pack-"));
  await generateSprintPack({ seed: "opt-00-integration", outDir: path.join(temporary, "first") });
  pack = await loadPack(path.join(temporary, "first"));
});

afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

describe("OPT-00 deterministic synthetic sprint pack", () => {
  it("emits identical ZIP and manifest bytes for the same seed in separate processes/timezones", async () => {
    for (const [directory, timezone] of [["cli-a", "Pacific/Honolulu"], ["cli-b", "Asia/Shanghai"]]) {
      const result = spawnSync(process.execPath, [generator, "--seed", "opt-00-integration", "--out", path.join(temporary, directory!)], {
        encoding: "utf8", env: { ...process.env, TZ: timezone }, timeout: 15_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).sha256).toBe(hash(pack.archive));
      expect(await readFile(path.join(temporary, directory!, "sprint-pack.zip"))).toEqual(pack.archive);
      expect(await readFile(path.join(temporary, directory!, "manifest.json")))
        .toEqual(await readFile(path.join(temporary, "first", "manifest.json")));
    }
    const different = buildSprintPack("opt-00-another-seed");
    expect(hash(different.archive)).not.toBe(hash(pack.archive));
    expect(different.manifest.expected).toEqual(pack.manifest.expected);
  }, 30_000); // Two real Node CLI starts on the throttled/shared CI host.

  it("checks both actual ZIP layers, CRCs, raw headers, counts and manifest payload hashes", () => {
    verifyManifest(pack);
  });

  it("decodes the genuine GBK member name with UTF-8 flag clear in both headers", () => {
    verifyGbk(pack);
  });

  it("loads every accepted PDF and parses exactly five documents / seven pages", async () => {
    expect(await verifyPdfPages(pack)).toEqual({ count: 5, pages: 7 });
  });

  it("extracts repeated question 1/2 on separate question and answer pages of ONE PDF", async () => {
    await verifyRepeatedQuestions(pack);
  });

  it("extracts z plus combining overbar and renders the actual bar above z", async () => {
    await verifyConjugate(pack);
  });

  it("decodes and renders an image-only PDF with no text-show operators or extracted text", async () => {
    await verifyImageOnly(pack);
  });

  it("contains real metadata/traversal/DOCX cases without extracting unsafe members", async () => {
    await verifySpecialEntries(pack);
    await expect(access(path.join(temporary, "x.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(temporary, "first", "x.pdf"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(path.join(temporary, "first", "materials"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails independent CRC verification after an actual ZIP payload byte changes", async () => {
    const damaged = Buffer.from(pack.archive);
    // Mutate only the first stored payload, leaving both header CRCs unchanged.
    const firstPayload = 30 + damaged.readUInt16LE(26) + damaged.readUInt16LE(28);
    damaged[firstPayload] = damaged[firstPayload]! ^ 1;
    await expect(readArchive(damaged)).rejects.toThrow(/CRC32/);
  });

  it("validates seed bounds before creating any files", async () => {
    await expect(generateSprintPack({ seed: "", outDir: path.join(temporary, "invalid") })).rejects.toThrow(/seed/);
    await expect(access(path.join(temporary, "invalid"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(() => buildSprintPack("测".repeat(43))).toThrow(/128 bytes/);
  });
});
