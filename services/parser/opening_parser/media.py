"""FFmpeg/ffprobe helpers for opening media (argv only; no shell interpolation)."""

from __future__ import annotations

import json
import math
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

VIDEO_MAX_BYTES = 512 * 1024 * 1024
VIDEO_MAX_DURATION_MS = 120 * 60 * 1000
MAX_FRAMES_PER_MINUTE = 2
MAX_FRAMES_PER_FILE = 120

_BLOCKED_PREFIXES = (
    "http://",
    "https://",
    "ftp://",
    "rtmp://",
    "rtsp://",
    "mms://",
    "tcp://",
    "udp://",
    "concat:",
    "subfile:",
    "data:",
)


class MediaConfigurationError(RuntimeError):
    code = "CONFIGURATION"


class MediaValidationError(ValueError):
    code = "MEDIA_VALIDATION"


@dataclass(frozen=True)
class MediaProbe:
    duration_ms: int
    size_bytes: int
    format_name: str
    has_audio: bool
    has_video: bool
    width: int | None
    height: int | None


def _reject_network_path(media_path: str | Path) -> Path:
    text = str(media_path).strip()
    lower = text.lower()
    if any(lower.startswith(prefix) for prefix in _BLOCKED_PREFIXES) or lower.startswith("//"):
        raise MediaValidationError("network or remote media protocols are not allowed")
    path = Path(text)
    if not path.is_absolute():
        # Still allow relative local paths inside the worker temp dir; ban URL-looking forms.
        if "://" in text:
            raise MediaValidationError("network or remote media protocols are not allowed")
    return path


def _require_binary(name: str) -> str:
    found = shutil.which(name)
    if not found:
        raise MediaConfigurationError(
            f"{name} is not installed or not on PATH; install FFmpeg to process opening media"
        )
    return found


def build_ffprobe_argv(media_path: str | Path) -> list[str]:
    path = _reject_network_path(media_path)
    return [
        "-v",
        "error",
        "-show_entries",
        "format=duration,size,format_name:stream=codec_type,width,height",
        "-of",
        "json",
        str(path),
    ]


