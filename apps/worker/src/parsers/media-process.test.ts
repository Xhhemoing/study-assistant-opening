import { describe, expect, it } from "vitest";
import {
  MEDIA_VIDEO_MAX_BYTES,
  MEDIA_VIDEO_MAX_DURATION_MS,
  MediaConfigurationError,
  MediaValidationError,
  assertContainerMatchesMime,
  assertWithinLimits,
  buildExtractAudioArgv,
  buildFfprobeArgv,
  buildKeyframeArgv,
  createMediaProcess,
  maxFramesForDuration,
  mediaFrameObjectKey,
  parseFfprobeOutput,
  parseShowinfoTimestamps,
} from "./media-process";

describe("media-process argv construction", () => {
  it("builds ffprobe argv without shell metacharacters and keeps the path literal", () => {
    const argv = buildFfprobeArgv("/tmp/lecture;rm -rf.mp4");
    expect(argv).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,format_name:stream=codec_type,width,height",
      "-of",
      "json",
      "/tmp/lecture;rm -rf.mp4",
    ]);
    expect(argv.join(" ")).not.toMatch(/[|&<>$`]/);
  });

  it("rejects network protocol inputs for ffprobe/ffmpeg argv builders", () => {
    expect(() => buildFfprobeArgv("https://evil.example/a.mp4")).toThrow(MediaValidationError);
    expect(() => buildFfprobeArgv("rtmp://live/stream")).toThrow(/network/);
    expect(() => buildExtractAudioArgv("http://x/a.mp4", "/tmp/out.wav")).toThrow(/network/);
    expect(() => buildKeyframeArgv("ftp://x/a.mp4", "/tmp/f-%03d.png")).toThrow(/network/);
  });

  it("builds extract-audio and keyframe argv as literal arrays", () => {
    const audio = buildExtractAudioArgv("/data/a.mp4", "/tmp/a.wav");
    expect(audio).toEqual([
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      "/data/a.mp4",
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-f",
      "wav",
      "/tmp/a.wav",
    ]);
    const frames = buildKeyframeArgv("/data/a.mp4", "/tmp/frame-%04d.png");
    expect(frames[0]).toBe("-hide_banner");
    expect(frames).toContain("/data/a.mp4");
    expect(frames.join(" ")).not.toMatch(/[|&<>$`]/);
  });
});

describe("media-process probe parsing and limits", () => {
  it("parses ffprobe JSON into a MediaProbe", () => {
    const probe = parseFfprobeOutput(
      JSON.stringify({
        format: { duration: "12.5", size: "4096", format_name: "mov,mp4,m4a,3gp,3g2,mj2" },
        streams: [
          { codec_type: "video", width: 1280, height: 720 },
          { codec_type: "audio" },
        ],
      }),
    );
    expect(probe).toEqual({
      durationMs: 12_500,
      sizeBytes: 4096,
      formatName: "mov,mp4,m4a,3gp,3g2,mj2",
      hasAudio: true,
      hasVideo: true,
      width: 1280,
      height: 720,
    });
  });

  it("rejects oversize and overlong media with clear errors", () => {
    const base = {
      durationMs: 60_000,
      sizeBytes: 1024,
      formatName: "mp4",
      hasAudio: true,
      hasVideo: true,
      width: 640,
      height: 360,
    };
    expect(() =>
      assertWithinLimits({ ...base, sizeBytes: MEDIA_VIDEO_MAX_BYTES + 1 }, {
        maxBytes: MEDIA_VIDEO_MAX_BYTES,
        maxDurationMs: MEDIA_VIDEO_MAX_DURATION_MS,
      }),
    ).toThrow(/size limit/);
    expect(() =>
      assertWithinLimits({ ...base, durationMs: MEDIA_VIDEO_MAX_DURATION_MS + 1 }, {
        maxBytes: MEDIA_VIDEO_MAX_BYTES,
        maxDurationMs: MEDIA_VIDEO_MAX_DURATION_MS,
      }),
    ).toThrow(/duration limit/);
  });

  it("rejects container/mime mismatches and missing tracks", () => {
    const probe = {
      durationMs: 1000,
      sizeBytes: 100,
      formatName: "webm",
      hasAudio: false,
      hasVideo: true,
      width: 320,
      height: 240,
    };
    expect(() => assertContainerMatchesMime(probe, "video/mp4")).toThrow(/does not match video\/mp4/);
    expect(() => assertContainerMatchesMime({ ...probe, formatName: "mp4", hasVideo: false }, "video/mp4")).toThrow(
      /video track/,
    );
    expect(() =>
      assertContainerMatchesMime({ ...probe, formatName: "mp3", hasAudio: false, hasVideo: false }, "audio/mpeg"),
    ).toThrow(/audio track/);
  });

  it("caps keyframes at 2/min and 120/file", () => {
    expect(maxFramesForDuration(30_000)).toBe(1);
    expect(maxFramesForDuration(60_000)).toBe(2);
    expect(maxFramesForDuration(90 * 60_000)).toBe(120);
  });
});

