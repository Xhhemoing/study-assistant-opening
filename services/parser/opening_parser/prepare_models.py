"""Explicit online setup; document conversion never calls this module."""
import json
import os
from pathlib import Path


def main():
    parser_dir = Path(__file__).resolve().parents[1]
    os.environ.setdefault("HF_HOME", str(parser_dir.parents[1] / ".local" / "hf-home"))
    os.environ["HF_HUB_OFFLINE"] = "0"
    from huggingface_hub import snapshot_download
    manifest = json.loads((parser_dir / "model-manifest.json").read_text(encoding="utf-8"))
    for model in manifest["models"]:
        location = snapshot_download(repo_id=model["model"], revision=model["revision"])
        print(f"Prepared {model['model']} at {location}")


if __name__ == "__main__":
    main()
