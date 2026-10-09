"""V01 media probe / limit tests. Live transcription is optional (faster-whisper)."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest

from opening_parser import media as media_mod
from opening_parser import transcribe as transcribe_mod


FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")
HAS_FFMPEG = bool(FFMPEG and FFPROBE)


def _write_silent_mp4(path: Path, *, duration_sec: float = 1.0, with_audio: bool = True) -> None:
    """Synthetic mp4 via ffmpeg lavfi — no real classroom content."""
    assert FFMPEG
    args = [
        FFMPEG,
        "-hide_banner",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        f"color=c=black:s=160x120:d={duration_sec}",
    ]
    if with_audio:
        args += ["-f", "lavfi", "-i", f"anullsrc=r=16000:cl=mono", "-t", str(duration_sec), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest"]
    else:
        args += ["-t", str(duration_sec), "-c:v", "libx264", "-pix_fmt", "yuv420p", "-an"]
    args.append(str(path))
    completed = subprocess.run(args, check=False, capture_output=True, text=True, shell=False)
    assert completed.returncode == 0, completed.stderr[-400:]


def test_build_ffprobe_argv_rejects_network_protocols():
    with pytest.raises(media_mod.MediaValidationError, match="network"):
        media_mod.build_ffprobe_argv("https://evil.example/a.mp4")
    argv = media_mod.build_ffprobe_argv("/tmp/lecture;rm.mp4")
    assert argv[-1] == "/tmp/lecture;rm.mp4"
    assert all(c not in "|&<>$`" for c in " ".join(argv) if c in "|&<>$`") or "|" not in " ".join(argv)


def test_parse_ffprobe_output_and_limits():
    probe = media_mod.parse_ffprobe_output(
        json.dumps(
            {
                "format": {"duration": "2.5", "size": "100", "format_name": "mp4"},
                "streams": [{"codec_type": "video", "width": 160, "height": 120}, {"codec_type": "audio"}],
            }
        )
    )
    assert probe.duration_ms == 2500
    assert probe.has_audio and probe.has_video
    with pytest.raises(media_mod.MediaValidationError, match="size limit"):
        media_mod.assert_within_limits(probe, max_bytes=50, max_duration_ms=10_000)
    with pytest.raises(media_mod.MediaValidationError, match="duration limit"):
        media_mod.assert_within_limits(
            media_mod.MediaProbe(duration_ms=media_mod.VIDEO_MAX_DURATION_MS + 1, size_bytes=1, format_name="mp4", has_audio=True, has_video=True, width=1, height=1),
            max_bytes=media_mod.VIDEO_MAX_BYTES,
            max_duration_ms=media_mod.VIDEO_MAX_DURATION_MS,
        )


def test_max_frames_caps():
    assert media_mod.max_frames_for_duration(30_000) == 1  # ceil((0.5 min)*2)
    assert media_mod.max_frames_for_duration(90 * 60_000) == 120


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")
def test_validate_local_media_accepts_synthetic_mp4(tmp_path: Path):
    target = tmp_path / "silent.mp4"
    _write_silent_mp4(target, duration_sec=1.0, with_audio=True)
    probe = media_mod.validate_local_media(target, mime="video/mp4")
    assert probe.has_video
    assert probe.has_audio
    assert probe.duration_ms >= 500


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")
def test_validate_rejects_bad_container(tmp_path: Path):
    bad = tmp_path / "not-media.bin"
    bad.write_bytes(b"not a media container")
    with pytest.raises(media_mod.MediaValidationError):
        media_mod.validate_local_media(bad, mime="video/mp4")


@pytest.mark.skipif(not HAS_FFMPEG, reason="ffmpeg/ffprobe not installed")
def test_audio_missing_on_silent_video(tmp_path: Path):
    target = tmp_path / "no-audio.mp4"
    _write_silent_mp4(target, duration_sec=1.0, with_audio=False)
    probe = media_mod.validate_local_media(target, mime="video/mp4")
    assert probe.has_video
    assert not probe.has_audio


def test_transcribe_reports_configuration_when_faster_whisper_missing(monkeypatch, tmp_path: Path):
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF")  # existence check only; import fails first when we force unavailable
    monkeypatch.setattr(transcribe_mod, "whisper_available", lambda: False)
    with pytest.raises(transcribe_mod.TranscriptionConfigurationError, match="faster-whisper"):
        transcribe_mod.transcribe_wav(wav)


def test_transcribe_wav_with_mocked_faster_whisper(monkeypatch, tmp_path: Path):
    """Unit coverage when weights are absent: mock WhisperModel, no network download."""
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF....WAVE")

    class FakeSeg:
        def __init__(self, start, end, text):
            self.start = start
            self.end = end
            self.text = text

    class FakeInfo:
        language = "zh"

    class FakeModel:
        def __init__(self, *args, **kwargs):
            assert kwargs.get("local_files_only") is True

        def transcribe(self, path, language=None, vad_filter=False):
            return iter([FakeSeg(0.0, 0.5, " 你好 "), FakeSeg(0.5, 0.5, ""), FakeSeg(1.0, 1.8, "世界")]), FakeInfo()

    class FakeFw:
        WhisperModel = FakeModel

    monkeypatch.setattr(transcribe_mod, "whisper_available", lambda: True)
    monkeypatch.setitem(__import__("sys").modules, "faster_whisper", FakeFw)
    # Also patch the import path used inside transcribe_wav
    import types
    monkeypatch.setattr(
        transcribe_mod,
        "whisper_available",
        lambda: True,
    )

    # Force import inside function to see our fake module
    import sys
    sys.modules["faster_whisper"] = FakeFw  # type: ignore[assignment]

    results = transcribe_mod.transcribe_wav(wav, model_size="base")
    assert [(r.start_ms, r.end_ms, r.text, r.language) for r in results] == [
        (0, 500, "你好", "zh"),
        (1000, 1800, "世界", "zh"),
    ]


def test_transcribe_offline_model_miss_is_configuration(monkeypatch, tmp_path: Path):
    wav = tmp_path / "a.wav"
    wav.write_bytes(b"RIFF")

    class BoomModel:
        def __init__(self, *args, **kwargs):
            raise RuntimeError("Cannot find an appropriate cached snapshot")

    class FakeFw:
        WhisperModel = BoomModel

    monkeypatch.setattr(transcribe_mod, "whisper_available", lambda: True)
    import sys
    sys.modules["faster_whisper"] = FakeFw  # type: ignore[assignment]

    with pytest.raises(transcribe_mod.TranscriptionConfigurationError, match="not available offline"):
        transcribe_mod.transcribe_wav(wav, model_size="base")


def test_process_media_cli_reports_blocked_when_whisper_missing(monkeypatch, tmp_path: Path):
    from opening_parser import process_media as pm

    media_file = tmp_path / "clip.mp4"
    media_file.write_bytes(b"not-used")
    out = tmp_path / "out"

    class Probe:
        duration_ms = 1000
        size_bytes = 10
        format_name = "mp4"
        has_audio = True
        has_video = False
        width = None
        height = None

    monkeypatch.setattr(pm.media_mod, "validate_local_media", lambda *a, **k: Probe())
    monkeypatch.setattr(
        pm.media_mod,
        "extract_audio_wav",
        lambda *a, **k: out / "audio.wav",
    )
    monkeypatch.setattr(pm.transcribe_mod, "whisper_available", lambda: False)

    def boom_transcribe(*a, **k):
        raise pm.transcribe_mod.TranscriptionConfigurationError("faster-whisper is not installed")

    monkeypatch.setattr(pm.transcribe_mod, "transcribe_wav", boom_transcribe)

    code = pm.main([
        "--input", str(media_file),
        "--mime", "video/mp4",
        "--output-dir", str(out),
        "--skip-frames",
    ])
    assert code == 0
