# Opening media fixtures (V01)

Synthetic fixtures only — no real classroom recordings.

## Purpose

Support worker/Python tests for:

- container / duration / size validation (ffprobe)
- audio track present vs missing (silent board video)
- overlong / oversize rejection messages
- keyframe caps (2/min, 120/file)

## Generation

Prefer generating ephemeral files in pytest via ffmpeg lavfi (see `services/parser/tests/test_media.py`):

```bash
ffmpeg -f lavfi -i color=c=black:s=160x120:d=1 -f lavfi -i anullsrc=r=16000:cl=mono \
  -t 1 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest tests/fixtures/opening/media/silent-1s.mp4
```

Silent (no audio track):

```bash
ffmpeg -f lavfi -i color=c=black:s=160x120:d=1 -t 1 -c:v libx264 -pix_fmt yuv420p -an \
  tests/fixtures/opening/media/silent-board-1s.mp4
```

Committed binary fixtures are optional; tests create temps when ffmpeg is available.

## Live transcription

`faster-whisper` is an **optional** parser extra (`pip install -e 'services/parser[media]'`).
Until offline weights are configured, the worker reports `transcription: blocked_not_configured`
/ `CONFIGURATION` rather than downloading models. Audio-only transcripts must not be claimed as
visual/board understanding.

## Worker adapter

`python -m opening_parser.process_media --input ... --mime ... --output-dir ...`
returns JSON with `transcription` (`completed` | `skipped_no_audio` | `blocked_not_configured`),
`segments`, and `frames`. The worker `createPythonTranscribeAdapter` consumes this and maps
missing weights to `CONFIGURATION` / `blocked_not_configured`.
