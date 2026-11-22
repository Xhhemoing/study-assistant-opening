import { describe, expect, it, vi } from "vitest";
import {
  createMediaAnchorPlaybackController,
  formatMediaAnchorRange,
  formatMediaTimestampMs,
  mediaKindFromMime,
  validateMediaAnchorRange,
  type SeekableMediaElement,
} from "./source-reader-media-anchor";

function createFakeMedia(readyState = 1): SeekableMediaElement & {
  readyState: number;
  paused: boolean;
  pauseMock: ReturnType<typeof vi.fn>;
  playMock: ReturnType<typeof vi.fn>;
} {
  const pauseMock = vi.fn();
  const playMock = vi.fn(() => Promise.resolve());
  const media = {
    currentTime: 0,
    readyState,
    paused: true,
    pauseMock,
    playMock,
    pause() {
      this.paused = true;
      pauseMock();
    },
    play() {
      this.paused = false;
      return playMock();
    },
  };
  return media;
}

describe("source-reader media anchor validation and formatting", () => {
  it("classifies audio and video MIME types with optional parameters", () => {
    expect(mediaKindFromMime("audio/mpeg")).toBe("audio");
    expect(mediaKindFromMime("audio/mp4; codecs=mp4a.40.2")).toBe("audio");
    expect(mediaKindFromMime("video/mp4")).toBe("video");
    expect(mediaKindFromMime("video/webm; codecs=vp9")).toBe("video");
    expect(mediaKindFromMime("application/pdf")).toBeNull();
    expect(mediaKindFromMime(null)).toBeNull();
  });

  it("validates finite integer 0 <= startMs <= endMs ranges and rejects malformed inputs", () => {
    expect(validateMediaAnchorRange({ startMs: 0, endMs: 12_500, keyframeChunkId: "kf-1" })).toEqual({
      startMs: 0,
      endMs: 12_500,
      bounded: true,
      keyframeChunkId: "kf-1",
    });
    expect(validateMediaAnchorRange({ startMs: 65_000 })).toEqual({
      startMs: 65_000,
      endMs: 65_000,
      bounded: false,
    });
    expect(validateMediaAnchorRange({ startMs: 65_000, endMs: 65_000 })).toEqual({
      startMs: 65_000,
      endMs: 65_000,
      bounded: false,
    });

    // Reject negative, NaN, Infinity, non-integer, inverted range, or endMs without startMs.
    expect(validateMediaAnchorRange({ startMs: -1, endMs: 5000 })).toBeNull();
    expect(validateMediaAnchorRange({ startMs: Number.NaN, endMs: 5000 })).toBeNull();
    expect(validateMediaAnchorRange({ startMs: Number.POSITIVE_INFINITY })).toBeNull();
    expect(validateMediaAnchorRange({ startMs: 10.5, endMs: 20_000 })).toBeNull();
    expect(validateMediaAnchorRange({ startMs: 20_000, endMs: 19_999 })).toBeNull();
    expect(validateMediaAnchorRange({ startMs: 1000, endMs: 2000.5 })).toBeNull();
    expect(validateMediaAnchorRange({ endMs: 5000 })).toBeNull();
    expect(validateMediaAnchorRange({})).toBeNull();
  });

  it("formats sub-hour and multi-hour timestamps and ranges cleanly", () => {
    expect(formatMediaTimestampMs(0)).toBe("0:00");
    expect(formatMediaTimestampMs(65_000)).toBe("1:05");
    expect(formatMediaTimestampMs(3_665_000)).toBe("1:01:05");
    expect(formatMediaAnchorRange({ startMs: 65_000, endMs: 90_000, bounded: true })).toBe("1:05–1:30");
    expect(formatMediaAnchorRange({ startMs: 65_000, endMs: 65_000, bounded: false })).toBe("1:05");
  });
});

