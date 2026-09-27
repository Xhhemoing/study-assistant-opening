import { describe, expect, it } from "vitest";
import {
  DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES,
  assertCompleteDuration,
  assertSafeTarget,
  assertUploadSize,
  assessTranscript,
  makePipelineJobKey,
} from "./policy.mjs";

describe("Notion meeting pipeline policy", () => {
  it("rejects a short preview when the expected lecture duration is complete", () => {
    expect(() => assertCompleteDuration(60, 5_955, 15)).toThrow(/duration/i);
    expect(assertCompleteDuration(5_954.98, 5_955, 15)).toMatchObject({
      complete: true,
      differenceSeconds: expect.closeTo(-0.02, 3),
    });
  });

  it("enforces the observed frontend upload boundary", () => {
    expect(() => assertUploadSize(DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES)).toThrow(/size/i);
    expect(assertUploadSize(DEFAULT_FRONTEND_UPLOAD_LIMIT_BYTES - 1)).toMatchObject({
      accepted: true,
    });
  });

  it("accepts a readable native transcript with late lecture coverage", () => {
    const text = [
      "0:09 Welcome to the first mathematics class.",
      "45:12 We now discuss complex numbers and their geometric interpretation.",
      "1:36:19 The class is finished, thank you very much.",
    ].join(" ");

    expect(assessTranscript(text, 5_955)).toMatchObject({
      readable: true,
      accepted: true,
      timestampCount: 3,
      lastTimestampSeconds: 5_779,
    });
  });

  it("does not accept summary-like text without native transcript timestamps", () => {
    expect(assessTranscript("Action Items: review the syllabus and complete the exercises.", 5_955)).toMatchObject({
      readable: false,
      accepted: false,
      timestampCount: 0,
    });
  });

  it("rejects a readable transcript whose last timestamp leaves an unreasonably large tail", () => {
    expect(assessTranscript("0:00 Opening lecture text that is long enough. 1:23:20 The middle of the lecture.", 5_955)).toMatchObject({
      readable: true,
      coverageAccepted: false,
      accepted: false,
      tailGapSeconds: 955,
    });
  });

  it("ignores malformed minute and second fields as transcript timestamps", () => {
    const result = assessTranscript(
      "This is a sufficiently long transcript-like panel with invalid 99:99 markers only.",
      5_955,
    );
    expect(result.timestampCount).toBe(0);
    expect(result.accepted).toBe(false);
  });

  it("does not replace the explicit tail tolerance with a broad percentage fallback", () => {
    expect(assessTranscript(
      "0:00 Opening lecture text that is long enough. 1:30:00 The lecture continues.",
      5_955,
    )).toMatchObject({
      tailGapSeconds: 555,
      coverage: expect.closeTo(0.9068, 3),
      coverageAccepted: false,
      accepted: false,
    });
  });

  it("rejects non-Notion hosts and embedded URL credentials before target policy", () => {
    expect(() => assertSafeTarget({
      pageUrl: "https://example.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676",
      blockId: "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
    })).toThrow(/HTTPS app\.notion\.com/i);
    expect(() => assertSafeTarget({
      pageUrl: "https://user:password@app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676",
      blockId: "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
    })).toThrow(/credentials/i);
  });

  it("fails closed for the known real target and arbitrary pages", () => {
    expect(() => assertSafeTarget({
      pageUrl: "https://app.notion.com/p/3e2f3b2f-e60f-8106-af39-f48327cf2574",
      blockId: "f32103cb-2112-40a2-8ef8-cd7b71030e1b",
    })).toThrow(/real target/i);

    expect(() => assertSafeTarget({
      pageUrl: "https://app.notion.com/p/some-shared-page",
      blockId: "11111111-1111-4111-8111-111111111111",
    })).toThrow(/disposable/i);

    expect(assertSafeTarget({
      pageUrl: "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676",
      blockId: "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
    })).toMatchObject({ disposable: true, realTarget: false });

    expect(assertSafeTarget({
      pageUrl: "https://app.notion.com/p/3e2f3b2f-e60f-8106-af39-f48327cf2574",
      blockId: "f32103cb-2112-40a2-8ef8-cd7b71030e1b",
      allowRealTarget: true,
    })).toMatchObject({ disposable: false, realTarget: true });

    expect(() => assertSafeTarget({
      pageUrl: "https://app.notion.com/p/arbitrary-page",
      blockId: "11111111-1111-4111-8111-111111111111",
      allowRealTarget: true,
    })).toThrow(/disposable/i);

    expect(() => assertSafeTarget({
      pageUrl: "https://app.notion.com/p/3e2f3b2f-e60f-8106-af39-f48327cf2574",
      blockId: "11111111-1111-4111-8111-111111111111",
      allowRealTarget: true,
    })).toThrow(/exact|block/i);
  });

  it("normalizes disposable page query and hash components before authorization", () => {
    expect(assertSafeTarget({
      pageUrl: "https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676?source=operator#notes",
      blockId: "3e3f3b2f-e60f-803e-b05f-de720f6b9527",
    }).pageUrl).toBe("https://app.notion.com/p/Meeting-3e3f3b2fe60f806b8717dcaef7c11676");
  });

  it("derives a stable business identity without credentials or URLs", () => {
    const a = makePipelineJobKey({ courseId: "163730", subId: "6108854", role: "teacher", sourceSha256: "a".repeat(64) });
    const b = makePipelineJobKey({ courseId: "163730", subId: "6108854", role: "teacher", sourceSha256: "a".repeat(64) });
    expect(a).toBe(b);
    expect(a).toBe("zhixue:163730:6108854:teacher:" + "a".repeat(64));
    expect(a).not.toMatch(/https?:|token|secret/i);
  });
});