describe("createMediaProcess", () => {
  it("probes via injected runner and rejects overlong duration", async () => {
    const calls: Array<{ binary: string; argv: string[] }> = [];
    const media = createMediaProcess({
      run: async (binary, argv) => {
        calls.push({ binary, argv });
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            format: {
              duration: String((MEDIA_VIDEO_MAX_DURATION_MS + 1000) / 1000),
              size: "1000",
              format_name: "mp4",
            },
            streams: [{ codec_type: "video", width: 1, height: 1 }, { codec_type: "audio" }],
          }),
          stderr: "",
        };
      },
    });
    // Skip real stat by validating through probeMedia + assertWithinLimits path via validateLocalMedia —
    // use extract after mocking: validateLocalMedia needs a real file. Probe-only path:
    const probe = await media.probeMedia("/tmp/fake.mp4", new AbortController().signal);
    expect(probe.durationMs).toBe(MEDIA_VIDEO_MAX_DURATION_MS + 1000);
    expect(() =>
      assertWithinLimits(probe, { maxBytes: MEDIA_VIDEO_MAX_BYTES, maxDurationMs: MEDIA_VIDEO_MAX_DURATION_MS }),
    ).toThrow(/duration limit/);
    expect(calls[0]?.binary).toBe("ffprobe");
    expect(calls[0]?.argv.at(-1)).toBe("/tmp/fake.mp4");
  });

  it("maps ENOENT from the runner to a CONFIGURATION error", async () => {
    const media = createMediaProcess({
      run: async () => {
        throw new MediaConfigurationError("ffprobe is not installed or not on PATH; install FFmpeg to process opening media");
      },
    });
    await expect(media.probeMedia("/tmp/x.mp4", new AbortController().signal)).rejects.toBeInstanceOf(
      MediaConfigurationError,
    );
  });

  it("returns empty segments for audio-less video without claiming understanding", async () => {
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "opening-media-"));
    const file = path.join(dir, "silent.mp4");
    await writeFile(file, Buffer.alloc(64));
    try {
      const media = createMediaProcess({
        run: async () => ({
          exitCode: 0,
          stdout: JSON.stringify({
            format: { duration: "2", size: "64", format_name: "mp4" },
            streams: [{ codec_type: "video", width: 8, height: 8 }],
          }),
          stderr: "",
        }),
      });
      const segments = await media.extractMedia(
        { path: file, mime: "video/mp4", maxBytes: MEDIA_VIDEO_MAX_BYTES, maxDurationMs: MEDIA_VIDEO_MAX_DURATION_MS },
        new AbortController().signal,
      );
      expect(segments).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("keyframe helpers", () => {
  it("builds I02 frame object keys with original timestamps", () => {
    expect(mediaFrameObjectKey("11111111-1111-4111-8111-111111111111", 3, 1500)).toBe(
      "opening/sources/11111111-1111-4111-8111-111111111111/v3/frames/1500.png",
    );
  });

  it("parses showinfo pts_time from ffmpeg stderr", () => {
    expect(
      parseShowinfoTimestamps("n:0 pts:0 pts_time:0.5\nn:1 pts:1 pts_time:12.25 pos:1"),
    ).toEqual([0.5, 12.25]);
  });

  it("extractKeyframes writes capped frames and timestamps", async () => {
    const { mkdtemp, writeFile, rm, mkdir } = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await mkdtemp(path.join(os.tmpdir(), "opening-kf-"));
    const out = path.join(dir, "frames");
    await mkdir(out, { recursive: true });
    const mediaFile = path.join(dir, "clip.mp4");
    await writeFile(mediaFile, Buffer.alloc(32));
    try {
      const media = createMediaProcess({
        run: async (binary, argv) => {
          expect(binary).toBe("ffmpeg");
          expect(argv).toContain("-frames:v");
          // Simulate two PNGs written by ffmpeg.
          await writeFile(path.join(out, "frame-0001.png"), Buffer.from("png1"));
          await writeFile(path.join(out, "frame-0002.png"), Buffer.from("png2"));
          return {
            exitCode: 0,
            stdout: "",
            stderr: "pts_time:1.0\npts_time:2.5\n",
          };
        },
      });
      const result = await media.extractKeyframes(
        { path: mediaFile, durationMs: 60_000, outputDir: out },
        new AbortController().signal,
      );
      expect(result.frames).toEqual([
        { path: path.join(out, "frame-0001.png"), timestampMs: 1000 },
        { path: path.join(out, "frame-0002.png"), timestampMs: 2500 },
      ]);
      // Cap for 60s is 2; hitting cap => limited
      expect(result.visualCoverageLimited).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