describe("media anchor bounded playback controller", () => {
  it("reports a native scrub that supersedes an in-flight citation seek", () => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 25_000 })!;
    const media = createFakeMedia();
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    controller.handleSeeking(media);
    media.currentTime = 5;
    controller.handleSeeking(media);
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({ phase: "seeked_outside_range", boundActive: false });
  });

  it("treats an unexpected first seeking event as completion of the programmatic request", () => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 25_000 })!;
    const media = createFakeMedia();
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    media.currentTime = 5;
    controller.handleSeeking(media);
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "seek_unreached", userReleasedBound: false, rangeHighlightActive: false,
    });
  });

  it("becomes ready if a scrub supersedes the initial seek and stays within the citation", () => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 25_000 })!;
    const media = createFakeMedia();
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    controller.handleSeeking(media);
    media.currentTime = 18;
    controller.handleSeeking(media);
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({ phase: "ready_segment", boundActive: true });
  });

  it("does not auto-pause when a playing user scrubs past the citation", () => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 25_000 })!;
    const media = createFakeMedia();
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    controller.handleSeeked(media);
    media.paused = false;
    media.currentTime = 30;
    controller.handleSeeking(media);
    controller.handleTimeUpdate(media);
    controller.handleSeeked(media);
    expect(media.paused).toBe(false);
    expect(media.pauseMock).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ phase: "seeked_outside_range", boundActive: false });
  });

  it("seeks once metadata is loaded and emits readiness only after seeked", () => {
    const anchor = validateMediaAnchorRange({ startMs: 12_500, endMs: 25_000 })!;

    const readyMedia = createFakeMedia(2);
    const c1 = createMediaAnchorPlaybackController(anchor);
    c1.activate(readyMedia);
    expect(readyMedia.currentTime).toBe(12.5);
    expect(c1.snapshot().phase).toBe("seeking_segment");
    c1.handleSeeked(readyMedia);
    expect(c1.snapshot().phase).toBe("ready_segment");

    const loadingMedia = createFakeMedia(0);
    const onChange = vi.fn();
    const c2 = createMediaAnchorPlaybackController(anchor, onChange);
    c2.activate(loadingMedia);
    expect(loadingMedia.currentTime).toBe(0);
    expect(c2.snapshot().phase).toBe("pending_metadata");

    // Timeupdate before metadata finishes must not prematurely auto-pause.
    loadingMedia.currentTime = 30;
    c2.handleTimeUpdate(loadingMedia);
    expect(loadingMedia.pauseMock).not.toHaveBeenCalled();

    loadingMedia.readyState = 1;
    c2.handleLoadedMetadata(loadingMedia);
    expect(loadingMedia.currentTime).toBe(12.5);
    expect(c2.snapshot().phase).toBe("seeking_segment");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "seeking_segment" }));
    c2.handleTimeUpdate(loadingMedia);
    expect(c2.snapshot().phase).toBe("seeking_segment");

    c2.handleSeeked(loadingMedia);
    expect(c2.snapshot().phase).toBe("ready_segment");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "ready_segment" }));
  });

  it.each([
    { endMs: 70_000, kind: "bounded citation" },
    { endMs: undefined, kind: "point citation" },
  ])("reports a $kind seek clamped to the media duration", ({ endMs }) => {
    const anchor = validateMediaAnchorRange({ startMs: 65_000, endMs })!;
    const media = createFakeMedia();
    let duration = 30;
    let currentTime = 0;
    Object.defineProperty(media, "currentTime", {
      get: () => currentTime,
      set: (time: number) => { currentTime = Math.min(time, duration); },
    });
    const onChange = vi.fn();
    const controller = createMediaAnchorPlaybackController(anchor, onChange);
    controller.activate(media);
    controller.handleSeeking(media);
    controller.handleSeeked(media);

    expect(media.currentTime).toBe(30);
    expect(controller.snapshot()).toMatchObject({
      phase: "seek_unreached",
      boundActive: false,
      autoPausedAtEnd: false,
      userReleasedBound: false,
      rangeHighlightActive: false,
    });
    expect(onChange.mock.calls.map(([snapshot]) => snapshot.phase)).toEqual([
      "seeking_segment", "seek_unreached",
    ]);

    duration = 90;
    controller.seekToStart(media);
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "ready_segment",
      boundActive: anchor.bounded,
      rangeHighlightActive: true,
    });
  });

  it.each([
    { endMs: 70_000, landing: 68, phase: "ready_segment" },
    { endMs: 70_000, landing: 70.501, phase: "seek_unreached" },
    { endMs: undefined, landing: 64.5, phase: "ready_segment" },
    { endMs: undefined, landing: 64.499, phase: "seek_unreached" },
  ])("checks the completed seek at $landing s against the citation tolerance", ({ endMs, landing, phase }) => {
    const anchor = validateMediaAnchorRange({ startMs: 65_000, endMs })!;
    const media = createFakeMedia();
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    controller.handleSeeking(media);
    void media.play();
    media.currentTime = landing;
    controller.handleTimeUpdate(media);
    controller.handleSeeked(media);

    expect(media.pauseMock).not.toHaveBeenCalled();
    expect(controller.snapshot().phase).toBe(phase);
  });

  it("recognizes the first seeking event clamped to the start of a seekable range", () => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 20_000 })!;
    const media = Object.assign(createFakeMedia(), {
      duration: 90,
      seeking: false,
      seekable: { length: 1, start: () => 30, end: () => 90 },
    });
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    expect(media.currentTime).toBe(10);

    media.currentTime = media.seekable.start();
    media.seeking = true;
    controller.handleSeeking(media);
    media.seeking = false;
    controller.handleSeeked(media);

    expect(controller.snapshot()).toMatchObject({
      phase: "seek_unreached", boundActive: false, userReleasedBound: false,
    });
  });

  it.each([30, 64.7])("recognizes a deferred clamp at the known duration %ss", duration => {
    const anchor = validateMediaAnchorRange({ startMs: 65_000, endMs: 70_000 })!;
    const media = Object.assign(createFakeMedia(), { duration, seeking: true });
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    media.currentTime = duration;
    controller.handleSeeking(media);
    media.seeking = false;
    controller.handleSeeked(media);

    expect(controller.snapshot()).toMatchObject({
      phase: "seek_unreached", boundActive: false, userReleasedBound: false,
    });
  });

  it("auto-pauses at currentTime * 1000 >= endMs and allows uninterrupted playback once user manually resumes", () => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 25_000 })!;
    const media = createFakeMedia(2);
    const phases: string[] = [];
    const controller = createMediaAnchorPlaybackController(anchor, snap => phases.push(snap.phase));

    controller.activate(media);
    expect(media.currentTime).toBe(10);
    controller.handleSeeked(media);

    // Mid-segment manual pause & resume must keep the endMs stop boundary active.
    media.currentTime = 16;
    controller.handleTimeUpdate(media);
    expect(media.pauseMock).not.toHaveBeenCalled();
    media.pause();
    media.play();
    controller.handlePlay(media);
    expect(controller.snapshot().boundActive).toBe(true);

    // Reaching endMs triggers automatic pause exactly once.
    media.pauseMock.mockClear();
    media.currentTime = 25;
    controller.handleTimeUpdate(media);
    expect(media.pauseMock).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({
      phase: "paused_at_end",
      autoPausedAtEnd: true,
      userReleasedBound: false,
      boundActive: false,
    });

    // Repeated timeupdate while paused at end does not re-trigger pause.
    controller.handleTimeUpdate(media);
    expect(media.pauseMock).toHaveBeenCalledOnce();

    // User manually resumes playback -> bound is released and playback continues past endMs!
    media.play();
    controller.handlePlay(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "continued_past_end",
      autoPausedAtEnd: false,
      userReleasedBound: true,
      boundActive: false,
    });
    media.currentTime = 40;
    controller.handleTimeUpdate(media);
    expect(media.pauseMock).toHaveBeenCalledOnce();

    // A manual seek while already playing after the citation updates the status.
    media.currentTime = 5;
    controller.handleSeeked(media);
    expect(controller.snapshot().phase).toBe("seeked_outside_range");

    // Clicking Replay re-arms the bounded segment and seeks back to startMs / 1000.
    controller.replay(media);
    expect(media.currentTime).toBe(10);
    expect(controller.snapshot()).toMatchObject({
      phase: "seeking_segment",
      boundActive: true,
      userReleasedBound: false,
      autoPausedAtEnd: false,
    });
    // Subsequent play event fired inside segment does NOT release the bound.
    controller.handlePlay(media);
    expect(controller.snapshot().boundActive).toBe(true);
    media.currentTime = 25.05;
    controller.handleTimeUpdate(media);
    expect(media.pauseMock).toHaveBeenCalledTimes(2);
    expect(phases).toContain("paused_at_end");
    expect(phases).toContain("continued_past_end");
  });

  it.each([5, 45])("releases the citation bound when manually scrubbing while paused to %ss", destination => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 25_000 })!;
    const media = createFakeMedia(2);
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    controller.handleSeeked(media);

    media.currentTime = destination;
    controller.handleTimeUpdate(media);
    controller.handleSeeked(media);
    expect(media.paused).toBe(true);
    expect(media.pauseMock).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({
      phase: "seeked_outside_range",
      boundActive: false,
      autoPausedAtEnd: false,
      userReleasedBound: true,
      rangeHighlightActive: false,
    });
  });

  it("does not auto-pause on unbounded point anchors (endMs === startMs or omitted)", () => {
    const point = validateMediaAnchorRange({ startMs: 15_000, endMs: 15_000 })!;
    const media = createFakeMedia(2);
    const controller = createMediaAnchorPlaybackController(point);
    controller.activate(media);
    expect(media.currentTime).toBe(15);

    media.currentTime = 90;
    controller.handleTimeUpdate(media);
    expect(media.pauseMock).not.toHaveBeenCalled();
  });

  it.each([10.05, 10.35])("keeps the first play bounded after an initial seek rounds to %ss", roundedTime => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 10_050 })!;
    const media = createFakeMedia(2);
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    media.currentTime = roundedTime;
    controller.handleTimeUpdate(media);
    controller.handleSeeked(media);
    expect(media.pauseMock).not.toHaveBeenCalled();
    expect(controller.snapshot()).toMatchObject({ boundActive: true, autoPausedAtEnd: false });

    void media.play();
    controller.handlePlay(media);
    expect(media.pauseMock).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({ phase: "paused_at_end", autoPausedAtEnd: true });

    void media.play();
    controller.handlePlay(media);
    expect(media.pauseMock).toHaveBeenCalledOnce();
    expect(controller.snapshot()).toMatchObject({ phase: "continued_past_end", userReleasedBound: true });
  });

  it.each(["play", "timeupdate"] as const)("keeps a 510ms overshoot bounded on the first %s, including replay", firstEvent => {
    const anchor = validateMediaAnchorRange({ startMs: 1_000, endMs: 1_010 })!;
    const media = createFakeMedia(2);
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    for (const expectedPauses of [1, 2]) {
      media.currentTime = 1.51;
      controller.handleTimeUpdate(media);
      controller.handleSeeked(media);
      expect(controller.snapshot()).toMatchObject({ boundActive: true, userReleasedBound: false });
      if (media.paused) void media.play();
      if (firstEvent === "play") controller.handlePlay(media);
      else controller.handleTimeUpdate(media);
      expect(media.pauseMock).toHaveBeenCalledTimes(expectedPauses);
      expect(controller.snapshot().autoPausedAtEnd).toBe(true);
      void media.play();
      controller.handlePlay(media);
      expect(media.pauseMock).toHaveBeenCalledTimes(expectedPauses);
      expect(controller.snapshot().userReleasedBound).toBe(true);
      if (expectedPauses === 1) {
        media.paused = true;
        controller.seekToStart(media);
      }
    }
  });

  it("keeps the auto-pause state when the programmatic seeked event arrives after timeupdate", () => {
    const anchor = validateMediaAnchorRange({ startMs: 1_000, endMs: 1_010 })!;
    const media = createFakeMedia(2);
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.activate(media);
    void media.play();
    media.currentTime = 1.51;
    controller.handleTimeUpdate(media);
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "paused_at_end", autoPausedAtEnd: true, userReleasedBound: false,
    });
    void media.play();
    controller.handlePlay(media);
    expect(controller.snapshot()).toMatchObject({ phase: "continued_past_end", userReleasedBound: true });
    expect(media.pauseMock).toHaveBeenCalledOnce();
  });

  it("ignores a queued play delivered while paused before replay seeked", () => {
    const anchor = validateMediaAnchorRange({ startMs: 1_000, endMs: 1_010 })!;
    const media = createFakeMedia(2);
    const controller = createMediaAnchorPlaybackController(anchor);
    controller.replay(media);
    media.currentTime = 1.015;
    controller.handleTimeUpdate(media);
    expect(media.paused).toBe(true);
    controller.handlePlay(media);
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "paused_at_end", autoPausedAtEnd: true, userReleasedBound: false,
    });
    expect(media.pauseMock).toHaveBeenCalledOnce();
    void media.play();
    controller.handlePlay(media);
    expect(controller.snapshot()).toMatchObject({ phase: "continued_past_end", userReleasedBound: true });
  });

  it("keeps rangeHighlightActive true while paused on jumped range and after auto-pause at endMs until manual play or seek elsewhere", () => {
    const anchor = validateMediaAnchorRange({ startMs: 10_000, endMs: 25_000, keyframeChunkId: "kf-10" })!;
    const media = createFakeMedia(2);
    const controller = createMediaAnchorPlaybackController(anchor);

    // Starts paused on jumped range -> highlight is active.
    controller.activate(media);
    expect(media.paused).toBe(true);
    expect(controller.snapshot().rangeHighlightActive).toBe(true);

    // Programmatic seeked event at startMs keeps highlight active.
    controller.handleSeeked(media);
    expect(controller.snapshot().rangeHighlightActive).toBe(true);

    // Auto-pausing at endMs keeps rangeHighlightActive true!
    void media.play();
    controller.handlePlay(media);
    media.currentTime = 25;
    controller.handleTimeUpdate(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "paused_at_end",
      autoPausedAtEnd: true,
      rangeHighlightActive: true,
    });

    // Seeking back inside [startMs, endMs] re-arms the bound and keeps highlight active.
    media.currentTime = 18;
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "ready_segment",
      boundActive: true,
      rangeHighlightActive: true,
    });

    // Auto-pause again at endMs, then seek outside the range -> clears highlight.
    void media.play();
    controller.handlePlay(media);
    media.currentTime = 25;
    controller.handleTimeUpdate(media);
    expect(controller.snapshot().rangeHighlightActive).toBe(true);
    media.currentTime = 45;
    controller.handleSeeked(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "seeked_outside_range",
      userReleasedBound: true,
      rangeHighlightActive: false,
    });

    // Replay re-activates highlight.
    controller.replay(media);
    expect(controller.snapshot()).toMatchObject({
      phase: "seeking_segment",
      rangeHighlightActive: true,
    });
  });

  it("tolerates IEEE-754 float64 rounding and browser keyframe snapping on initial programmatic seek without dropping boundActive or rangeHighlightActive", () => {
    // (290 / 1000) * 1000 === 289.99999999999994 < 290 in IEEE-754 float64!
    const floatAnchor = validateMediaAnchorRange({ startMs: 290, endMs: 5_000 })!;
    const m1 = createFakeMedia(2);
    const c1 = createMediaAnchorPlaybackController(floatAnchor);
    c1.activate(m1);
    c1.handleSeeked(m1);
    expect(c1.snapshot()).toMatchObject({
      phase: "ready_segment",
      boundActive: true,
      rangeHighlightActive: true,
      userReleasedBound: false,
    });

    // Browser keyframe snapping slightly below startMs (e.g. 64.7s for 65_000ms) keeps bound and highlight active.
    const snapAnchor = validateMediaAnchorRange({ startMs: 65_000, endMs: 90_000 })!;
    const m2 = createFakeMedia(0);
    const c2 = createMediaAnchorPlaybackController(snapAnchor);
    c2.activate(m2);
    m2.readyState = 1;
    c2.handleLoadedMetadata(m2);
    m2.currentTime = 64.7;
    c2.handleSeeked(m2);
    expect(c2.snapshot()).toMatchObject({
      phase: "ready_segment",
      boundActive: true,
      rangeHighlightActive: true,
      userReleasedBound: false,
    });

    // End bound still auto-pauses cleanly at 90s!
    void m2.play();
    c2.handlePlay(m2);
    m2.currentTime = 90;
    c2.handleTimeUpdate(m2);
    expect(m2.pauseMock).toHaveBeenCalledOnce();
    expect(c2.snapshot()).toMatchObject({
      phase: "paused_at_end",
      autoPausedAtEnd: true,
      rangeHighlightActive: true,
    });

    // Genuine manual seek well outside [startMs, endMs] still releases bound and clears highlight.
    m2.currentTime = 15;
    c2.handleSeeked(m2);
    expect(c2.snapshot()).toMatchObject({
      phase: "seeked_outside_range",
      userReleasedBound: true,
      rangeHighlightActive: false,
    });
  });
});
