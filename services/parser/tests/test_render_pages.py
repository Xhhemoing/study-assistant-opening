import io
import runpy
import sys
from types import SimpleNamespace
from unittest.mock import MagicMock, Mock

import pytest


def test_closes_image_and_pdf_handles_when_png_encoding_fails(monkeypatch):
    handles = MagicMock()
    document = handles.document
    document.__len__.return_value = 1
    document.__getitem__.return_value = handles.page
    handles.page.get_size.return_value = (100, 100)
    handles.page.render.return_value = handles.bitmap
    handles.bitmap.to_pil.return_value = handles.image
    handles.image.save.side_effect = OSError("PNG encoding failed")
    monkeypatch.setitem(sys.modules, "pypdfium2", SimpleNamespace(PdfDocument=Mock(return_value=document)))
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(b"pdf")))
    monkeypatch.setattr(sys, "argv", ["render_pages", "[1]"])

    with pytest.raises(OSError, match="PNG encoding failed"):
        runpy.run_module("opening_parser.render_pages", run_name="__main__")

    handles.image.close.assert_called_once_with()
    handles.bitmap.close.assert_called_once_with()
    handles.page.close.assert_called_once_with()
    document.close.assert_called_once_with()
