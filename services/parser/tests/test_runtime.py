import builtins
import json
import os
from pathlib import Path
from types import SimpleNamespace

from opening_parser import __main__ as cli


def test_check_reports_missing_docling_import(monkeypatch, capsys):
    original = builtins.__import__

    def missing_docling(name, *args, **kwargs):
        if name.startswith("docling."):
            raise ModuleNotFoundError("No module named 'docling'")
        return original(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", missing_docling)
    assert cli.main(["--check"]) == 4
    assert "docling" in capsys.readouterr().err


def test_configured_cache_is_preserved_and_downloads_remain_offline(monkeypatch, tmp_path):
    monkeypatch.setenv("HF_HOME", str(tmp_path))
    monkeypatch.setenv("HF_HUB_OFFLINE", "0")
    converter = cli.create_converter()
    assert os.environ["HF_HOME"] == str(tmp_path)
    assert os.environ["HF_HUB_OFFLINE"] == "1"
    manifest = json.loads((Path(__file__).parents[1] / "model-manifest.json").read_text(encoding="utf-8"))
    model = next(model for model in manifest["models"] if model["model"] == "docling-project/docling-layout-heron")
    from docling.datamodel.base_models import InputFormat
    assert converter.format_to_options[InputFormat.PDF].pipeline_options.layout_options.model_spec.revision == model["revision"]


def document(text):
    return SimpleNamespace(pages=[1], texts=[SimpleNamespace(text=text, prov=[SimpleNamespace(page_no=1)])])


def test_text_cap_is_preserved(monkeypatch, tmp_path, capsys):
    file = tmp_path / "test.pdf"
    file.write_bytes(b"input")
    monkeypatch.setattr(cli, "convert", lambda *_: document("a" * (cli.TEXT_CAP + 1)))
    assert cli.main(["--input", str(file), "--mime", cli.PDF, "--max-pages", "1"]) == 0
    text = json.loads(capsys.readouterr().out)["pages"][0]["text"]
    assert text == "a" * cli.TEXT_CAP + "\n…[truncated]"


def test_output_cap_is_preserved(monkeypatch, tmp_path, capsys):
    file = tmp_path / "test.pdf"
    file.write_bytes(b"input")
    monkeypatch.setattr(cli, "CAP", 16)
    monkeypatch.setattr(cli, "convert", lambda *_: document("too much output"))
    assert cli.main(["--input", str(file), "--mime", cli.PDF, "--max-pages", "1"]) == 5
    assert capsys.readouterr().out == ""


def test_timeout_is_a_conversion_failure(monkeypatch, tmp_path, capsys):
    file = tmp_path / "test.pdf"
    file.write_bytes(b"input")

    def timeout(*_):
        raise TimeoutError("conversion timed out")

    monkeypatch.setattr(cli, "convert", timeout)
    assert cli.main(["--input", str(file), "--mime", cli.PDF, "--max-pages", "1"]) == 4
    assert "timed out" in capsys.readouterr().err
