"""CLI: probe + optional faster-whisper transcription + keyframe extract (JSON stdout)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from opening_parser import media as media_mod
from opening_parser import transcribe as transcribe_mod


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Opening media process (argv FFmpeg + optional faster-whisper)"
    )
    parser.add_argument("--input", required=True)
    parser.add_argument("--mime", required=True)
    parser.add_argument("--output-dir", required=True, help="Directory for wav / keyframe PNGs")
    parser.add_argument("--model-size", default="base")
    parser.add_argument("--model-path", default=None)
    parser.add_argument("--language", default=None)
    parser.add_argument("--skip-frames", action="store_true")
    parser.add_argument("--skip-transcribe", action="store_true")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    media_path = Path(args.input)
    out_dir = Path(args.output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    try:
        probe = media_mod.validate_local_media(media_path, mime=args.mime)
    except media_mod.MediaConfigurationError as exc:
        print(json.dumps({"ok": False, "code": "CONFIGURATION", "error": str(exc)}), flush=True)
        return 2
    except media_mod.MediaValidationError as exc:
        print(json.dumps({"ok": False, "code": "MEDIA_VALIDATION", "error": str(exc)}), flush=True)
        return 3

    transcription = "blocked_not_configured"
    segments: list[dict] = []
    transcription_error: str | None = None

    if not probe.has_audio:
        transcription = "skipped_no_audio"
    elif not args.skip_transcribe:
        wav = out_dir / "audio.wav"
        try:
            media_mod.extract_audio_wav(media_path, wav)
            results = transcribe_mod.transcribe_wav(
                wav,
                model_size=args.model_size,
                language=args.language,
                model_path=args.model_path,
            )
            segments = [
                {
                    "startMs": s.start_ms,
                    "endMs": s.end_ms,
                    "text": s.text,
                    "language": s.language,
                }
                for s in results
            ]
            transcription = "completed"
        except transcribe_mod.TranscriptionConfigurationError as exc:
            transcription = "blocked_not_configured"
            segments = []
            transcription_error = str(exc)
        except media_mod.MediaConfigurationError as exc:
            print(json.dumps({"ok": False, "code": "CONFIGURATION", "error": str(exc)}), flush=True)
            return 2
        except media_mod.MediaValidationError as exc:
            print(json.dumps({"ok": False, "code": "MEDIA_VALIDATION", "error": str(exc)}), flush=True)
            return 3

    frames: list[dict] = []
    visual_coverage_limited = False
    if probe.has_video and not args.skip_frames:
        frame_dir = out_dir / "frames"
        try:
            extracted = media_mod.extract_scene_keyframes(
                media_path,
                frame_dir,
                duration_ms=probe.duration_ms,
            )
            cap = media_mod.max_frames_for_duration(probe.duration_ms)
            visual_coverage_limited = len(extracted) >= cap > 0
            frames = [
                {"path": item["path"], "timestampMs": int(item["timestamp_ms"])}
                for item in extracted
            ]
        except media_mod.MediaConfigurationError as exc:
            print(json.dumps({"ok": False, "code": "CONFIGURATION", "error": str(exc)}), flush=True)
            return 2
        except media_mod.MediaValidationError as exc:
            print(json.dumps({"ok": False, "code": "MEDIA_VALIDATION", "error": str(exc)}), flush=True)
            return 3

    payload: dict = {
        "ok": True,
        "probe": {
            "durationMs": probe.duration_ms,
            "sizeBytes": probe.size_bytes,
            "formatName": probe.format_name,
            "hasAudio": probe.has_audio,
            "hasVideo": probe.has_video,
            "width": probe.width,
            "height": probe.height,
        },
        "transcription": transcription,
        "segments": segments,
        "frames": frames,
        "visualCoverageLimited": visual_coverage_limited,
    }
    if transcription == "blocked_not_configured" and transcription_error:
        payload["transcriptionError"] = transcription_error
        payload["code"] = "CONFIGURATION"
    print(json.dumps(payload), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
