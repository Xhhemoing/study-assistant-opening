/**
 * Pure helper & playback state controller for exact `[startMs, endMs]` media
 * citation anchors in `SourceReader`.
 */

export type MediaSourceKind = "audio" | "video";

export interface MediaAnchorRange {
  readonly startMs: number;
  readonly endMs: number;
  readonly bounded: boolean;
  readonly keyframeChunkId?: string;
}

export interface SeekableMediaElement {
  currentTime: number;
  readonly duration?: number;
  readonly readyState: number;
  readonly paused: boolean;
  readonly seeking?: boolean;
  readonly error?: unknown;
  readonly seekable?: { readonly length: number; start(index: number): number; end(index: number): number };
  pause(): void;
  play(): Promise<void> | void;
}

export type MediaAnchorPlaybackPhase =
  | "idle"
  | "pending_metadata"
  | "seeking_segment"
  | "seek_unreached"
  | "media_error"
  | "ready_segment"
  | "paused_at_end"
  | "continued_past_end"
  | "seeked_outside_range";

export interface MediaAnchorPlaybackSnapshot {
  readonly anchor: MediaAnchorRange | null;
  readonly phase: MediaAnchorPlaybackPhase;
  readonly boundActive: boolean;
  readonly autoPausedAtEnd: boolean;
  readonly userReleasedBound: boolean;
  readonly rangeHighlightActive: boolean;
}

export interface MediaAnchorPlaybackController {
  snapshot(): MediaAnchorPlaybackSnapshot;
  activate(media: SeekableMediaElement | null): void;
  handleError(media?: SeekableMediaElement | null): void;
  handleLoadedMetadata(media: SeekableMediaElement): void;
  handleTimeUpdate(media: SeekableMediaElement): void;
  handlePlay(media: SeekableMediaElement): void;
  handlePause(media: SeekableMediaElement): void;
  handleSeeking(media: SeekableMediaElement): void;
  handleSeeked(media: SeekableMediaElement): void;
  seekToStart(media: SeekableMediaElement | null): void;
  replay(media: SeekableMediaElement | null): void;
}

export function mediaKindFromMime(mime?: string | null): MediaSourceKind | null {
  if (!mime) return null;
  const normalized = mime.split(";", 1)[0]!.trim().toLowerCase();
  if (normalized.startsWith("audio/")) return "audio";
  if (normalized.startsWith("video/")) return "video";
  return null;
}

/**
 * Validate a finite integer `0 <= startMs <= endMs` media citation anchor.
 * Returns `null` if missing or invalid so the player never seeks to NaN or
 * inverted bounds.
 */
export function validateMediaAnchorRange(input: {
  readonly startMs?: number | null;
  readonly endMs?: number | null;
  readonly keyframeChunkId?: string | null;
}): MediaAnchorRange | null {
  const { startMs, endMs, keyframeChunkId } = input;
  if (startMs === undefined || startMs === null) return null;
  if (typeof startMs !== "number" || !Number.isSafeInteger(startMs) || startMs < 0) return null;

  const trimmedKeyframe = keyframeChunkId?.trim() || undefined;
  if (endMs === undefined || endMs === null) {
    return {
      startMs,
      endMs: startMs,
      bounded: false,
      ...(trimmedKeyframe ? { keyframeChunkId: trimmedKeyframe } : {}),
    };
  }
  if (typeof endMs !== "number" || !Number.isSafeInteger(endMs) || endMs < startMs) return null;

  return {
    startMs,
    endMs,
    bounded: endMs > startMs,
    ...(trimmedKeyframe ? { keyframeChunkId: trimmedKeyframe } : {}),
  };
}

export function formatMediaTimestampMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0:00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function formatMediaAnchorRange(anchor: MediaAnchorRange): string {
  const start = formatMediaTimestampMs(anchor.startMs);
  if (!anchor.bounded) return start;
  return `${start}–${formatMediaTimestampMs(anchor.endMs)}`;
}

const SEEK_TOLERANCE_MS = 500;

function isValidSeekLanding(anchor: MediaAnchorRange, time: number): boolean {
  return time >= (anchor.startMs - SEEK_TOLERANCE_MS) / 1000 &&
    time <= (anchor.startMs + SEEK_TOLERANCE_MS) / 1000 &&
    (!anchor.bounded || time < anchor.endMs / 1000);
}

