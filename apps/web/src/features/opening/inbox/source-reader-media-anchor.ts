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
  pause(): void;
  play(): Promise<void> | void;
}

export type MediaAnchorPlaybackPhase =
  | "idle"
  | "pending_metadata"
  | "seeking_segment"
  | "paused_at_end"
  | "continued_past_end";

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
const SEEK_RANGE_TOLERANCE_MS = 250;
const PROGRAMMATIC_SEEK_TOLERANCE_MS = 500;

export function createMediaAnchorPlaybackController(
  anchor: MediaAnchorRange | null,
  onChange?: (snapshot: MediaAnchorPlaybackSnapshot) => void,
): MediaAnchorPlaybackController {
  let pendingSeek = anchor !== null;
  let awaitingProgrammaticSeeked = false;
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
    rangeHighlightActive: anchor !== null && phase !== "idle" && phase !== "continued_past_end",
  });

  const emit = () => {
    onChange?.(snapshot());
  };

  const applySeek = (media: SeekableMediaElement | null, rearm: boolean) => {
    if (!anchor) return;
    if (rearm) {
      userReleasedBound = false;
      autoPausedAtEnd = false;
      boundActive = anchor.bounded;
    }
    if (!media || media.readyState < 1) {
      pendingSeek = true;
      awaitingProgrammaticSeeked = false;
      phase = "pending_metadata";
      emit();
      return;
    }
    media.currentTime = anchor.startMs / 1000;
    pendingSeek = false;
    awaitingProgrammaticSeeked = true;
    phase = "seeking_segment";
    emit();
  };

  return {
    snapshot,
    activate(media) {
      applySeek(media, true);
    },
    handleLoadedMetadata(media) {
      if (!anchor || !pendingSeek) return;
      media.currentTime = anchor.startMs / 1000;
      pendingSeek = false;
      awaitingProgrammaticSeeked = true;
      phase = "seeking_segment";
      emit();
    },
    handleTimeUpdate(media) {
      if (!anchor || !anchor.bounded || pendingSeek || userReleasedBound || autoPausedAtEnd) return;
      const currentMs = media.currentTime * 1000;
      if (
        awaitingProgrammaticSeeked &&
        Number.isFinite(currentMs) &&
        Math.abs(currentMs - anchor.startMs) > PROGRAMMATIC_SEEK_TOLERANCE_MS
      ) {
        awaitingProgrammaticSeeked = false;
      }
      if (Number.isFinite(currentMs) && currentMs >= anchor.endMs) {
        awaitingProgrammaticSeeked = false;
        autoPausedAtEnd = true;
        boundActive = false;
        phase = "paused_at_end";
        media.pause();
        emit();
      }
    },
    handlePlay(media) {
      if (!anchor || !anchor.bounded) return;
      const currentMs = media.currentTime * 1000;
      if (autoPausedAtEnd || (!pendingSeek && Number.isFinite(currentMs) && currentMs >= anchor.endMs)) {
        awaitingProgrammaticSeeked = false;
        userReleasedBound = true;
        autoPausedAtEnd = false;
        boundActive = false;
        phase = "continued_past_end";
        emit();
      }
    },
    handleSeeked(media) {
      if (!anchor || pendingSeek) return;
      const wasProgrammatic = awaitingProgrammaticSeeked;
      awaitingProgrammaticSeeked = false;
      const currentMs = media.currentTime * 1000;
      if (!Number.isFinite(currentMs)) return;
      if (anchor.bounded) {
        const startTolerance = wasProgrammatic ? PROGRAMMATIC_SEEK_TOLERANCE_MS : SEEK_RANGE_TOLERANCE_MS;
        if (currentMs < anchor.startMs - startTolerance || currentMs > anchor.endMs + SEEK_RANGE_TOLERANCE_MS) {
          if (phase !== "continued_past_end") {
            userReleasedBound = true;
            autoPausedAtEnd = false;
            boundActive = false;
            phase = "continued_past_end";
            emit();
          }
        } else if (autoPausedAtEnd && currentMs < anchor.endMs) {
          autoPausedAtEnd = false;
          boundActive = true;
          phase = "seeking_segment";
          emit();
        }
      } else if (Math.abs(currentMs - anchor.startMs) > PROGRAMMATIC_SEEK_TOLERANCE_MS && phase !== "continued_past_end") {
        userReleasedBound = true;
        autoPausedAtEnd = false;
        boundActive = false;
        phase = "continued_past_end";
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
