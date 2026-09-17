import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

PARSER_DIR = Path(__file__).parents[1]
FIXTURE = Path(__file__).parents[3] / "tests" / "fixtures" / "opening" / "parser-two-page.pdf"


def run_cli(*args):
    env = os.environ.copy()
    env["PYTHONPATH"] = str(PARSER_DIR) + os.pathsep + env.get("PYTHONPATH", "")
    return subprocess.run([sys.executable, "-m", "opening_parser", *map(str, args)], cwd=PARSER_DIR.parents[1], env=env, capture_output=True, text=True)


def write_pdf(path: Path) -> None:
    pages = ["Opening parser page one", "Opening parser page two"]
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>", b"<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>"]
    for index, text in enumerate(pages):
        stream = f"BT /F1 18 Tf 72 720 Td ({text}) Tj ET".encode()
        page = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 {0} 0 R >> >> /Contents {1} 0 R >>".format(7 + index, 4 + index * 2).encode()
        objects += [page, f"<< /Length {len(stream)} >>\nstream\n".encode() + stream + b"\nendstream"]
    objects += [b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"] * 2
    output, offsets = bytearray(b"%PDF-1.4\n"), [0]
    for number, obj in enumerate(objects, 1):
        offsets.append(len(output))
        output.extend("{} 0 obj\n".format(number).encode() + obj + b"\nendobj\n")
    xref = len(output)
    output.extend("xref\n0 {}\n0000000000 65535 f \n".format(len(objects) + 1).encode())
    output.extend(b"".join("{:010d} 00000 n \n".format(offset).encode() for offset in offsets[1:]))
    output.extend("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{}\n%%EOF\n".format(len(objects) + 1, xref).encode())
    path.write_bytes(output)


def test_two_page_pdf_preserves_provenance_and_text(tmp_path):
    pdf = tmp_path / "two-page.pdf"
    write_pdf(pdf)
    result = run_cli("--input", pdf, "--mime", "application/pdf", "--max-pages", 2)
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert [page["page"] for page in payload["pages"]] == [1, 2]
    assert "page one" in payload["pages"][0]["text"]
    assert "page two" in payload["pages"][1]["text"]
    assert all(page["imagePath"] is None for page in payload["pages"])


def test_max_pages_rejects_truncation(tmp_path):
    pdf = tmp_path / "two-page.pdf"
    write_pdf(pdf)
    result = run_cli("--input", pdf, "--mime", "application/pdf", "--max-pages", 1)
    assert result.returncode == 5 and result.stdout == ""


def test_unsupported_mime_is_exit_three():
    result = run_cli("--input", FIXTURE, "--mime", "image/png", "--max-pages", 2)
    assert result.returncode == 3 and result.stdout == ""


def test_missing_input_is_usage_error():
    result = run_cli("--mime", "application/pdf", "--max-pages", 2)
    assert result.returncode == 2


def test_nonexistent_file_is_conversion_error():
    result = run_cli("--input", "missing.pdf", "--mime", "application/pdf", "--max-pages", 2)
    assert result.returncode == 4 and result.stdout == ""


@pytest.mark.xfail(reason="Hand-built PPTX compatibility depends on Docling's presentation backend")
def test_minimal_pptx_conversion():
    pytest.fail("PPTX fixture deferred until backend-compatible XML is available")