function hasSeekableCitation(media: SeekableMediaElement, anchor: MediaAnchorRange): boolean {
  const seekable = media.seekable;
  if (!seekable) return true;
  const start = anchor.startMs / 1000;
  const end = anchor.endMs / 1000;
  for (let index = 0; index < seekable.length; index++) {
    const rangeStart = seekable.start(index);
    const rangeEnd = seekable.end(index);
    if (!Number.isFinite(rangeStart) || !Number.isFinite(rangeEnd)) continue;
    if (anchor.bounded ? Math.min(rangeEnd, end) > Math.max(rangeStart, start)
      : rangeStart <= start && start <= rangeEnd) return true;
  }
  return false;
}

function mediaEndsBeforeAnchor(media: SeekableMediaElement, anchor: MediaAnchorRange): boolean {
  const duration = media.duration;
  return duration !== undefined && Number.isFinite(duration) && duration < anchor.startMs / 1000;
}

function nearestSeekablePosition(
  seekable: NonNullable<SeekableMediaElement["seekable"]>, target: number, positionBeforeSeek: number,
): number | undefined {
  let nearest: number | undefined;
  let distance = Infinity;
  for (let index = 0; index < seekable.length; index++) {
    const start = seekable.start(index);
    const end = seekable.end(index);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;
    if (start <= target && target <= end) return target;
    const boundary = target < start ? start : end;
    const candidateDistance = Math.abs(boundary - target);
    if (candidateDistance < distance ||
      (candidateDistance === distance && nearest !== undefined &&
        Math.abs(boundary - positionBeforeSeek) < Math.abs(nearest - positionBeforeSeek))) {
      distance = candidateDistance;
      nearest = boundary;
    }
  }
  return nearest;
}

/**
 * Stateful playback controller for a validated `[startMs, endMs]` anchor:
 * - Seeks to `startMs / 1000` immediately when `readyState >= 1`, or upon
 *   `loadedmetadata` when metadata is not yet available.
 * - Automatically pauses once `currentTime * 1000 >= endMs` for bounded
 *   segments (`endMs > startMs`).
 * - Releases the stop bound when the learner manually resumes playback at or
 *   after the auto-paused end, allowing uninterrupted continued viewing.
 */
