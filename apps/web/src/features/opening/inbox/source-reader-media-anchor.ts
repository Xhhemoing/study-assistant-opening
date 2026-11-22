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
  readonly readyState: number;
  readonly paused: boolean;
  readonly seeking?: boolean;
  pause(): void;
  play(): Promise<void> | void;
}

export type MediaAnchorPlaybackPhase =
  | "idle"
  | "pending_metadata"
  | "seeking_segment"
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
  handleLoadedMetadata(media: SeekableMediaElement): void;
  handleTimeUpdate(media: SeekableMediaElement): void;
  handlePlay(media: SeekableMediaElement): void;
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

/**
 * Stateful playback controller for a validated `[startMs, endMs]` anchor:
 * - Seeks to `startMs / 1000` immediately when `readyState >= 1`, or upon
 *   `loadedmetadata` when metadata is not yet available.
 * - Automatically pauses once `currentTime * 1000 >= endMs` for bounded
 *   segments (`endMs > startMs`).
 * - Releases the stop bound when the learner manually resumes playback at or
 *   after the auto-paused end, allowing uninterrupted continued viewing.
 */
const POINT_SEEK_TOLERANCE_MS = 500;

export function createMediaAnchorPlaybackController(
  anchor: MediaAnchorRange | null,
  onChange?: (snapshot: MediaAnchorPlaybackSnapshot) => void,
): MediaAnchorPlaybackController {
  let pendingSeek = anchor !== null;
  let seekOrigin: "programmatic_requested" | "programmatic_started" | "manual" | null = null;
  let requestedPosition = 0;
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
    rangeHighlightActive: anchor !== null && phase !== "idle" && !userReleasedBound,
  });

  const emit = () => {
    onChange?.(snapshot());
  };

  const isProgrammaticSeek = () => seekOrigin === "programmatic_requested" || seekOrigin === "programmatic_started";

  const applySeek = (media: SeekableMediaElement | null, rearm: boolean) => {
    if (!anchor) return;
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
    seekOrigin = "programmatic_requested";
    phase = "seeking_segment";
    requestedPosition = anchor.startMs / 1000;
    media.currentTime = requestedPosition;
    requestedPosition = media.currentTime;
    emit();
  };

  const pauseAtEnd = (media: SeekableMediaElement) => {
    if (!anchor || !boundActive || pendingSeek || media.paused || seekOrigin === "manual" ||
      (media.seeking && !isProgrammaticSeek())) return;
    if (!Number.isFinite(media.currentTime) || media.currentTime < anchor.endMs / 1000) return;
    autoPausedAtEnd = true;
    boundActive = false;
    phase = "paused_at_end";
    media.pause();
    emit();
  };

  return {
    snapshot,
    activate(media) {
      applySeek(media, true);
    },
    handleLoadedMetadata(media) {
      if (!anchor || !pendingSeek) return;
      applySeek(media, false);
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
    handleSeeking(media) {
      if (!anchor || pendingSeek) return;
      // A late seeking event may arrive after the programmatic seek has already rounded.
      const atRequestedPosition = Math.abs(media.currentTime - requestedPosition) * 1000 <= POINT_SEEK_TOLERANCE_MS;
      if (isProgrammaticSeek() && (atRequestedPosition ||
        (seekOrigin === "programmatic_requested" && media.seeking === false))) {
        seekOrigin = "programmatic_started";
      } else {
        seekOrigin = "manual";
      }
    },
    handleSeeked(media) {
      if (!anchor || pendingSeek || media.seeking) return;
      const completedProgrammaticSeek = isProgrammaticSeek();
      seekOrigin = null;
      if (completedProgrammaticSeek) {
        // A timeupdate can already have paused playback at the end of a short segment.
        if (phase === "seeking_segment") {
          phase = "ready_segment";
          emit();
        }
        return;
      }
      const time = media.currentTime;
      if (!Number.isFinite(time)) return;
      const outsideRange = anchor.bounded
        ? time < anchor.startMs / 1000 || time >= anchor.endMs / 1000
        : Math.abs(time * 1000 - anchor.startMs) > POINT_SEEK_TOLERANCE_MS;
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
      applySeek(media, true);
    },
    replay(media) {
      if (!anchor || !media) return;
      applySeek(media, true);
      try {
        void Promise.resolve(media.play()).catch(() => undefined);
      } catch {
        // Browsers may block programmatic playback outside a gesture.
      }
    },
  };
}