def build_extract_audio_argv(media_path: str | Path, output_wav: str | Path) -> list[str]:
    path = _reject_network_path(media_path)
    out = Path(output_wav)
    return [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        str(path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "wav",
        str(out),
    ]


def max_frames_for_duration(duration_ms: int) -> int:
    # Match TS: ceil((durationMs / 60_000) * 2), capped at 120/file.
    by_rate = max(0, math.ceil((duration_ms / 60_000) * MAX_FRAMES_PER_MINUTE))
    return min(MAX_FRAMES_PER_FILE, by_rate)


def run_ffprobe(media_path: str | Path, *, timeout: float = 60) -> MediaProbe:
    binary = _require_binary("ffprobe")
    argv = build_ffprobe_argv(media_path)
    try:
        completed = subprocess.run(
            [binary, *argv],
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout,
            shell=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise MediaValidationError("ffprobe timed out") from exc
    if completed.returncode != 0:
        detail = (completed.stderr or "")[-200:]
        raise MediaValidationError(f"ffprobe failed: {detail}")
    return parse_ffprobe_output(completed.stdout)


def parse_ffprobe_output(stdout: str) -> MediaProbe:
    try:
        payload = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise MediaValidationError("ffprobe returned invalid JSON") from exc
    fmt = payload.get("format") or {}
    try:
        duration_ms = int(round(float(fmt.get("duration")) * 1000))
        size_bytes = int(fmt.get("size"))
    except (TypeError, ValueError) as exc:
        raise MediaValidationError("media duration or size is missing or invalid") from exc
    if duration_ms < 0 or size_bytes < 0:
        raise MediaValidationError("media duration or size is missing or invalid")
    format_name = fmt.get("format_name")
    if not isinstance(format_name, str) or not format_name:
        raise MediaValidationError("media container format is missing")
    streams = payload.get("streams") or []
    has_audio = any(s.get("codec_type") == "audio" for s in streams if isinstance(s, dict))
    video = next((s for s in streams if isinstance(s, dict) and s.get("codec_type") == "video"), None)
    width = height = None
    if video is not None:
        w, h = video.get("width"), video.get("height")
        width = int(w) if isinstance(w, int) else None
        height = int(h) if isinstance(h, int) else None
    return MediaProbe(
        duration_ms=duration_ms,
        size_bytes=size_bytes,
        format_name=format_name,
        has_audio=has_audio,
        has_video=video is not None,
        width=width,
        height=height,
    )


def assert_within_limits(probe: MediaProbe, *, max_bytes: int, max_duration_ms: int) -> None:
    if probe.size_bytes > max_bytes:
        raise MediaValidationError(
            f"media exceeds size limit: {probe.size_bytes} bytes > {max_bytes} bytes"
        )
    if probe.duration_ms > max_duration_ms:
        raise MediaValidationError(
            f"media exceeds duration limit: {probe.duration_ms} ms > {max_duration_ms} ms"
        )


def validate_local_media(
    media_path: str | Path,
    *,
    mime: str,
    max_bytes: int = VIDEO_MAX_BYTES,
    max_duration_ms: int = VIDEO_MAX_DURATION_MS,
) -> MediaProbe:
    path = _reject_network_path(media_path)
    if not path.is_file():
        raise MediaValidationError("media file is missing or unreadable")
    size_bytes = path.stat().st_size
    if size_bytes > max_bytes:
        raise MediaValidationError(f"media exceeds size limit: {size_bytes} bytes > {max_bytes} bytes")
    probe = run_ffprobe(path)
    merged = MediaProbe(
        duration_ms=probe.duration_ms,
        size_bytes=max(probe.size_bytes, size_bytes),
        format_name=probe.format_name,
        has_audio=probe.has_audio,
        has_video=probe.has_video,
        width=probe.width,
        height=probe.height,
    )
    joined = merged.format_name.lower()
    if mime == "video/mp4":
        if "mp4" not in joined:
            raise MediaValidationError(f"container {merged.format_name} does not match video/mp4")
        if not merged.has_video:
            raise MediaValidationError("video/mp4 requires a video track")
    elif mime == "video/webm":
        if "webm" not in joined and "matroska" not in joined:
            raise MediaValidationError(f"container {merged.format_name} does not match video/webm")
        if not merged.has_video:
            raise MediaValidationError("video/webm requires a video track")
    elif mime.startswith("audio/"):
        if not merged.has_audio:
            raise MediaValidationError("audio source requires an audio track")
    else:
        raise MediaValidationError(f"unsupported media MIME: {mime}")
    assert_within_limits(merged, max_bytes=max_bytes, max_duration_ms=max_duration_ms)
    return merged


def extract_audio_wav(media_path: str | Path, output_wav: str | Path, *, timeout: float = 300) -> Path:
    """Extract mono 16 kHz wav via ffmpeg argv. Does not load the whole media into memory."""
    binary = _require_binary("ffmpeg")
    out = Path(output_wav)
    out.parent.mkdir(parents=True, exist_ok=True)
    argv = build_extract_audio_argv(media_path, out)
    completed = subprocess.run([binary, *argv], check=False, capture_output=True, text=True, timeout=timeout, shell=False)
    if completed.returncode != 0:
        raise MediaValidationError(f"ffmpeg audio extract failed: {(completed.stderr or '')[-200:]}")
    return out


def extract_scene_keyframes(
    media_path: str | Path,
    output_dir: str | Path,
    *,
    duration_ms: int,
    scene_threshold: float = 0.4,
    timeout: float = 300,
) -> list[dict]:
    """
    Extract scene-change keyframes capped at 2/min and 120/file.
    Returns [{path, timestamp_ms}] with original media timestamps when showinfo is available.
    Visual coverage is limited when the cap truncates further scenes.
    """
    binary = _require_binary("ffmpeg")
    path = _reject_network_path(media_path)
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    cap = max_frames_for_duration(duration_ms)
    if cap < 1:
        return []
    pattern = str(out_dir / "frame-%04d.png")
    # Filtergraph commas must be escaped for ffmpeg's filter parser (argv, not shell).
    vf = f"select='gt(scene\\,{scene_threshold})',showinfo"
    argv = [
        "-hide_banner",
        "-nostdin",
        "-y",
        "-i",
        str(path),
        "-vf",
        vf,
        "-vsync",
        "vfr",
        "-frames:v",
        str(cap),
        pattern,
    ]
    completed = subprocess.run([binary, *argv], check=False, capture_output=True, text=True, timeout=timeout, shell=False)
    if completed.returncode != 0:
        raise MediaValidationError(f"ffmpeg keyframe extract failed: {(completed.stderr or '')[-200:]}")
    frames = sorted(out_dir.glob("frame-*.png"))
    # Timestamps: prefer showinfo pts_time from stderr; fall back to even spacing.
    times: list[float] = []
    for line in (completed.stderr or "").splitlines():
        if "pts_time:" in line:
            try:
                part = line.split("pts_time:")[1].split(" ")[0]
                times.append(float(part))
            except (IndexError, ValueError):
                continue
    results: list[dict] = []
    for index, frame in enumerate(frames):
        if index < len(times):
            ts_ms = int(round(times[index] * 1000))
        else:
            ts_ms = int(round((index / max(len(frames), 1)) * duration_ms))
        results.append({"path": str(frame), "timestamp_ms": ts_ms})
    return results
