"""Audio transcription adapter (faster-whisper). Offline / local weights only."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path


class TranscriptionConfigurationError(RuntimeError):
    code = "CONFIGURATION"


@dataclass(frozen=True)
class TranscriptSegment:
    start_ms: int
    end_ms: int
    text: str
    language: str | None


def whisper_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
    except ImportError:
        return False
    return True


def transcribe_wav(
    wav_path: str | Path,
    *,
    model_size: str = "base",
    language: str | None = None,
    model_path: str | None = None,
) -> list[TranscriptSegment]:
    """
    Transcribe a local wav. Raises TranscriptionConfigurationError when
    faster-whisper or model weights are unavailable. Does not download unknown weights.
    """
    path = Path(wav_path)
    if not path.is_file():
        raise FileNotFoundError(f"wav not found: {path}")
    if not whisper_available():
        raise TranscriptionConfigurationError(
            "faster-whisper is not installed; live transcription is blocked until the optional dependency is configured"
        )
    import faster_whisper

    # Prefer an explicit local model directory; never auto-download unknown weights.
    if model_path:
        model = faster_whisper.WhisperModel(model_path, local_files_only=True)
    else:
        # model_size may resolve from a pre-seeded cache; local_files_only avoids network.
        try:
            model = faster_whisper.WhisperModel(model_size, local_files_only=True)
        except Exception as exc:  # noqa: BLE001 — surface as configuration
            raise TranscriptionConfigurationError(
                f"faster-whisper model '{model_size}' is not available offline: {exc}"
            ) from exc

    segments_iter, info = model.transcribe(str(path), language=language, vad_filter=True)
    language_out = getattr(info, "language", language)
    results: list[TranscriptSegment] = []
    for segment in segments_iter:
        start_ms = int(round(float(segment.start) * 1000))
        end_ms = int(round(float(segment.end) * 1000))
        if end_ms <= start_ms:
            continue
        text = (segment.text or "").strip()
        if not text:
            continue
        results.append(TranscriptSegment(start_ms=start_ms, end_ms=end_ms, text=text, language=language_out))
    return results
