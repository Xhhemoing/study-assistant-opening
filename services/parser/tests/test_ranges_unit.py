"""Stdlib-only ranges CLI tests. No Docling imports, model inference or network."""
import contextlib
import io
import json
import logging
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

from opening_parser import __main__ as cli
from opening_parser import physical_pages
from opening_parser.ranges import json_line, failure


def result(start, end, text="第二页\n∞"):
    pages = [NS(page_no=n, assembled=NS(elements=[NS(page_no=n, text=text)] if n == start else []))
             for n in range(start, end + 1)]
    return NS(document=NS(pages=list(range(start, end + 1)), texts=[]), pages=pages,
              input=NS(format="pdf"), status=NS(value="success"))


def assemble(_conversion, page):
    return NS(pages=[page.page_no], texts=[NS(text=e.text, prov=[NS(page_no=page.page_no)])
                                         for e in page.assembled.elements])


class ObservableOutput(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flushed = []

    def flush(self):
        self.flushed = self.getvalue().splitlines()


class RangesTests(unittest.TestCase):
    def invoke(self, converter, ranges="11-12,15-16", extra=(), output=None, total=20):
        output = output if output is not None else ObservableOutput()
        stderr = io.StringIO()
        with tempfile.NamedTemporaryFile() as source, \
                patch.object(cli, "create_converter", return_value=converter) as factory, \
                patch.object(cli, "pdf_page_count", return_value=total), \
                patch.object(physical_pages, "_assemble_page", side_effect=assemble), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(stderr):
            code = cli.main(["--input", source.name, "--mime", cli.PDF, "--max-pages", "2000",
                             "--ranges", ranges, *extra])
        return code, [json.loads(line) for line in output.getvalue().splitlines()], factory, stderr.getvalue()

    def test_single_factory_flush_before_next_range_and_physical_blank_pages(self):
        output = ObservableOutput()
        calls = []
        def convert(_path, page_range):
            self.assertEqual(len(output.flushed), len(calls))
            calls.append(page_range)
            print("Docling stdout warning")
            logging.error("pre-bound logging warning")
            return result(*page_range)
        code, lines, factory, stderr = self.invoke(NS(convert=convert), output=output)
        self.assertEqual(code, 0)
        factory.assert_called_once_with()
        self.assertEqual(calls, [(11, 12), (15, 16)])
        self.assertEqual([line["range"] for line in lines], [[11, 12], [15, 16]])
        self.assertEqual(lines[0]["pages"], [
            {"page": 11, "text": "第二页\n∞", "imagePath": None},
            {"page": 12, "text": "", "imagePath": None}])
        self.assertEqual(len(output.flushed), 2)
        self.assertIn("Docling stdout warning", stderr)

    def test_conversion_failure_continues_and_invalid_physical_output_continues(self):
        calls = []
        def convert(_path, page_range):
            calls.append(page_range)
            if page_range[0] == 11:
                raise RuntimeError("failed")
            if page_range[0] == 13:
                return result(1, 2)  # rebasing must not become blank success
            return result(*page_range)
        code, lines, _, _ = self.invoke(NS(convert=convert), "11-12,13-14,15-16")
        self.assertEqual(code, 4)
        self.assertEqual(len(calls), 3)
        self.assertEqual(lines[:2], [failure((11, 12), "conversion_failed"), failure((13, 14), "invalid_output")])
        self.assertIn("pages", lines[2])

    def test_incomplete_partial_duplicate_or_missing_assembly_is_invalid(self):
        broken = []
        partial = result(11, 12)
        partial.status.value = "partial_success"
        missing = result(11, 12)
        missing.pages[0].assembled = None
        duplicate = result(11, 12)
        duplicate.pages.append(duplicate.pages[0])
        omitted = result(11, 12)
        omitted.pages.pop()
        broken.extend([(partial, "conversion_failed"), (missing, "invalid_output"),
                       (duplicate, "invalid_output"), (omitted, "invalid_output")])
        for conversion, error in broken:
            with self.subTest(error=error):
                code, lines, _, _ = self.invoke(NS(convert=lambda *_a, **_kw: conversion), "11-12")
                self.assertEqual((code, lines), (4, [failure((11, 12), error)]))

    def test_live_timeout_stops_remaining_ranges_preserving_success(self):
        release, finished = threading.Event(), threading.Event()
        calls = []
        def convert(_path, page_range):
            calls.append(page_range)
            if page_range[0] == 13:
                try:
                    release.wait(5)
                finally:
                    finished.set()
            return result(*page_range)
        try:
            code, lines, _, _ = self.invoke(NS(convert=convert), "11-12,13-14,15-16",
                                           extra=("--timeout-seconds", "0.05"))
            self.assertEqual(code, 4)
            self.assertEqual(calls, [(11, 12), (13, 14)])
            self.assertIn("pages", lines[0])
            self.assertEqual(lines[1], failure((13, 14), "timeout"))
        finally:
            release.set()
            self.assertTrue(finished.wait(2))

    def test_cli_timeout_exits_even_when_converter_owns_non_daemon_executor_threads(self):
        script = r'''
import sys, time
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace as NS
from opening_parser import __main__ as cli
pool = ThreadPoolExecutor(max_workers=1)
cli.pdf_page_count = lambda _: 3
cli.texts_by_page = lambda r: {r.number: ["preserved"]}
class Converter:
    def convert(self, path, page_range):
        if page_range[0] == 2:
            pool.submit(time.sleep, 30)
            time.sleep(30)
        return NS(number=page_range[0], status=NS(value="success"))
cli.create_converter = Converter
sys.exit(cli.main(["--input", sys.argv[1], "--mime", cli.PDF, "--max-pages", "3",
                   "--ranges", "1-1,2-2,3-3", "--timeout-seconds", "0.05"], terminate_on_timeout=True))
'''
        with tempfile.NamedTemporaryFile() as source:
            child = subprocess.run([sys.executable, "-c", script, source.name],
                                   capture_output=True, timeout=3)
        self.assertEqual(child.returncode, 4)
        rows = [json.loads(line) for line in child.stdout.splitlines()]
        self.assertEqual([row["range"] for row in rows], [[1, 1], [2, 2]])
        self.assertEqual(rows[0]["pages"][0]["text"], "preserved")
        self.assertEqual(rows[1], failure((2, 2), "timeout"))

    def test_malformed_overlap_disorder_and_bounds_do_not_create_converter(self):
        for ranges in ("", "1", "1-", "1-2,", "0-1", "3-2", "1-3,3-5", "4-5,1-2",
                       "1-2,1-2", "1-2, 3-4", "1-21"):
            with self.subTest(ranges=ranges):
                code, lines, factory, _ = self.invoke(NS(), ranges)
                self.assertEqual((code, lines), (5, []))
                factory.assert_not_called()
        code, lines, factory, _ = self.invoke(NS(), "1-2", extra=("--max-pages", "10"))
        self.assertEqual((code, lines), (5, []))
        factory.assert_not_called()

    def test_conflicting_flags_and_pptx_are_usage_errors(self):
        for extra in (("--inspect-pdf",), ("--page-start", "1"), ("--page-end", "2"),
                      ("--page-start", "1", "--page-end", "2"), ("--check",), ("--mime", cli.PPTX)):
            with self.subTest(extra=extra), self.assertRaises(SystemExit) as caught:
                self.invoke(NS(), extra=extra)
            self.assertEqual(caught.exception.code, 2)

    def test_text_cap_and_total_utf8_cap_include_envelopes_and_newlines(self):
        converter = NS(convert=lambda _path, page_range: result(*page_range, text="中" * 100))
        with patch.object(cli, "TEXT_CAP", 3):
            code, lines, _, _ = self.invoke(converter, "11-11")
        self.assertEqual(code, 0)
        self.assertEqual(lines[0]["pages"][0]["text"], "中中中\n…[truncated]")
        converter = NS(convert=lambda _path, page_range: result(*page_range, text="中" * 20))
        cap = len(json_line({"range": [11, 11], "pages": [{"page": 11, "text": "中" * 20, "imagePath": None}]}).encode("utf-8"))
        with patch.object(cli, "CAP", cap):
            code, lines, _, _ = self.invoke(converter, "11-11,12-12")
        self.assertEqual(code, 5)
        self.assertEqual(len(lines), 2)
        self.assertTrue(any(line.get("error") == "invalid_output" for line in lines))
        self.assertLessEqual(sum(len(json_line(line).encode("utf-8")) for line in lines), cap)
        with patch.object(cli, "CAP", 1):
            code, lines, factory, _ = self.invoke(converter)
        self.assertEqual((code, lines), (5, []))
        factory.assert_not_called()

    def test_exact_cap_accepts_line_but_one_byte_less_rejects_success(self):
        expected = {"range": [11, 11], "pages": [{"page": 11, "text": "中", "imagePath": None}]}
        cap = len(json_line(expected).encode("utf-8"))
        for limit, expected_code in ((cap, 0), (cap - 1, 5)):
            with patch.object(cli, "CAP", limit):
                code, lines, _, _ = self.invoke(NS(convert=lambda *_a, **_kw: result(11, 11, "中")), "11-11")
            self.assertEqual(code, expected_code)
            self.assertEqual(lines, [expected] if code == 0 else [failure((11, 11), "invalid_output")])

    def test_initialization_failure_reports_every_range_once(self):
        with patch.object(cli, "create_converter", side_effect=RuntimeError("init")):
            # invoke owns the factory patch, so exercise initialization separately.
            with tempfile.NamedTemporaryFile() as source, patch.object(cli, "pdf_page_count", return_value=20), \
                    contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                code = cli.main(["--input", source.name, "--mime", cli.PDF, "--max-pages", "20", "--ranges", "1-2,3-4"])
        self.assertEqual(code, 4)
        self.assertEqual([json.loads(s) for s in output.getvalue().splitlines()],
                         [failure((1, 2), "conversion_failed"), failure((3, 4), "conversion_failed")])

    def test_old_convert_api_single_range_and_pptx_contract(self):
        conversion = result(11, 12)
        with patch.object(cli, "create_converter", return_value=NS(convert=lambda *_a, **_kw: conversion)) as factory:
            self.assertIs(cli.convert(Path("fake.pdf"), 1, (11, 12)), conversion)
            factory.assert_called_once_with()
        for mime, flags in ((cli.PDF, ["--page-start", "11", "--page-end", "12"]), (cli.PPTX, [])):
            with tempfile.NamedTemporaryFile() as source, patch.object(cli, "convert", return_value=NS(pages=[11, 12], texts=[])) as convert, \
                    patch.object(cli, "pdf_page_count", return_value=12), \
                    contextlib.redirect_stdout(io.StringIO()) as output, contextlib.redirect_stderr(io.StringIO()):
                code = cli.main(["--input", source.name, "--mime", mime, "--max-pages", "20", *flags])
            self.assertEqual(code, 0)
            self.assertEqual(set(json.loads(output.getvalue())), {"pages"})
            self.assertEqual(len(convert.call_args.args), 3 if flags else 2)

    def test_real_pipe_receives_first_line_before_next_conversion_and_native_logs_stay_off_stdout(self):
        script = r'''
import os, sys, tempfile
from types import SimpleNamespace as NS
from opening_parser import __main__ as cli
cli.pdf_page_count = lambda _: 4
cli.texts_by_page = lambda r: {r.number: ["中"]}
class Converter:
    def convert(self, path, page_range):
        os.write(1, b"native docling warning\n")
        print("python docling warning")
        if page_range[0] == 3:
            # Parent must observe the first flushed line before releasing us.
            sys.stdin.readline()
        return NS(number=page_range[0], status=NS(value="success"))
cli.create_converter = Converter
with tempfile.NamedTemporaryFile() as source:
    sys.exit(cli.main(["--input", source.name, "--mime", cli.PDF, "--max-pages", "4", "--ranges", "1-1,3-3"]))
'''
        process = subprocess.Popen([sys.executable, "-c", script], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        first = []
        reader = threading.Thread(target=lambda: first.append(process.stdout.readline()), daemon=True)
        reader.start()
        try:
            reader.join(3)
            self.assertFalse(reader.is_alive(), "first JSONL was not flushed")
            self.assertEqual(json.loads(first[0])["range"], [1, 1])
            stdout, stderr = process.communicate(b"continue\n", timeout=5)
            self.assertEqual(process.returncode, 0)
            self.assertEqual(json.loads(stdout)["range"], [3, 3])
            self.assertIn("中".encode("utf-8"), first[0])
            self.assertIn(b"native docling warning", stderr)
            self.assertIn(b"python docling warning", stderr)
        finally:
            if process.poll() is None:
                process.kill()
                process.communicate()
            reader.join(2)


if __name__ == "__main__":
    unittest.main()
