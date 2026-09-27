import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversionArgs,
  convertToMeetingAudio,
  downloadResumable,
  assertFileDigest,
  sha256File,
  validatePreparedMedia,
} from "./media.mjs";

async function tempDir() {
  return mkdtemp(path.join(os.tmpdir(), "notion-pipeline-media-"));
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

describe("pipeline media helpers", () => {
  it("streams a file hash without loading it through a text API", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, "source.bin");
      await writeFile(file, Buffer.from("abc\0def"));
      await expect(sha256File(file)).resolves.toEqual({
        bytes: 7,
        sha256: digest(Buffer.from("abc\0def")),
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a file whose persisted manifest digest no longer matches", async () => {
    const dir = await tempDir();
    try {
      const file = path.join(dir, "source.bin");
      await writeFile(file, "changed");
      await expect(assertFileDigest(file, { bytes: 3, sha256: digest(Buffer.from("old")) })).rejects.toThrow(/match/i);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes a partial download with a Range request and atomically finishes it", async () => {
    const payload = Buffer.from("complete-source-payload");
    const dir = await tempDir();
    let rangeHeader = null;
    const server = createServer((request, response) => {
      rangeHeader = request.headers.range ?? null;
      const start = rangeHeader ? Number(String(rangeHeader).match(/bytes=(\d+)-/)?.[1] ?? 0) : 0;
      const body = payload.subarray(start);
      response.statusCode = rangeHeader ? 206 : 200;
      response.setHeader("Content-Length", body.length);
      if (rangeHeader) response.setHeader("Content-Range", `bytes ${start}-${payload.length - 1}/${payload.length}`);
      response.end(body);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = server.address().port;
      const destination = path.join(dir, "source.bin");
      await writeFile(`${destination}.part`, payload.subarray(0, 9));
      const result = await downloadResumable(`http://127.0.0.1:${port}/source`, destination, {
        expectedBytes: payload.length,
        expectedSha256: digest(payload),
      });
      expect(rangeHeader).toBe("bytes=9-");
      expect(result).toMatchObject({ bytes: payload.length, sha256: digest(payload), resumed: true });
      await expect(readFile(destination)).resolves.toEqual(payload);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("builds a full-duration mono AAC conversion command", () => {
    expect(buildConversionArgs("input.mp4", "output.m4a")).toEqual([
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      "input.mp4",
      "-map",
      "0:a:0",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-movflags",
      "+faststart",
      "output.m4a",
    ]);
  });

  it("rejects a prepared file whose duration or bytes do not match the source", () => {
    expect(() => validatePreparedMedia({
      sourceDurationSeconds: 5_955,
      preparedDurationSeconds: 5_600,
      preparedBytes: 100,
      maxBytes: 1_000,
    })).toThrow(/duration/i);
    expect(() => validatePreparedMedia({
      sourceDurationSeconds: 5_955,
      preparedDurationSeconds: 5_954.5,
      preparedBytes: 1_001,
      maxBytes: 1_000,
    })).toThrow(/size/i);
  });

  it("renames a successful conversion only after post-conversion validation", async () => {
    const dir = await tempDir();
    try {
      const input = path.join(dir, "input.mp4");
      const output = path.join(dir, "prepared.m4a");
      await writeFile(input, "input");
      const calls = [];
      const result = await convertToMeetingAudio(input, output, {
        run: async (_command, args) => {
          calls.push(args);
          await writeFile(args.at(-1), "encoded");
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        inspect: async (file) => ({
          path: file,
          durationSeconds: 5_954.5,
          streams: [{ codecType: "audio", codecName: "aac", sampleRate: 16_000, channels: 1 }],
        }),
        sourceDurationSeconds: 5_955,
        maxBytes: 1_000,
      });
      expect(calls).toHaveLength(1);
      expect(calls[0].at(-1)).toMatch(/\.part-\d+-\d+-[0-9a-f-]{36}\.m4a$/);
      expect(result).toMatchObject({ durationSeconds: 5_954.5, bytes: 7 });
      await expect(readFile(output, "utf8")).resolves.toBe("encoded");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires the prepared artifact to be 16 kHz mono AAC", async () => {
    const { assertMeetingAudioProfile } = await import("./media.mjs");
    expect(() => assertMeetingAudioProfile({
      streams: [{ codecType: "audio", codecName: "aac", sampleRate: 48_000, channels: 2 }],
    })).toThrow(/16 kHz mono AAC/i);
    expect(assertMeetingAudioProfile({
      streams: [{ codecType: "audio", codecName: "aac", sampleRate: 16_000, channels: 1 }],
    })).toMatchObject({ accepted: true });
  });
});
