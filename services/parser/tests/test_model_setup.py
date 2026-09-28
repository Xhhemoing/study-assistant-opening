import json
import os
import sys
from pathlib import Path
from types import SimpleNamespace


def test_setup_downloads_only_manifest_revisions(monkeypatch, tmp_path):
    from opening_parser import prepare_models
    calls = []
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=lambda **args: calls.append(args)))
    prepare_models.main()
    manifest = json.loads((Path(__file__).parents[1] / "model-manifest.json").read_text(encoding="utf-8"))
    assert calls == [{"repo_id": model["model"], "revision": model["revision"]} for model in manifest["models"]]
    assert os.environ["HF_HOME"] == str(tmp_path)
    assert os.environ["HF_HUB_OFFLINE"] == "0"
