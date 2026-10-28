"""Small stdlib-only behavior tests; no installed Docling/OCR, network or models."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from opening_parser import __main__ as cli
from opening_parser import physical_pages
from opening_parser.ocr import MODEL_FILES, probe_ocr, tiny_inference


class OcrHealthTests(unittest.TestCase):
    def prepare(self, directory):
        for name in MODEL_FILES.values():
            (directory / name).write_bytes(b"unit-test-model")

    def test_not_configured_does_not_infer(self):
        report = probe_ocr("", lambda _: self.fail("must not infer"))
        self.assertEqual(report["status"], "not_configured")
        self.assertFalse(report["directoryConfigured"])

    def test_missing_directory_and_relative_path(self):
        for directory in ("/definitely-missing-aistudy-ocr", "relative-ocr"):
            report = probe_ocr(directory, lambda _: self.fail("must not infer"))
            self.assertEqual(report["status"], "missing_files")
            self.assertEqual(report["missingFiles"], list(MODEL_FILES.values()))
            self.assertFalse(report["directoryExists"])

    def test_requires_every_model_file_and_nonempty_file(self):
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            self.prepare(directory)
            for name in MODEL_FILES.values():
                (directory / name).write_bytes(b"")
                report = probe_ocr(temp, lambda _: self.fail("must not infer"))
                self.assertEqual(report["status"], "missing_files")
                self.assertEqual(report["missingFiles"], [name])
                (directory / name).write_bytes(b"model")

    def test_file_presence_alone_is_not_ready(self):
        with tempfile.TemporaryDirectory() as temp:
            self.prepare(Path(temp))
            def broken(_):
                raise RuntimeError("private model path and stack")
            report = probe_ocr(temp, broken)
            self.assertEqual(report["status"], "preflight_failed")
            self.assertIsNone(report["inferenceMs"])
            self.assertNotIn("private", json.dumps(report))

    def test_success_requires_an_inference(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp:
            self.prepare(Path(temp))
            report = probe_ocr(temp, calls.append)
            self.assertEqual(calls, [temp])
            self.assertEqual(report["status"], "ready")
            self.assertIsInstance(report["inferenceMs"], int)
            self.assertNotIn(temp, json.dumps(report))

    def test_tiny_inference_exercises_all_three_engines_and_blocks_download(self):
        calls = []
        configurations = []
        image = object()
        class Engine:
            def __init__(self, params):
                configurations.append(params)
            def text_det(self, value):
                self.assert_image(value)
                calls.append("det")
                return None  # no boxes still must exercise cls and rec
            def assert_image(self, value):
                if value is not image:
                    raise AssertionError("unexpected probe")
            def text_cls(self, values):
                self.assert_image(values[0])
                calls.append("cls")
                return SimpleNamespace(cls_res=[("0", 1)])
            def text_rec(self, value):
                self.assert_image(value.img[0])
                calls.append("rec")
                return SimpleNamespace(txts=["OCR"])
        downloader = SimpleNamespace(run=lambda *_: self.fail("network forbidden"))
        modules = {
            "rapidocr": SimpleNamespace(RapidOCR=Engine, EngineType=SimpleNamespace(TORCH="torch"),
                OCRVersion=SimpleNamespace(PPOCRV4="v4"), ModelType=SimpleNamespace(MOBILE="mobile")),
            "rapidocr.ch_ppocr_rec": SimpleNamespace(TextRecInput=SimpleNamespace),
            "rapidocr.utils.download_file": SimpleNamespace(DownloadFile=downloader),
            "numpy": SimpleNamespace(full=lambda *_args, **_kw: image, uint8="uint8"),
            "cv2": SimpleNamespace(putText=lambda *_: None, FONT_HERSHEY_SIMPLEX=0),
        }
        with tempfile.TemporaryDirectory() as temp, patch.dict(sys.modules, modules):
            self.prepare(Path(temp))
            tiny_inference(temp)
            self.assertEqual(calls, ["det", "cls", "rec"])
            self.assertIsInstance(configurations[0]["Global.model_root_dir"], Path)
            self.assertEqual(configurations[0]["Rec.rec_keys_path"], str(Path(temp) / MODEL_FILES["keys"]))
            with self.assertRaisesRegex(RuntimeError, "downloads are disabled"):
                downloader.run("https://no-network")


class PdfSegmentTests(unittest.TestCase):
    def call(self, *args):
        output, error = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(error):
            code = cli.main(list(args))
        return code, output.getvalue(), error.getvalue()

    def test_range_keeps_physical_pages_and_blank_pages(self):
        document = SimpleNamespace(pages=[11, 12], texts=[SimpleNamespace(text="page eleven", prov=[SimpleNamespace(page_no=11)])])
        with tempfile.NamedTemporaryFile() as file, patch.object(cli, "pdf_page_count", return_value=12), patch.object(cli, "convert", return_value=document) as convert:
            code, output, _ = self.call("--input", file.name, "--mime", cli.PDF, "--max-pages", "2000", "--page-start", "11", "--page-end", "12")
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output)["pages"], [{"page": 11, "text": "page eleven", "imagePath": None, "visualKinds": []}, {"page": 12, "text": "", "imagePath": None, "visualKinds": ["scan"]}])
            self.assertEqual(convert.call_args.args[2], (11, 12))

    def test_inspection_does_not_initialize_converter(self):
        with tempfile.NamedTemporaryFile() as file, patch.object(cli, "pdf_page_count", return_value=72), patch.object(cli, "convert", side_effect=AssertionError("no conversion")):
            code, output, _ = self.call("--input", file.name, "--mime", cli.PDF, "--max-pages", "2000", "--inspect-pdf")
            self.assertEqual((code, json.loads(output)), (0, {"pageCount": 72}))

    def test_range_outside_pdf_and_max_pages_fail_before_conversion(self):
        with tempfile.NamedTemporaryFile() as file, patch.object(cli, "pdf_page_count", return_value=12), patch.object(cli, "convert", side_effect=AssertionError("no conversion")):
            for max_pages, end in (("2000", "13"), ("10", "12")):
                code, output, _ = self.call("--input", file.name, "--mime", cli.PDF, "--max-pages", max_pages, "--page-start", "11", "--page-end", end)
                self.assertEqual((code, output), (5, ""))

    def test_rebased_provenance_is_rejected(self):
        document = SimpleNamespace(pages=[1, 2], texts=[])
        with tempfile.NamedTemporaryFile() as file, patch.object(cli, "pdf_page_count", return_value=12), patch.object(cli, "convert", return_value=document):
            code, output, _ = self.call("--input", file.name, "--mime", cli.PDF, "--max-pages", "2000", "--page-start", "11", "--page-end", "12")
            self.assertEqual((code, output), (5, ""))

    def test_converter_receives_range_before_document_processing(self):
        calls = []
        result = SimpleNamespace(document="bounded document", pages=["retained assembly"], status=SimpleNamespace(value="success"))
        def convert(path, **kwargs):
            calls.append((path, kwargs))
            return result
        with patch.object(cli, "create_converter", return_value=SimpleNamespace(convert=convert)):
            self.assertIs(cli.convert(Path("source.pdf"), 1, (11, 20)), result)
            self.assertEqual(calls, [(Path("source.pdf"), {"page_range": (11, 20)})])

    def test_partial_docling_result_is_not_a_successful_blank_page(self):
        result = SimpleNamespace(document=SimpleNamespace(pages=[11, 12], texts=[]), status=SimpleNamespace(value="partial_success"))
        with patch.object(cli, "create_converter", return_value=SimpleNamespace(convert=lambda *_args, **_kwargs: result)):
            with self.assertRaisesRegex(RuntimeError, "every requested page"):
                cli.convert(Path("source.pdf"), 1, (11, 12))

    def result(self, *texts):
        pages = [SimpleNamespace(page_no=number, assembled=SimpleNamespace(elements=[
            SimpleNamespace(page_no=number, text=text),
        ] if text else [])) for number, text in enumerate(texts, 11)]
        return SimpleNamespace(document=SimpleNamespace(pages=[page.page_no for page in pages], texts=[]),
            pages=pages, input=SimpleNamespace(format="pdf"), status=SimpleNamespace(value="success"))

    def render_page(self, _conversion, page):
        return SimpleNamespace(pages=[page.page_no], texts=[SimpleNamespace(text=element.text,
            prov=[SimpleNamespace(page_no=page.page_no)]) for element in page.assembled.elements])

    def test_premerge_pages_ignore_broken_charspans_and_keep_blank_page(self):
        result = self.result("inter-", "national", "")
        # Real 2.126.0 merge shape: spans are calculated before hyphen removal.
        result.document.texts = [SimpleNamespace(text="international", orig="international", prov=[
            SimpleNamespace(page_no=11, charspan=(0, 6)), SimpleNamespace(page_no=12, charspan=(7, 15)),
        ])]
        with tempfile.NamedTemporaryFile() as file, patch.object(cli, "pdf_page_count", return_value=13), \
                patch.object(cli, "convert", return_value=result), \
                patch.object(physical_pages, "_assemble_page", side_effect=self.render_page) as render:
            code, output, _ = self.call("--input", file.name, "--mime", cli.PDF, "--max-pages", "2000", "--page-start", "11", "--page-end", "13")
            self.assertEqual(code, 0)
            self.assertEqual(json.loads(output)["pages"], [
                {"page": 11, "text": "inter-", "imagePath": None, "visualKinds": []},
                {"page": 12, "text": "national", "imagePath": None, "visualKinds": []},
                {"page": 13, "text": "", "imagePath": None, "visualKinds": ["scan"]},
            ])
            self.assertEqual([call.args[1].page_no for call in render.call_args_list], [11, 12, 13])

    def test_missing_duplicate_or_wrong_page_assembly_fails_not_blank_success(self):
        missing = self.result("one", "two")
        missing.pages[1].assembled = None
        omitted = self.result("one", "two")
        omitted.pages.pop()
        duplicated = self.result("one", "two")
        duplicated.pages.append(duplicated.pages[0])
        wrong = self.result("one", "two")
        wrong.pages[0].assembled.elements[0].page_no = 12
        empty = self.result("one")
        empty.pages = []
        for result in (missing, omitted, duplicated, wrong, empty):
            with self.subTest(result=result), tempfile.NamedTemporaryFile() as file, \
                    patch.object(cli, "convert", return_value=result), \
                    patch.object(physical_pages, "_assemble_page", side_effect=self.render_page):
                code, output, _ = self.call("--input", file.name, "--mime", cli.PDF, "--max-pages", "2000")
                self.assertEqual((code, output), (4, ""))

    def test_document_only_merged_text_or_table_fails_without_guessing(self):
        provenance = [SimpleNamespace(page_no=11, charspan=(0, 6)), SimpleNamespace(page_no=12, charspan=(7, 15))]
        text = SimpleNamespace(text="international", orig="international", prov=provenance)
        table = SimpleNamespace(prov=provenance, export_to_markdown=lambda **_: "must not duplicate")
        for texts, tables in (([text], []), ([], [table])):
            with self.assertRaisesRegex(RuntimeError, "pre-merge assembly required"):
                cli.texts_by_page(SimpleNamespace(pages=[11, 12], texts=texts, tables=tables))

    def test_partial_result_or_assembly_serializer_failure_never_prints_success(self):
        result = self.result("one", "two")
        with tempfile.NamedTemporaryFile() as file, patch.object(cli, "convert", return_value=result), \
                patch.object(physical_pages, "_assemble_page", side_effect=RuntimeError("table serialization failed")):
            code, output, error = self.call("--input", file.name, "--mime", cli.PDF, "--max-pages", "2000")
            self.assertEqual((code, output), (4, ""))
            self.assertIn("table serialization failed", error)
        result.status.value = "partial_success"
        with patch.object(physical_pages, "_assemble_page", side_effect=AssertionError("must not assemble")):
            with self.assertRaisesRegex(RuntimeError, "every requested page"):
                cli.texts_by_page(result)

    def test_pptx_result_without_assembly_keeps_slides_tables_and_formula_orig(self):
        doc = SimpleNamespace(pages=[1, 2, 3], texts=[
            SimpleNamespace(text="slide one", prov=[SimpleNamespace(page_no=1)]),
            SimpleNamespace(text="", orig="x² + y²", label="formula", prov=[SimpleNamespace(page_no=2)]),
        ], tables=[SimpleNamespace(prov=[SimpleNamespace(page_no=2)], export_to_markdown=lambda **_: "| x | y |")])
        result = SimpleNamespace(document=doc, pages=[], input=SimpleNamespace(format="pptx"), status=SimpleNamespace(value="success"))
        with tempfile.NamedTemporaryFile() as file, patch.object(cli, "convert", return_value=result), \
                patch.object(physical_pages, "_assemble_page", side_effect=AssertionError("PPTX has no page assembly")):
            code, output, _ = self.call("--input", file.name, "--mime", cli.PPTX, "--max-pages", "2000")
            self.assertEqual(code, 0)
            self.assertEqual([page["text"] for page in json.loads(output)["pages"]], ["slide one", "x² + y²\n| x | y |", ""])


if __name__ == "__main__":
    unittest.main()