export function createMediaAnchorPlaybackController(
  anchor: MediaAnchorRange | null,
  onChange?: (snapshot: MediaAnchorPlaybackSnapshot) => void,
): MediaAnchorPlaybackController {
  let pendingSeek = anchor !== null;
  let pendingReplayPlay = false;
  let seekOrigin: "programmatic_requested" | "programmatic_started" | "manual" | null = null;
  let requestedPosition = 0;
  let positionBeforeSeek = 0;
  let boundActive = anchor?.bounded ?? false;
  let autoPausedAtEnd = false;
  let userReleasedBound = false;
  let phase: MediaAnchorPlaybackPhase = anchor ? "pending_metadata" : "idle";

  const snapshot = (): MediaAnchorPlaybackSnapshot => ({
    anchor,
    phase,
    boundActive,
    autoPausedAtEnd,
    userReleasedBound,
    rangeHighlightActive: anchor !== null && phase !== "idle" && phase !== "seek_unreached" &&
      phase !== "media_error" && !userReleasedBound,
  });

  const emit = () => {
    onChange?.(snapshot());
  };

  const isProgrammaticSeek = () => seekOrigin === "programmatic_requested" || seekOrigin === "programmatic_started";

  const handleError = () => {
    if (!anchor) return;
    pendingSeek = false;
    pendingReplayPlay = false;
    seekOrigin = null;
    boundActive = false;
    autoPausedAtEnd = false;
    if (phase === "media_error") return;
    phase = "media_error";
    emit();
  };

  const markSeekUnreached = (media: SeekableMediaElement) => {
    pendingReplayPlay = false;
    seekOrigin = null;
    boundActive = false;
    autoPausedAtEnd = false;
    phase = "seek_unreached";
    if (!media.paused) media.pause();
    emit();
  };

  const reachedCitation = (media: SeekableMediaElement, citation: MediaAnchorRange) =>
    !mediaEndsBeforeAnchor(media, citation) && hasSeekableCitation(media, citation) &&
    isValidSeekLanding(citation, media.currentTime);

  const applySeek = (media: SeekableMediaElement | null, rearm: boolean) => {
    if (!anchor) return;
    if (media?.error != null) {
      handleError();
      return;
    }
    if (rearm) {
      userReleasedBound = false;
      autoPausedAtEnd = false;
      boundActive = anchor.bounded;
    }
    if (!media || media.readyState < 1) {
      pendingSeek = true;
      seekOrigin = null;
      phase = "pending_metadata";
      emit();
      return;
    }
    pendingSeek = false;
    if (!hasSeekableCitation(media, anchor)) {
      markSeekUnreached(media);
      return;
    }
    seekOrigin = "programmatic_requested";
    phase = "seeking_segment";
    positionBeforeSeek = media.currentTime;
    requestedPosition = anchor.startMs / 1000;
    media.currentTime = requestedPosition;
    requestedPosition = media.currentTime;
    emit();
  };

  const playPendingReplay = (media: SeekableMediaElement) => {
    if (!anchor || pendingSeek || !pendingReplayPlay || media.seeking) return;
    if (!reachedCitation(media, anchor)) {
      markSeekUnreached(media);
      return;
    }
    pendingReplayPlay = false;
    try {
      void Promise.resolve(media.play()).catch(() => undefined);
    } catch {
      // Browsers may block programmatic playback outside a gesture.
    }
  };

  const pauseAtEnd = (media: SeekableMediaElement) => {
    if (!anchor || !boundActive || pendingSeek || media.paused || seekOrigin !== null || media.seeking) return;
    const time = media.currentTime;
    if (!Number.isFinite(time) || time < anchor.endMs / 1000) return;
    autoPausedAtEnd = true;
    boundActive = false;
    phase = "paused_at_end";
    media.pause();
    emit();
  };

  return {
    snapshot,
    handleError,
    activate(media) {
      pendingReplayPlay = false;
      applySeek(media, true);
    },
    handleLoadedMetadata(media) {
      if (!anchor || !pendingSeek) return;
      applySeek(media, false);
      playPendingReplay(media);
    },
    handleTimeUpdate(media) {
      pauseAtEnd(media);
    },
    handlePlay(media) {
      if (media.paused || seekOrigin === "manual") return;
      if (autoPausedAtEnd) {
        if (isProgrammaticSeek()) {
          media.pause();
          return;
        }
        userReleasedBound = true;
        autoPausedAtEnd = false;
        boundActive = false;
        phase = "continued_past_end";
        emit();
      } else {
        pauseAtEnd(media);
      }
    },
    handlePause(media) {
      if (media.paused) pendingReplayPlay = false;
    },
    handleSeeking(media) {
      if (pendingSeek) pendingReplayPlay = false;
      if (!anchor || pendingSeek || phase === "media_error") return;
      const atRequestedPosition = Math.abs(media.currentTime - requestedPosition) * 1000 <= SEEK_TOLERANCE_MS;
      const clampedToEnd = media.currentTime === media.duration && mediaEndsBeforeAnchor(media, anchor);
      const seekable = media.seekable;
      const target = anchor.startMs / 1000;
      const clampedTarget = seekable && nearestSeekablePosition(seekable, target, positionBeforeSeek);
      const clampedToSeekable = clampedTarget !== undefined && clampedTarget !== target &&
        Math.abs(media.currentTime - clampedTarget) * 1000 <= SEEK_TOLERANCE_MS;
      if (isProgrammaticSeek() && (atRequestedPosition || clampedToEnd || clampedToSeekable)) {
        seekOrigin = "programmatic_started";
      } else {
        pendingReplayPlay = false;
        seekOrigin = "manual";
      }
    },
    handleSeeked(media) {
      if (pendingSeek) pendingReplayPlay = false;
      if (!anchor || pendingSeek || media.seeking || phase === "media_error" ||
        (phase === "seek_unreached" && seekOrigin !== "manual")) return;
      const completedProgrammaticSeek = isProgrammaticSeek();
      seekOrigin = null;
      const time = media.currentTime;
      if (completedProgrammaticSeek) {
        if (!reachedCitation(media, anchor)) {
          markSeekUnreached(media);
        } else {
          phase = "ready_segment";
          emit();
          playPendingReplay(media);
        }
        return;
      }
      if (!Number.isFinite(time)) return;
      const outsideRange = anchor.bounded
        ? time < anchor.startMs / 1000 || time >= anchor.endMs / 1000
        : Math.abs(time * 1000 - anchor.startMs) > SEEK_TOLERANCE_MS;
      if (outsideRange && phase !== "seeked_outside_range") {
        userReleasedBound = true;
        autoPausedAtEnd = false;
        boundActive = false;
        phase = "seeked_outside_range";
        emit();
      } else if (!outsideRange && (autoPausedAtEnd || phase === "seeking_segment")) {
        autoPausedAtEnd = false;
        boundActive = anchor.bounded;
        phase = "ready_segment";
        emit();
      }
    },
    seekToStart(media) {
      pendingReplayPlay = false;
      applySeek(media, true);
    },
    replay(media) {
      pendingReplayPlay = !!anchor && !!media;
      if (!pendingReplayPlay || !media) return;
      applySeek(media, true);
      playPendingReplay(media);
    },
  };
}
