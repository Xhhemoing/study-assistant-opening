"""Installed Docling data/reading-order regression; no converter, models or network.

Run separately in the pinned parser venv. The stdlib-only suite tests boundary
failures; this suite exercises real ConversionResult/Page/ReadingOrderModel and
TableItem export, including the upstream merge that corrupts charspans.
"""
import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from hashlib import sha256
from importlib.util import find_spec
from pathlib import Path
from time import perf_counter
from types import SimpleNamespace
from unittest.mock import patch

from opening_parser import __main__ as cli
from opening_parser import physical_pages


WORKER_FIXTURE_MODE = __name__ == "__main__" and sys.argv[1:] == ["--worker-fixtures"]
USE_DOCLING = not WORKER_FIXTURE_MODE or find_spec("docling") is not None
if USE_DOCLING:
    from docling.datamodel.base_models import AssembledUnit, Cluster, ConversionStatus, InputFormat, LayoutPrediction, Page, Table, TextElement
    from docling.datamodel.document import ConversionResult, InputDocument
    from docling.models.stages.page_assemble.page_assemble_model import PageAssembleModel, PageAssembleOptions
    from docling.models.stages.reading_order.readingorder_model import ReadingOrderModel, ReadingOrderOptions
    from docling_core.types.doc import BoundingBox, ContentLayer, DocItemLabel, DoclingDocument, ProvenanceItem, Size, TableCell
    from docling_core.types.doc.page import SegmentedPdfPage, TextCell

    SIZE = Size(width=612, height=792)


def cluster(identifier, label=None):
    return Cluster(id=identifier, label=label or DocItemLabel.TEXT, bbox=BoundingBox(l=72, t=72 + identifier * 40, r=500, b=100 + identifier * 40))


def text_element(page_no, text, identifier=1, label=None):
    label = label or DocItemLabel.TEXT
    return TextElement(id=identifier, label=label, page_no=page_no, text=text, cluster=cluster(identifier, label))


def result_for(*page_elements, start_page=11):
    pages = [Page(page_no=number, size=SIZE, assembled=AssembledUnit(elements=elements))
        for number, elements in enumerate(page_elements, start_page)]
    # A data-only InputDocument avoids opening any backend or PDF file.
    source = InputDocument.model_construct(file=Path("physical-pages.pdf"), format=InputFormat.PDF, document_hash="0" * 64)
    doc = DoclingDocument(name="physical-pages")
    for page in pages:
        doc.add_page(page_no=page.page_no, size=SIZE)
    return ConversionResult(input=source, status=ConversionStatus.SUCCESS, pages=pages,
        assembled=AssembledUnit(elements=[element for page in pages for element in page.assembled.elements]), document=doc)


def worker_pdf_conversion(texts, picture_pages):
    fragments = {page: text if isinstance(text, list) else [(text, "text")] if text else []
                 for page, text in texts.items()}
    if not USE_DOCLING:
        # Draft CI installs only the PDF renderer wheels. Still run the real CLI
        # and extraction, using its page-local document interface for the input.
        return SimpleNamespace(
            pages=list(texts),
            texts=[SimpleNamespace(text=text, label=label, prov=[SimpleNamespace(page_no=page)])
                   for page, items in fragments.items() for text, label in items],
            pictures=[SimpleNamespace(label="picture", prov=[SimpleNamespace(page_no=page)])
                      for page in texts if page in picture_pages],
        )
    pages = [[text_element(page, text, index, label=label) for index, (text, label) in enumerate(items, 1)]
             for page, items in fragments.items()]
    conversion = result_for(*pages, start_page=next(iter(texts)))
    for page, elements in zip(conversion.pages, pages):
        if elements:
            page.parsed_page = SegmentedPdfPage.model_construct(textline_cells=[
                TextCell.model_construct(text=element.text, from_ocr=False) for element in elements
            ])
        if page.page_no in picture_pages:
            page.predictions.layout = LayoutPrediction(clusters=[cluster(2, DocItemLabel.PICTURE)])
    return conversion


def worker_pdf_cli_fixtures():
    cases = {
        "previous_answer_key": (23, {10: "Answer Key", 11: "", 12: "Public continuation."}, (), [
            (1, 10, None), (11, 20, "section_sealed"), (12, 20, None), (21, 23, None),
        ]),
        "same_segment_answer_key": (23, {12: "Answer Key", 13: "", 14: "1. Find x.", 15: "5 units."}, (1, 14), [
            (1, 10, None), (2, 10, None, False, False, True), (11, 20, None), (14, 20, None),
            (15, 20, "inline_sealed"), (21, 23, None),
        ]),
        "vision_section_exit": (3, {1: "", 2: [("5 units.", "text"), ("Vector Spaces", "section_header"),
                                              ("A vector space has two operations.", "text")], 3: "Public continuation."}, (), [
            (1, 1, None), (2, 2, "section_sealed"), (3, 3, None),
            (1, 2, None), (1, 3, None), (2, 3, "section_sealed"),
        ]),
        "completed_inline": (12, {10: "Model Answer: x = 3.", 11: "2. Calculate y.", 12: "Use the diagram for this exercise."}, (), [
            (1, 10, None), (11, 12, None, False, False, True), (11, 12, "section_sealed"),
        ]),
        "failed_sealed_retry": (11, {10: "", 11: "5 units."}, (), [
            (1, 10, None), (11, 11, None),
        ]),
        "sentence_case_answer": (2, {1: "Exercise 1: Find x.\nModel answer: x = 3.", 2: "Public explanation."}, (2,), [
            (1, 2, None),
        ]),
        "worked_example": (12, {10: "Worked Example 1: Find x.", 11: "Solution: Take the square root.", 12: "Exercise 2: Solve for y."}, (), [
            (1, 10, None), (11, 12, None), (11, 12, None, True),
        ]),
        "vision_worked_example": (10, {9: "", 10: "Solution: Take the square root."}, (), [
            (1, 10, None), (10, 10, None, True),
        ]),
        "exercise_context": (3, {1: "Exercise 1. Solve x - 3 = 0.", 2: "【正确答案】\nx = 3.",
                                 3: "Public prose continues here."}, (), [
            (1, 3, None), (1, 1, None), (2, 2, None, False, True), (3, 3, None, False, True, True),
        ]),
        "vision_exercise": (3, {1: "", 2: "【正确答案】\nx = 3.",
                                3: "Public prose continues here."}, (), [
            (1, 3, None), (2, 3, None, False, True),
        ]),
        "qualified_section_exit": (5, {
            1: "Answer Key",
            2: "Chapter 2: What Is Algebra? — Page 12\n## Figure 2(a), which shows the graph, is useful here.\nx = 3.",
            3: "3.14 千瓦时\n3.14 有实数解\n3.14 在区间内",
            4: "Proof:\n证明：\n5 units.",
            5: "What Is Algebra? — Page 12\n定理 2.1（拉格朗日定理）\nPublic explanation.",
        }, (), [(1, 5, None), (1, 1, None), (2, 2, "section_sealed"), (3, 3, "section_sealed"),
                (4, 4, "section_sealed"), (5, 5, "section_sealed")]),
        "nested_answer_proof": (3, {
            1: "Problem 1. Prove the identity.\nSolution. We use induction.\n\nProof. Base Cases: private.",
            2: "Inductive Step: private.\n\nThe conclusion is private. \\Box",
            3: "Problem 2. Find the root.",
        }, (), [(1, 3, None), (1, 1, None), (2, 2, "inline_proof_sealed", False, True),
                (3, 3, None, False, True)]),
        "cross_page_numbered_question": (4, {
            1: "Example 1: Cyclic groups\nSolution: An example.\n1. Is every cyclic group abelian?",
            2: "Page 2 of 4\nsOlUtIoN:\nYes.",
            3: "Proof. Private continuation. ∎",
            4: "Public prose after the proof.",
        }, (), [(1, 4, None), (1, 1, None), (2, 2, None, True, False, False, True),
                (3, 3, None, False, False, True), (4, 4, None)]),
        "adjacent_answer_proof": (4, {
            1: "Problem 1. Prove the identity.\nSolution. The answer is 3.",
            2: [("Course notes", "page_header"), ("Page 2 of 4\nProof. Private continuation.", "text")],
            3: "The private equality follows. ∎",
            4: "Problem 2. Find the root.",
        }, (), [(1, 4, None), (1, 1, None), (2, 2, None, False, True, True),
                 (3, 3, "inline_proof_sealed", False, True), (4, 4, None, False, True)]),
        "ambiguous_answer_counters": (6, {
            1: "Answer:\n1\nDone.",
            2: "Answer:\n2\nDone.",
            3: [("Answer:\n1\nDone.\nPage 3", "text"), ("23", "page_footer")],
            4: "Answer:\n(1)\nDone.\n[Readable OCR]",
            5: "Answer:\n1/2\nDone.",
            6: "Answer:\nDone.\n- 3 -",
        }, (), [(1, 6, None)]),
    }
    for name, answer in (("native_answer_boundary", "Answer: No."),
                         ("numeric_native_answer_boundary", "Answer:\n1\nDone."),
                         ("operator_native_answer_boundary", "Answer: 2**3."),
                         ("underscore_native_answer_boundary", "Answer: x__1 + y__2."),
                         ("adjacent_bold_native_answer_boundary", "**Model** **Answer**: No."),
                         ("adjacent_bold_operator_answer_boundary", "**Answer:** **2**3.**")):
        cases[name] = (4, {
            1: "1. Find x.\n" + answer,
            2: "The derivation continues",
            3: "The derivation ends. ∎",
            4: "Public prose after the derivation.",
        }, (1,), [(1, 1, None), (2, 2, None), (2, 2, "inline_proof_sealed"),
                  (3, 3, None), (3, 3, "inline_proof_sealed"), (4, 4, None)])
    cases["italic_arithmetic_multipage_proof"] = (4, {
        1: "Answer: No.",
        2: "*Proof. Since 2 * 3 = 6, continue.*",
        3: "The derivation ends. ∎",
        4: "Public prose after the proof.",
    }, (), [(1, 4, None), (1, 1, None), (2, 2, None, False, False, True),
            (3, 3, "inline_proof_sealed"), (4, 4, None)])
    cases["empty_native_answer_auxiliary_proof"] = (2, {
        1: "Problem 1. Find x.\nAnswer:",
        2: "Public prose after the answer.",
    }, (1,), [(1, 2, None), (1, 1, None), (2, 2, None, False, True), (2, 2, "inline_sealed", False, True)])
    for name, proof in (
        ("wrapped_proof_opener", "**Proof. Done. ∎**"),
        ("wrapped_qed", "Proof. Starts.\n**Q.E.D.**"),
        ("heading_qed", "Proof. Starts.\n## Q.E.D. ###"),
        ("underscored_qed", "Proof. Starts.\n__Q.E.D.__"),
        ("italic_proof_opener", "*Proof. Done. ∎*"),
        ("italic_qed", "Proof. Starts.\n*Q.E.D.*"),
        ("single_underscored_qed", "Proof. Starts.\n_Q.E.D._"),
        ("trailing_italic_qed", "Proof. Done. *∎*"),
        ("italic_arithmetic_proof_opener", "*Proof. Since 2 * 3 = 6, done. ∎*"),
        ("italic_arithmetic_qed", "*Proof. Since 2 * 3 = 6. Q.E.D.*"),
    ):
        cases[name] = (2, {
            1: "Answer: No.\n" + proof,
            2: "Public prose after the proof.",
        }, (), [(1, 2, None), (1, 1, None), (2, 2, None), (2, 2, "inline_proof_sealed")])
    fixtures = {}
    with tempfile.TemporaryDirectory() as tmp:
        pdf_path = Path(tmp) / "worker-fixture.pdf"
        pdf_path.write_bytes(b"%PDF-1.4\n")
        for name, (page_count, texts, picture_pages, ranges) in cases.items():
            outputs = {}
            for start, end, seal, *flags in ranges:
                worked_example = bool(flags and flags[0])
                exercise = len(flags) > 1 and flags[1]
                proof_boundary = len(flags) > 2 and flags[2]
                numbered_question = len(flags) > 3 and flags[3]
                conversion = worker_pdf_conversion({page: texts.get(page, "Public page.")
                                                    for page in range(start, end + 1)}, picture_pages)
                argv = ["--input", str(pdf_path), "--mime", "application/pdf", "--max-pages", str(page_count),
                        "--page-start", str(start), "--page-end", str(end)]
                if seal:
                    argv += ["--initial-seal-mode", seal]
                if worked_example:
                    argv += ["--initial-in-worked-example"]
                if exercise:
                    argv += ["--initial-in-exercise"]
                if proof_boundary:
                    argv += ["--initial-inline-proof-boundary"]
                if numbered_question:
                    argv += ["--initial-previous-numbered-question"]
                stdout = io.StringIO()
                with patch.object(cli, "pdf_page_count", return_value=page_count), \
                     patch.object(cli, "convert", return_value=conversion), redirect_stdout(stdout):
                    if cli.main(argv) != 0:
                        raise RuntimeError(f"could not generate {name} fixture for pages {start}-{end}")
                suffix = ("/we" if worked_example else "") + ("/exercise" if exercise else "") + ("/proof-boundary" if proof_boundary else "")
                if numbered_question:
                    suffix += "/numbered-question"
                outputs[f"{start}-{end}/{seal or ''}{suffix}"] = json.loads(stdout.getvalue())
            fixtures[name] = {"pageCount": page_count, "ranges": outputs}
    return fixtures


class PhysicalPagesDoclingTests(unittest.TestCase):
    def test_completed_inline_answer_digest_contains_every_answer_line(self):
        for body in ("x  = 1", "y  = 2", "MMMDCCCLXXXVIII", "MMMDCCCLXXXVII"):
            with self.subTest(body=body):
                conversion = result_for(
                    [text_element(11, f"1. Find x.\n**Answer:**\n{body}\nDone.")],
                    [text_element(12, "Proof. The private derivation. ∎")],
                )
                ext = physical_pages.extract_physical_pages(conversion)
                self.assertEqual(ext.texts_by_page, {11: ["1. Find x."], 12: []})
                self.assertTrue(ext.inline_proof_boundary_by_page[11])
                expected = sha256(f"Answer:\n{' '.join(body.split())}\nDone.".encode("utf-8")).hexdigest()
                self.assertEqual(ext.completed_inline_answer_digest_by_page, {11: expected})

        conversion = result_for(
            [text_element(11, "1. Find x.\nAnswer: x =")],
            [text_element(12, "The answer is two.")],
        )
        ext = physical_pages.extract_physical_pages(conversion)
        self.assertTrue(ext.inline_proof_boundary_by_page[12])
        self.assertEqual(ext.completed_inline_answer_digest_by_page, {})

    def test_cli_digests_distinguish_answer_counters_and_ignore_explicit_furniture(self):
        output = worker_pdf_cli_fixtures()["ambiguous_answer_counters"]["ranges"]["1-6/"]
        answers = ("Answer:\n1\nDone.", "Answer:\n2\nDone.", "Answer:\n1\nDone.",
                   "Answer:\n(1)\nDone.", "Answer:\n1/2\nDone.", "Answer:\nDone.\n- 3 -")
        for page, answer in zip(output["pages"], answers, strict=True):
            with self.subTest(page=page["page"]):
                self.assertTrue(page["inlineProofBoundaryPendingAtEnd"])
                self.assertEqual(page["completedInlineAnswerDigest"], sha256(answer.encode("utf-8")).hexdigest())

    def test_worker_pdf_cli_fixtures_keep_raw_scan_and_report_seal_metadata(self):
        fixtures = worker_pdf_cli_fixtures()
        previous = fixtures["previous_answer_key"]["ranges"]
        self.assertEqual(previous["11-20/section_sealed"]["pages"][0]["visualKinds"], ["scan"])
        self.assertEqual(previous["11-20/section_sealed"]["pages"][1]["text"], "")
        self.assertEqual(previous["12-20/"]["pages"][0]["text"], "Public continuation.")
        same = fixtures["same_segment_answer_key"]["ranges"]
        self.assertEqual(same["11-20/"]["pages"][3]["visualKinds"], [])
        self.assertEqual(same["14-20/"]["pages"][0]["visualKinds"], ["picture"])
        closed = fixtures["completed_inline"]["ranges"]["1-10/"]["pages"][-1]
        self.assertEqual(closed["text"], "")
        self.assertIs(closed["hadSealedContent"], True)
        self.assertIs(closed["inlineSealedAtEnd"], False)
        sentence_case = fixtures["sentence_case_answer"]["ranges"]["1-2/"]["pages"][0]
        self.assertEqual(sentence_case["text"], "Exercise 1: Find x.")
        example = fixtures["worked_example"]["ranges"]
        self.assertIs(example["1-10/"]["pages"][-1]["inWorkedExampleAtEnd"], True)
        self.assertEqual(example["11-12/"]["pages"][0]["text"], "")
        self.assertEqual(example["11-12//we"]["pages"][0]["text"], "Solution: Take the square root.")
        self.assertNotIn("inWorkedExampleAtEnd", example["11-12//we"]["pages"][1])

    def test_container_prefixed_singular_labels_keep_the_next_page_sealed(self):
        for heading in (
            "Appendix A: Model Answer", "APPENDIX A: OFFICIAL SOLUTION",
            "Chapter 3: Reference Solution", "Section 1.2: Sample answer",
            "Lecture 4: Selected answers", "Part II: Correct Answer",
            "Unit 1: Odd-numbered solutions", "附录 A：Model answer",
            "第 3 章：Reference answer: x = 4.",
        ):
            with self.subTest(heading=heading):
                conversion = worker_pdf_conversion(
                    {1: f"{heading}\nx = 4.", 2: "5 units.", 3: "Chapter 5: Vectors"}, (),
                )
                extracted = physical_pages.extract_physical_pages(conversion)
                self.assertTrue(extracted.section_sealed_by_page[1])
                self.assertEqual(extracted.texts_by_page, {1: [], 2: [], 3: ["Chapter 5: Vectors"]})

    def test_unlettered_answer_appendix_starts_a_second_seal(self):
        for heading in ("Appendix: Solutions", "Appendix: Answers", "Appendix Solutions", "Appendix — Answer Key",
                        "Appendix: Selected Answers", "附录：参考答案", "附录：习题解答", "附录 答案", "附录答案"):
            with self.subTest(heading=heading):
                conversion = worker_pdf_conversion(
                    {1: "Answer Key", 2: "Works Cited", 3: heading, 4: "5 units."}, (),
                )
                extracted = physical_pages.extract_physical_pages(conversion)
                self.assertEqual(extracted.texts_by_page, {1: [], 2: ["Works Cited"], 3: [], 4: []})
                self.assertTrue(extracted.section_sealed_by_page[3])
                self.assertTrue(extracted.section_sealed_by_page[4])

    def test_back_matter_can_reopen_after_numbered_answer_headings(self):
        for heading in ("Acknowledgments", "# Acknowledgments", "Afterword", "# Afterword", "Colophon",
                        "# Colophon", "Appendix: Proofs", "Appendix", "附录：符号表", "# 1.2 True Values in Logic"):
            with self.subTest(heading=heading):
                conversion = worker_pdf_conversion({
                    1: "Answer Key",
                    2: "# 1 True\n# 1.2 False.\n# 1.3 A, C",
                    3: heading,
                    4: "Public continuation.",
                }, ())
                extracted = physical_pages.extract_physical_pages(conversion)
                self.assertEqual(extracted.texts_by_page, {1: [], 2: [], 3: [heading], 4: ["Public continuation."]})

    def test_closing_hashes_and_unnumbered_answer_choices(self):
        texts = {
            1: "# Answer Key #",
            2: "# 1.2 True #\n# A, C #\n# B, D.\n# ###",
            3: "5 units.",
            4: "## Works Cited ##",
            5: "## Appendix: Solutions ##",
            6: "5 units.",
            7: "# Algebra, Calculus #",
            8: "Public continuation.",
        }
        extracted = physical_pages.extract_physical_pages(worker_pdf_conversion(texts, ()))
        self.assertEqual(extracted.texts_by_page, {
            page: [text] if page in (4, 7, 8) else [] for page, text in texts.items()
        })

    def test_chinese_answer_heading_vocabulary_seals_continuations(self):
        for title in (
            "参考答案与解析", "参考答案", "标准答案", "正确答案", "课后习题答案",
            "课后练习答案", "课后练习解答", "课后答案", "课后解答", "章节答案",
            "习题答案", "习题解答", "练习题答案", "练习题解答", "练习答案",
            "练习解答", "复习题答案", "复习题解答", "自测题答案", "自测题解答",
            "思考题答案", "部分习题答案", "答案与解析", "参考解答", "详细解答",
        ):
            with self.subTest(title=title):
                texts = {
                    1: f"附录：{title}", 2: "5 units.", 3: "Works Cited",
                    4: f"{title}：x = 3.", 5: "5 units.", 6: "Chapter 2: Rings",
                    7: f"【{title}】x = 3.", 8: "5 units.", 9: "Chapter 3: Fields",
                    10: f"【 {title}（接上页） 】：x = 3.", 11: "5 units.", 12: "Chapter 4: Modules",
                }
                extracted = physical_pages.extract_physical_pages(worker_pdf_conversion(texts, ()))
                self.assertEqual(extracted.texts_by_page, {
                    page: [text] if page in (3, 6, 9, 12) else [] for page, text in texts.items()
                })

    def test_same_line_bare_chinese_answer_stays_inline(self):
        for label in ("【答案】", "【解答】", "答案：", "解答："):
            with self.subTest(label=label):
                texts = {1: f"Exercise 1: Find x.\n{label}x = 3.", 2: "Public continuation."}
                extracted = physical_pages.extract_physical_pages(worker_pdf_conversion(texts, ()))
                self.assertEqual(extracted.texts_by_page, {1: ["Exercise 1: Find x."], 2: [texts[2]]})

    def test_carries_exercise_context_to_a_label_on_the_next_page_until_a_structural_heading(self):
        texts = {
            1: "Exercise 1. Solve x - 3 = 0.", 2: "【正确答案】", 3: "x = 3.",
            4: "Public prose continues here.", 5: "Chapter 2: Rings",
            6: "【正确答案】", 7: "5 units.", 8: "Chapter 3: Fields",
        }
        extracted = physical_pages.extract_physical_pages(worker_pdf_conversion(texts, ()))
        self.assertEqual(extracted.texts_by_page, {page: [text] if page in (1, 4, 5, 8) else []
                                                   for page, text in texts.items()})
        self.assertTrue(extracted.inline_sealed_by_page[2])
        self.assertFalse(extracted.inline_sealed_by_page[3])
        self.assertFalse(extracted.in_exercise_by_page[5])
        self.assertTrue(extracted.section_sealed_by_page[6])

    def test_chinese_explanations_keep_inline_seals_open_through_running_footers(self):
        for heading in ("【解析】", "【详解（续）】", "解析（接上页）", "详解：", "【解答(续)】"):
            with self.subTest(heading=heading):
                stem = "Exercise 1. Solve x - 3 = 0."
                texts = {1: f"{stem}\n{heading}\nIV.", 2: "x = 3.", 3: "Public prose continues here."}
                extracted = physical_pages.extract_physical_pages(worker_pdf_conversion(texts, ()))
                self.assertEqual(extracted.texts_by_page, {1: [stem], 2: [], 3: [texts[3]]})
                self.assertTrue(extracted.inline_sealed_by_page[1])
                self.assertFalse(extracted.inline_sealed_by_page[2])

    def test_container_prefixed_worked_examples_keep_the_solution_public(self):
        for heading in ("Chapter 3: Worked Example", "Section 2.1: Worked Example 2", "Unit 2 Worked Example 3"):
            with self.subTest(heading=heading):
                conversion = worker_pdf_conversion({1: heading, 2: "Solution:\nx = 3."}, ())
                extracted = physical_pages.extract_physical_pages(conversion)
                self.assertIs(extracted.in_worked_example_by_page[1], True)
                self.assertEqual(extracted.texts_by_page[2], ["Solution:\nx = 3."])
                self.assertFalse(extracted.had_sealed_by_page[2])

    def test_converter_keeps_text_regions_without_native_cells_for_visual_routing(self):
        with patch.dict(os.environ, {"PARSER_OCR_MODEL_DIR": ""}), patch("docling.document_converter.DocumentConverter") as converter:
            cli.create_converter()
        options = converter.call_args.kwargs["format_options"][InputFormat.PDF].pipeline_options
        self.assertFalse(options.do_ocr)
        self.assertTrue(options.layout_options.keep_empty_clusters)
        self.assertTrue(options.generate_parsed_pages)

    def test_whole_reading_order_pipeline_merges_document_but_retains_page_assemblies(self):
        result = result_for([text_element(11, "inter-")], [text_element(12, "national")], [])
        before = [page.assembled.model_dump_json() for page in result.pages]
        result.document = ReadingOrderModel(ReadingOrderOptions())(result)
        self.assertEqual([item.text for item in result.document.texts], ["international"])
        self.assertEqual(cli.texts_by_page(result), {11: ["inter-"], 12: ["national"], 13: []})
        self.assertEqual([page.assembled.model_dump_json() for page in result.pages], before)

    def merged_result(self, *parts):
        elements = [text_element(number, text) for number, text in enumerate(parts, 11)]
        result = result_for(*[[element] for element in elements], [])
        first = elements[0]
        item = result.document.add_text(label=DocItemLabel.TEXT, text=first.text,
            prov=ProvenanceItem(page_no=11, charspan=(0, len(first.text)), bbox=first.cluster.bbox))
        model = ReadingOrderModel(ReadingOrderOptions())
        before = [page.assembled.model_dump_json() for page in result.pages]
        for element in elements[1:]:
            model._merge_elements(first, element, item, SIZE.height)
        self.assertEqual([page.assembled.model_dump_json() for page in result.pages], before)
        return result, item

    def test_actual_hard_hyphen_merge_breaks_spans_but_keeps_exact_physical_pages(self):
        result, item = self.merged_result("inter-", "national")
        self.assertEqual(item.orig, "international")
        self.assertEqual([provenance.charspan for provenance in item.prov], [(0, 6), (7, 15)])
        # Explicitly demonstrate why using the old offsets is not a viable fix.
        self.assertNotEqual([item.orig[p.charspan[0]:p.charspan[1]] for p in item.prov], ["inter-", "national"])
        with patch.object(cli, "create_converter", return_value=type("Converter", (), {
                "convert": lambda *_args, **_kwargs: result})()):
            converted = cli.convert(Path("physical-pages.pdf"), 1, (11, 13))
        self.assertIs(converted, result)
        self.assertEqual(cli.texts_by_page(converted), {11: ["inter-"], 12: ["national"], 13: []})

    def test_soft_hyphens_multihop_and_unicode_never_move_between_pages(self):
        for parts in (("co\u00ad", "operate"), ("inter-", "national-", "ization"),
                ("first page", "第二页"), ("first", " page with leading space")):
            with self.subTest(parts=parts):
                result, _ = self.merged_result(*parts)
                expected = {number: [text] for number, text in enumerate(parts, 11)}
                expected[11 + len(parts)] = []
                self.assertEqual(cli.texts_by_page(result), expected)

    def test_page_local_ligature_normalization_is_not_resliced(self):
        normalized = PageAssembleModel(PageAssembleOptions()).sanitize_text(["ﬁrst page"])
        self.assertEqual(normalized, "first page")
        result, _ = self.merged_result(normalized, "第二页")
        self.assertEqual(cli.texts_by_page(result), {11: ["first page"], 12: ["第二页"], 13: []})

    def test_page_local_tables_formula_and_headers_survive_without_full_text_duplication(self):
        table_label = DocItemLabel.TABLE
        table = Table(id=3, label=table_label, page_no=12, cluster=cluster(3, table_label), otsl_seq=[],
            num_rows=2, num_cols=1, table_cells=[
                TableCell(text="variable", row_span=1, col_span=1, start_row_offset_idx=0, end_row_offset_idx=1,
                    start_col_offset_idx=0, end_col_offset_idx=1, column_header=True),
                TableCell(text="page-twelve-only", row_span=1, col_span=1, start_row_offset_idx=1, end_row_offset_idx=2,
                    start_col_offset_idx=0, end_col_offset_idx=1),
            ])
        result = result_for([
            text_element(11, "page-eleven-only"),
            text_element(11, "x² + y² = z²", 2, DocItemLabel.FORMULA),
            text_element(11, "chapter header", 3, DocItemLabel.PAGE_HEADER),
        ], [text_element(12, "table caption", 1, DocItemLabel.CAPTION), table], [])
        output = {number: "\n".join(texts) for number, texts in cli.texts_by_page(result).items()}
        self.assertIn("page-eleven-only", output[11])
        self.assertIn("x² + y² = z²", output[11])
        self.assertIn("chapter header", output[11])
        self.assertNotIn("page-twelve-only", output[11])
        self.assertIn("table caption", output[12])
        self.assertIn("variable", output[12])
        self.assertIn("page-twelve-only", output[12])
        self.assertIn("|", output[12])
        self.assertNotIn("page-eleven-only", output[12])
        self.assertNotIn("x²", output[12])
        self.assertEqual(output[13], "")
        visual = cli.visual_kinds_by_page(result, cli.texts_by_page(result))
        self.assertIn("formula", visual[11])
        self.assertIn("table", visual[12])
        self.assertEqual(visual[13], ["scan"])

    def test_academic_discourse_blocks_preserve_single_page_charspans_and_sealing(self):
        result = result_for(
            [
                text_element(11, "Definition 1.1: A metric space is a pair (X, d).", 1),
                text_element(11, "Theorem 1.2: Every compact set is closed.", 2),
                text_element(11, "Proof: Assume K is compact. Let x be a limit point", 3),
            ],
            [
                text_element(12, "Proof (continued): Then x lies in K. □", 1),
                text_element(12, "Worked Example 1: Evaluate d(0, 1) = 1.", 2),
                text_element(12, "Figure 1: Unit interval diagram", 3, DocItemLabel.CAPTION),
                text_element(12, "Exercise 1: Show d(x, y) >= 0.\nAnswer Key: By non-negativity axiom.", 4),
            ],
            [
                text_element(13, "参考答案\n1. 由非负性可得。\n2. 略。", 1),
            ],
        )
        extracted_default = physical_pages.extract_physical_pages(result, include_sealed=False)
        extracted_raw = physical_pages.extract_physical_pages(result, include_sealed=True)
        blocks_by_page = extracted_default.discourse_blocks_by_page
        raw_blocks_by_page = extracted_raw.discourse_blocks_by_page
        raw_texts = extracted_raw.texts_by_page
        public_texts = cli.texts_by_page(result)

        p11_raw = "\n".join(raw_texts[11])
        p12_raw = "\n".join(raw_texts[12])
        p13_raw = "\n".join(raw_texts[13])

        self.assertEqual([b.kind for b in blocks_by_page[11]], ["definition", "theorem", "proof"])
        self.assertEqual([b.visibility_hint for b in blocks_by_page[11]], ["public", "public", "hint_gated"])
        self.assertFalse(blocks_by_page[11][2].continued_from_prev_page)
        self.assertTrue(blocks_by_page[11][2].continues_on_next_page)

        self.assertEqual([b.kind for b in blocks_by_page[12]], ["proof", "worked_example", "figure_caption", "exercise", "solution_sealed"])
        self.assertTrue(blocks_by_page[12][0].continued_from_prev_page)
        self.assertFalse(blocks_by_page[12][0].continues_on_next_page)
        self.assertEqual(blocks_by_page[12][2].caption_ref, "Figure 1")
        self.assertEqual(blocks_by_page[12][2].associated_visual_kind, "picture")
        self.assertEqual(blocks_by_page[12][3].visibility_hint, "public")
        self.assertEqual(blocks_by_page[12][4].visibility_hint, "sealed")

        self.assertEqual([b.kind for b in blocks_by_page[13]], ["solution_sealed"])
        self.assertEqual(blocks_by_page[13][0].visibility_hint, "sealed")

        for page_no, raw_text in ((11, p11_raw), (12, p12_raw), (13, p13_raw)):
            public_page_text = "\n".join(public_texts[page_no])
            for block in blocks_by_page[page_no]:
                self.assertEqual(block.page_number, page_no)
                if block.visibility_hint == "sealed":
                    self.assertIsNone(block.char_start)
                    self.assertIsNone(block.char_end)
                    self.assertEqual(raw_text[block.raw_char_start:block.raw_char_end], block.text)
                else:
                    self.assertEqual(public_page_text[block.char_start:block.char_end], block.text)
            for block in raw_blocks_by_page[page_no]:
                self.assertEqual(raw_text[block.char_start:block.char_end], block.text)

        # Public texts preserve exercises and public blocks on page 12 while sealing inline & standalone answer keys.
        self.assertIn("Exercise 1: Show d(x, y) >= 0.", "\n".join(public_texts[12]))
        self.assertNotIn("Answer Key", "\n".join(public_texts[12]))
        self.assertNotIn("non-negativity axiom", "\n".join(public_texts[12]))
        self.assertEqual(public_texts[13], [])
        visuals = cli.visual_kinds_by_page(result, public_texts)
        self.assertEqual(visuals[13], [])

    def test_chinese_academic_headings_and_implicit_proof_continuation(self):
        result = result_for(
            [
                text_element(11, "定义 1.1：设 V 为线性空间。", 1),
                text_element(11, "引理 1.2：零向量唯一。", 2),
                text_element(11, "证明：设存在两个零向量 0₁ 与 0₂，则", 3),
            ],
            [
                text_element(12, "0₁ = 0₁ + 0₂ = 0₂。证毕。", 1),
                text_element(12, "例题 2：计算矩阵的秩。", 2),
                text_element(12, "习题 1：证明转置矩阵的秩不变。", 3),
                text_element(12, "解答：利用行秩等于列秩即可。", 4),
            ],
        )
        blocks = physical_pages.discourse_blocks_by_page(result)
        self.assertEqual([b.kind for b in blocks[11]], ["definition", "theorem", "proof"])
        self.assertTrue(blocks[11][2].continues_on_next_page)
        self.assertEqual([b.kind for b in blocks[12]], ["proof", "worked_example", "exercise", "solution_sealed"])
        self.assertTrue(blocks[12][0].continued_from_prev_page)
        self.assertFalse(blocks[12][0].continues_on_next_page)
        public_p12 = "\n".join(cli.texts_by_page(result)[12])
        self.assertIn("习题 1", public_p12)
        self.assertNotIn("行秩等于列秩", public_p12)

    def test_two_tier_sealing_avoids_prose_false_positives_and_blocks_answer_key_breakouts(self):
        result = result_for(
            [
                text_element(11, "Theorem 2.1: If det(A) != 0, then Ax = b has a unique\nsolution. Moreover, x = A^{-1}b.", 1),
                text_element(11, "## Solutions\nA homogeneous mixture of two substances.", 2),
                text_element(11, "Solution-phase synthesis proceeds cleanly.", 3),
                text_element(11, "解析、代数与拓扑是基础课程。", 4),
                text_element(11, "Answer key concepts are summarized here.", 5),
                text_element(11, "Example 1: Compute d/dx(x^2).\nSolution: By the power rule, 2x.\n\nNotice that it vanishes at 0.", 6),
                text_element(11, "例 1：求导。\n解：导数为 2x。", 7),
                text_element(11, "Figure 1: Lookup table for sin(x)", 8, DocItemLabel.CAPTION),
                text_element(11, "Continued fractions converge rapidly.", 9),
            ],
            [
                text_element(12, "Answers to Selected Exercises\n1.1 x = 3\n1.2 y = 4", 1),
            ],
            [
                text_element(13, "Answer Key\nChapter 1\nProblem 1: x = 3", 1),
            ],
            [
                text_element(14, "参考答案\n第一章\n1. x = 3", 1),
            ],
        )
        blocks = physical_pages.discourse_blocks_by_page(result)
        pub = cli.texts_by_page(result)
        p11_pub = "\n".join(pub[11])
        self.assertIn("unique\nsolution. Moreover", p11_pub)
        self.assertIn("homogeneous mixture", p11_pub)
        self.assertIn("Solution-phase synthesis", p11_pub)
        self.assertIn("解析、代数与拓扑", p11_pub)
        self.assertIn("Answer key concepts", p11_pub)
        self.assertIn("By the power rule, 2x.", p11_pub)
        self.assertIn("导数为 2x", p11_pub)
        self.assertIn("Continued fractions", p11_pub)

        caption_block = next(b for b in blocks[11] if b.kind == "figure_caption")
        self.assertEqual(caption_block.associated_visual_kind, "picture")
        self.assertFalse(any(b.kind == "solution_sealed" for b in blocks[11]))
        self.assertFalse(blocks[11][-1].continued_from_prev_page)

        self.assertEqual(pub[12], [])
        self.assertEqual(pub[13], [])
        self.assertEqual(pub[14], [])
        self.assertEqual([b.kind for b in blocks[12]], ["solution_sealed"])
        self.assertEqual([b.kind for b in blocks[13]], ["solution_sealed"])
        self.assertEqual([b.kind for b in blocks[14]], ["solution_sealed"])

    def test_running_answer_header_and_ocr_all_sealed_page_suppress_vision_and_none_text(self):
        result = result_for(
            [
                text_element(11, "Answers to Exercises", 1, DocItemLabel.PAGE_HEADER),
                text_element(11, "1.1 x = 3", 2),
            ],
        )
        pub = cli.texts_by_page(result)
        self.assertEqual(pub[11], [])
        self.assertEqual(cli.visual_kinds_by_page(result, pub)[11], [])

    def test_page_furniture_brackets_body_for_filtered_and_legacy_document_iterators(self):
        document = DoclingDocument(name="page-furniture")
        document.add_page(page_no=1, size=SIZE)

        def add(text, label, layer):
            return document.add_text(
                text=text, label=label, content_layer=layer,
                prov=ProvenanceItem(page_no=1, charspan=(0, len(text)), bbox=cluster(1).bbox),
            )

        body = add("1.1 x = 3", DocItemLabel.TEXT, ContentLayer.BODY)
        footer = add("Page 1", DocItemLabel.PAGE_FOOTER, ContentLayer.FURNITURE)
        header = add("Answers to Exercises", DocItemLabel.PAGE_HEADER, ContentLayer.FURNITURE)
        requested_layers = []

        def iterate_items(included_content_layers=None):
            requested_layers.append(included_content_layers)
            layers = {ContentLayer.BODY} if included_content_layers is None else included_content_layers
            for item in (body, footer, header):
                if item.content_layer in layers:
                    yield item, 1

        for iterate in (iterate_items, lambda: iterate_items()):
            with self.subTest(legacy=iterate is not iterate_items):
                doc = SimpleNamespace(pages=document.pages, texts=document.texts, tables=[], iterate_items=iterate)
                ext = physical_pages.extract_physical_pages(doc)
                self.assertEqual(ext.raw_texts_by_page[1], ["Answers to Exercises", "1.1 x = 3", "Page 1"])
                self.assertEqual(ext.public_texts_by_page[1], [])
        self.assertEqual(requested_layers, [{ContentLayer.BODY, ContentLayer.FURNITURE}, None])

        # Test visual_kinds_by_page resilience to text=None, Table elements, and OCR cells using lightweight doubles
        # (never mutating read-only Pydantic Page.cells or passing text=None into ReadingOrderModel).
        stub_page = SimpleNamespace(
            page_no=11,
            cells=[SimpleNamespace(text="1.1 x = 3", from_ocr=True), SimpleNamespace(text=None, from_ocr=False)],
            assembled=SimpleNamespace(elements=[
                SimpleNamespace(page_no=11, text=None, orig=None, table_cells=[SimpleNamespace(text="1.1 | 3")], label="table", children=[], cluster=None),
            ]),
            parsed_page=SimpleNamespace(bitmap_resources=[]),
            predictions=SimpleNamespace(layout=SimpleNamespace(clusters=[])),
        )
        stub_conv = SimpleNamespace(document=SimpleNamespace(pages=[11]), pages=[stub_page])
        self.assertEqual(cli.visual_kinds_by_page(stub_conv, {11: []})[11], [])

    def test_end_of_chapter_answers_cross_page_worked_example_and_allcaps_markdown_sealing(self):
        result = result_for(
            [
                text_element(11, "Example 1: Compute the integral.", 1),
            ],
            [
                text_element(12, "Solution: Integrate term by term.", 1),
                text_element(12, "例题 1：计算矩阵的秩。\n解答：\n由初等行变换可得。", 2),
                text_element(12, "参考答案\n1. x = 3", 3),
            ],
            [
                text_element(13, "Chapter 2: Vector Spaces", 1, DocItemLabel.SECTION_HEADER),
                text_element(13, "Definition 2.1: A vector space over F.", 2),
                text_element(13, "**ANSWERS TO SELECTED EXERCISES**\n1.1 x = 3", 3),
            ],
            [
                text_element(14, "**课后答案**：1. x = 3\n**练习答案**：2. y = 4", 1),
                text_element(14, "Theorem 2.2: Basis size is invariant.", 2),
            ],
        )
        blocks = physical_pages.discourse_blocks_by_page(result)
        pub = cli.texts_by_page(result)
        self.assertIn("Integrate term by term.", "\n".join(pub[12]))
        self.assertIn("由初等行变换可得。", "\n".join(pub[12]))
        self.assertNotIn("x = 3", "\n".join(pub[12]))
        self.assertEqual(blocks[12][0].kind, "worked_example")
        self.assertEqual(blocks[12][1].kind, "worked_example")

        p13_pub = "\n".join(pub[13])
        self.assertIn("Chapter 2: Vector Spaces", p13_pub)
        self.assertIn("Definition 2.1: A vector space over F.", p13_pub)
        self.assertNotIn("ANSWERS TO SELECTED EXERCISES", p13_pub)
        self.assertNotIn("1.1 x = 3", p13_pub)

        p14_pub = "\n".join(pub[14])
        self.assertNotIn("课后答案", p14_pub)
        self.assertNotIn("练习答案", p14_pub)
        self.assertIn("Theorem 2.2: Basis size is invariant.", p14_pub)

    def test_astral_math_charspans_align_exactly_with_public_texts(self):
        result = result_for([
            text_element(11, "Exercise 1: Compute 𝑥² + 1.\nAnswer Key: 𝑥 = 2.", 1),
            text_element(11, "Theorem 1: Let 𝑥 ∈ ℝ.", 2),
        ])
        ext = physical_pages.extract_physical_pages(result, include_sealed=False)
        public_p11 = "\n".join(ext.texts_by_page[11])
        self.assertEqual(public_p11, "Exercise 1: Compute 𝑥² + 1.\nTheorem 1: Let 𝑥 ∈ ℝ.")
        blocks = ext.discourse_blocks_by_page[11]
        self.assertEqual([b.kind for b in blocks], ["exercise", "solution_sealed", "theorem"])
        for block in blocks:
            if block.visibility_hint == "sealed":
                self.assertIsNone(block.char_start)
                self.assertIsNone(block.char_end)
            else:
                self.assertEqual(public_p11[block.char_start:block.char_end], block.text)

    def test_round4_same_page_bibliography_exit_section_header_cross_page_exit_and_aligned_headers(self):
        result = result_for(
            [
                text_element(11, "Appendix A: Answers to the Exercises\n1.1 x = 3", 1),
                text_element(11, "Bibliography", 2),
                text_element(11, "[1] Knuth, TAOCP.", 3),
                text_element(11, "ANSWERS TO THE EXERCISES (CONTINUED)\n2.1 y = 4", 4),
            ],
            [
                text_element(12, "Vector Spaces", 1, DocItemLabel.SECTION_HEADER),
                text_element(12, "The equation has a unique\nsolution\nfor all x > 0.", 2),
                text_element(12, "**Solution**\nx = 9.", 3),
                text_element(12, "## Solutions\nA homogeneous mixture.", 4),
            ],
            [
                text_element(13, "课后练习答案\n1. 对", 1),
            ],
            [
                text_element(14, "Partial Differential Equations", 1, DocItemLabel.TITLE),
                text_element(14, "Wave equation u_tt = c^2 u_xx.", 2),
            ],
        )
        blocks = physical_pages.discourse_blocks_by_page(result)
        pub = cli.texts_by_page(result)
        p11_pub = "\n".join(pub[11])
        self.assertIn("Bibliography", p11_pub)
        self.assertIn("[1] Knuth, TAOCP.", p11_pub)
        self.assertNotIn("1.1 x = 3", p11_pub)
        self.assertNotIn("2.1 y = 4", p11_pub)
        self.assertEqual([b.kind for b in blocks[11]], ["solution_sealed", "narrative", "solution_sealed"])

        p12_pub = "\n".join(pub[12])
        self.assertIn("Vector Spaces", p12_pub)
        self.assertIn("for all x > 0.", p12_pub)
        self.assertNotIn("x = 9.", p12_pub)
        self.assertIn("A homogeneous mixture.", p12_pub)

        self.assertEqual(pub[13], [])
        p14_pub = "\n".join(pub[14])
        self.assertIn("Partial Differential Equations", p14_pub)
        self.assertIn("Wave equation u_tt = c^2 u_xx.", p14_pub)

    def test_round5_mid_page_continuation_backmatter_split_and_short_numbered_answer_guard(self):
        result = result_for(
            [
                text_element(11, "Appendix A: Answers to the Exercises\n1.1 x = 3", 1),
            ],
            [
                text_element(12, "1.2 y = 4", 1),
                text_element(12, "Bibliography", 2),
                text_element(12, "[1] Knuth, TAOCP.", 3),
            ],
            [
                text_element(13, "参考文献", 1),
                text_element(13, "华罗庚《高等数学引论》。", 2),
            ],
            [
                text_element(14, "Answer Key\n1.1 A", 1),
            ],
            [
                text_element(15, "1.2 True", 1, DocItemLabel.SECTION_HEADER),
                text_element(15, "1.3 A, B", 2, DocItemLabel.SECTION_HEADER),
                text_element(15, "附录 B：符号表", 3),
                text_element(15, "R denotes real numbers.", 4),
            ],
        )
        blocks = physical_pages.discourse_blocks_by_page(result)
        pub = cli.texts_by_page(result)

        self.assertEqual(pub[12], ["Bibliography", "[1] Knuth, TAOCP."])
        self.assertEqual([b.kind for b in blocks[12]], ["solution_sealed", "narrative"])

        self.assertEqual(pub[13], ["参考文献", "华罗庚《高等数学引论》。"])
        self.assertEqual(pub[15], ["附录 B：符号表", "R denotes real numbers."])

    def test_round6_section_sealed_at_end_cli_and_lecture_heading(self):
        import io
        import json
        import tempfile
        from contextlib import redirect_stdout

        result = result_for(
            [
                text_element(11, "Theorem 1: All norms on R^n are equivalent.", 1),
                text_element(11, "Answer Key\n1. x = 2", 2),
            ],
            [
                text_element(12, "第 3 讲 特征值\n特征多项式定义如下。", 1),
            ],
            [
                text_element(13, "**Solutions to Selected Exercises**\n1. x = 5", 1),
            ],
            [
                text_element(14, "Section 1.2: Exercises\n1. Find x.", 1),
                text_element(14, "Bibliography\n[1] Strang.", 2),
            ],
        )
        ext = physical_pages.extract_physical_pages(result)
        self.assertEqual(ext.texts_by_page[11], ["Theorem 1: All norms on R^n are equivalent."])
        self.assertTrue(ext.section_sealed_by_page[11])
        self.assertFalse(ext.section_sealed_by_page[12])
        self.assertIn("特征多项式定义如下。", "\n".join(ext.texts_by_page[12]))
        self.assertTrue(ext.section_sealed_by_page[13])
        self.assertNotIn("Exercises", "\n".join(ext.texts_by_page[14]))
        self.assertIn("Bibliography", "\n".join(ext.texts_by_page[14]))
        self.assertFalse(ext.section_sealed_by_page[14])

        cli_result = result_for(
            [
                text_element(11, "Theorem 1.", 1),
                text_element(11, "Answer Key\n1. x = 2", 2),
            ],
            [
                text_element(12, "第 3 讲 特征值\n特征多项式定义如下。", 1),
            ],
        )
        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "sample.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")
            stdout = io.StringIO()
            with patch.object(cli, "convert", return_value=cli_result), patch.object(cli, "create_converter", return_value=None), redirect_stdout(stdout):
                code = cli.main(["--input", str(pdf_path), "--mime", "application/pdf", "--max-pages", "20"])
        self.assertEqual(code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(len(payload["pages"]), 2)
        self.assertEqual(payload["pages"][0]["text"], "Theorem 1.")
        self.assertIs(payload["pages"][0].get("sectionSealedAtEnd"), True)
        self.assertNotIn("sectionSealedAtEnd", payload["pages"][1])

    def test_segment_cli_restores_unfinished_inline_and_section_seals(self):
        import io
        import json
        import tempfile
        from contextlib import redirect_stdout

        for mode, opener, continuation, flag in (
            ("inline_sealed", "Answer: x =", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "Answer:", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "ANSWER:", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "Correct Answer:", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "Official Answer:", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "Model Answer:", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "Solution:", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "答案：", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "解答：", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "【正确答案】", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "参考答案：x =", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "【答案】", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "Answer:\n\n", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "Solution (continued)", "5 units.", "inlineSealedAtEnd"),
            ("section_sealed", "Answer Key\n1. x =", "5 units.", "sectionSealedAtEnd"),
        ):
            with self.subTest(mode=mode, opener=opener), tempfile.TemporaryDirectory() as tmp:
                leading = [[text_element(page, "Public page.")] for page in range(1, 10)]
                page10 = [text_element(10, "Exercise 1: Find x.\n" + opener)]
                page11 = [text_element(11, continuation)]
                page12 = [text_element(12, "## 第 2 单元 向量空间\nPublic chapter.")]
                book = result_for(*leading, page10, page11, page12, start_page=1)
                self.assertEqual(physical_pages.extract_physical_pages(book).texts_by_page[11], [])
                first = result_for(*leading, page10, start_page=1)
                second = result_for(page11, page12, start_page=11)
                pdf_path = Path(tmp) / "sample.pdf"
                pdf_path.write_bytes(b"%PDF-1.4\n")
                common = ["--input", str(pdf_path), "--mime", "application/pdf", "--max-pages", "12"]
                with patch.object(cli, "pdf_page_count", return_value=12), patch.object(cli, "convert", side_effect=[first, second]):
                    first_output = io.StringIO()
                    with redirect_stdout(first_output):
                        self.assertEqual(cli.main(common + ["--page-start", "1", "--page-end", "10"]), 0)
                    page = json.loads(first_output.getvalue())["pages"][-1]
                    self.assertEqual(page["page"], 10)
                    self.assertEqual(page["text"], "Exercise 1: Find x.")
                    self.assertIs(page.get(flag), True)
                    second_output = io.StringIO()
                    with redirect_stdout(second_output):
                        self.assertEqual(cli.main(common + ["--page-start", "11", "--page-end", "12", "--initial-seal-mode", mode]), 0)
                    pages = json.loads(second_output.getvalue())["pages"]
                    self.assertEqual(pages[0]["text"], "")
                    self.assertEqual(pages[0]["visualKinds"], [])
                    self.assertIs(pages[0].get("hadSealedContent"), True)
                    self.assertEqual(bool(pages[0].get(flag)), mode == "section_sealed")
                    self.assertIn("Public chapter.", pages[1]["text"])

    def test_chinese_answer_section_spans_blank_lines_and_pages(self):
        for title in ("【参考答案】", "【标准答案】", "【习题答案】", "【课后答案】", "参考答案", "标准答案", "答案："):
            with self.subTest(title=title):
                result = result_for(
                    [text_element(9, "Public introduction.")],
                    [text_element(10, title + "\n1. x = 3.\n\n2. y = 4.")],
                    [text_element(11, "5 units.\nChapter 2: Vectors")],
                    start_page=9,
                )
                ext = physical_pages.extract_physical_pages(result)
                self.assertEqual(ext.texts_by_page[10], [])
                self.assertTrue(ext.section_sealed_by_page[10])
                self.assertFalse(ext.inline_sealed_by_page[10])
                self.assertEqual(ext.texts_by_page[11], ["Chapter 2: Vectors"])

    def test_pptx_cli_preserves_seal_metadata_for_empty_slides(self):
        import io
        import json
        import tempfile
        from contextlib import redirect_stdout

        for text, sealed in (("Answer Key\n1.1 x = 3", True), ("", False)):
            with self.subTest(text=text), tempfile.TemporaryDirectory() as tmp:
                slide = Path(tmp) / "sample.pptx"
                slide.touch()
                doc = DoclingDocument(name="slides")
                doc.add_page(page_no=1, size=SIZE)
                if text:
                    doc.add_text(label=DocItemLabel.TEXT, text=text, prov=ProvenanceItem(
                        page_no=1, bbox=cluster(1).bbox, charspan=(0, len(text)),
                    ))
                source = InputDocument.model_construct(file=slide, format=InputFormat.PPTX, document_hash="0" * 64)
                result = ConversionResult(input=source, status=ConversionStatus.SUCCESS, pages=[], document=doc)
                stdout = io.StringIO()
                with patch.object(cli, "convert", return_value=result), redirect_stdout(stdout):
                    self.assertEqual(cli.main(["--input", str(slide), "--mime", cli.PPTX, "--max-pages", "1"]), 0)
                page = json.loads(stdout.getvalue())["pages"][0]
                self.assertEqual(page["text"], "")
                self.assertEqual(page["visualKinds"], [])
                self.assertEqual(page.get("hadSealedContent", False), sealed)
                self.assertEqual(page.get("sectionSealedAtEnd", False), sealed)

    def test_completed_inline_answer_releases_next_page_but_label_before_blank_does_not(self):
        result = result_for(
            [text_element(10, "Exercise 1: Find x.\nAnswer:\n\n5 units.\n")],
            [text_element(11, "Public explanation.")],
            start_page=10,
        )
        extracted = physical_pages.extract_physical_pages(result)
        self.assertEqual(extracted.texts_by_page[10], ["Exercise 1: Find x."])
        self.assertEqual(extracted.texts_by_page[11], ["Public explanation."])

    def test_singular_model_answer_with_body_uses_an_inline_seal(self):
        for label in ("Model Answer:", "MODEL ANSWER 1.2 (CONTD.):", "Model answer:", "Official answer：",
                      "Correct answer:", "Sample answer：", "Reference answer:", "Answer key:"):
            for closed in (True, False):
                with self.subTest(label=label, closed=closed):
                    answer = label + (" x = 3." if closed else " x =")
                    result = result_for(
                        [text_element(10, "Exercise 1: Find x.\n" + answer)],
                        [text_element(11, "Public explanation." if closed else "5 units.")],
                        [text_element(12, "Public example.")],
                        start_page=10,
                    )
                    ext = physical_pages.extract_physical_pages(result)
                    self.assertEqual(ext.texts_by_page[10], ["Exercise 1: Find x."])
                    self.assertEqual(ext.sealed_texts_by_page[10], [answer])
                    self.assertFalse(ext.section_sealed_by_page[10])
                    self.assertEqual(ext.inline_sealed_by_page[10], not closed)
                    self.assertEqual(ext.texts_by_page[11], ["Public explanation."] if closed else [])
                    self.assertEqual(ext.texts_by_page[12], ["Public example."])

    def test_model_answer_section_headings_still_seal_the_following_page(self):
        for title in ("Model answers", "Model Answers:", "Selected answers", "Official solutions",
                      "Reference solutions", "Answer key", "Solutions manual", "Answers to Exercises 1–5",
                      "**Solu**tions to Problems 1.1—1.8", "Answers\u00a0to Review Questions #1 through #5",
                      "Answers to exercises 1–5", "Solutions to problems 1–10", "Answers to selected review questions",
                      "Key to the exercises", "Chapter 3: answers to exercises", "Answer key (CoNt.)"):
            with self.subTest(title=title):
                result = result_for(
                    [text_element(10, "Exercise 1: Find x.\n" + title + "\n1. x = 3.")],
                    [text_element(11, "2. y = 4.")],
                    [text_element(12, "Chapter 2: Vectors")],
                    start_page=10,
                )
                ext = physical_pages.extract_physical_pages(result)
                self.assertEqual(ext.texts_by_page[10], ["Exercise 1: Find x."])
                self.assertTrue(ext.section_sealed_by_page[10])
                self.assertEqual(ext.texts_by_page[11], [])
                self.assertEqual(ext.texts_by_page[12], ["Chapter 2: Vectors"])

    def test_assessment_prose_does_not_open_a_seal(self):
        for text in ("Answers to exercises are omitted in this edition.",
                     "Answers to review questions appear on the course website.",
                     "Solutions to problems require careful units."):
            with self.subTest(text=text):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(10, text)], [text_element(11, "Public continuation.")], start_page=10,
                ))
                self.assertEqual(ext.texts_by_page[10], [text])
                self.assertFalse(ext.section_sealed_by_page[10])
                self.assertEqual(ext.texts_by_page[11], ["Public continuation."])

    def test_qualified_inline_answers_and_solution_headings(self):
        for label in ("Sample solution:", "Model answer", "Model Answer", "MODEL ANSWER", "Reference answer",
                      "Official answer", "Correct answer", "Sample answer", "Sample solution", "Worked solution",
                      "Full solution", "Reference solution", "Official solution", "Solution"):
            with self.subTest(label=label):
                opener = "Worked Example 1: Find x." if "answer" in label.lower() else "Exercise 1: Find x."
                separator = " " if label.endswith(":") else "\n"
                example = "Worked Example 2: Simplify y.\nSample solution\ny = 7."
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(10, f"{opener}\n{label}{separator}x = 4.")], [text_element(11, example)], start_page=10,
                ))
                self.assertEqual(ext.texts_by_page[10], [opener])
                self.assertFalse(ext.section_sealed_by_page[10])
                self.assertFalse(ext.inline_sealed_by_page[10])
                self.assertEqual(ext.texts_by_page[11], [example])

    def test_qualified_answer_keys_seal_after_worked_examples(self):
        for label in ("Official Solution 1. Yes.", "Reference Solution 1:", "Model Solution: Yes.",
                      "Selected Solutions.", "Correct Solution. Yes.", "Odd-Numbered Solutions 1:",
                      "EVEN-NUMBERED SOLUTION: Yes."):
            with self.subTest(label=label):
                example = "Example 1: Quadratic Equations\nSample solution: A derivation."
                proof = "Proof. Private continuation. ∎"
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(1, f"{example}\n{label}")], [text_element(2, proof)],
                    [text_element(3, "Public prose after the proof.")], start_page=1,
                ))
                self.assertEqual(ext.texts_by_page[1], [example])
                self.assertEqual(ext.sealed_texts_by_page[1], [label])
                self.assertFalse(ext.in_worked_example_by_page[1])
                self.assertEqual(ext.texts_by_page[2], [])
                self.assertEqual(ext.sealed_texts_by_page[2], [proof])
                self.assertEqual(ext.texts_by_page[3], ["Public prose after the proof."])

    def test_qualified_plural_solution_section_stays_sealed_after_worked_example(self):
        example = "Example 1: Quadratic Equations\nSample solution: A derivation."
        proof = "Proof. Private continuation. ∎"
        public_chapter = "Chapter 2: Geometry"
        for label in ("Official Solutions", "Reference Solutions:", "Model Solutions"):
            with self.subTest(label=label):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(1, f"{example}\n{label}\n1. x = 3.")],
                    [text_element(2, "2. y = 4.")], [text_element(3, proof)],
                    [text_element(4, public_chapter)], start_page=1,
                ))
                self.assertTrue(ext.section_sealed_by_page[1])
                self.assertEqual(ext.texts_by_page, {1: [example], 2: [], 3: [], 4: [public_chapter]})
                self.assertEqual(ext.sealed_texts_by_page[2], ["2. y = 4."])
                self.assertEqual(ext.sealed_texts_by_page[3], [proof])

    def test_qualified_singular_solution_closes_after_completed_inline_answer(self):
        example = "Example 1: Quadratic Equations"
        prose = "Public prose after the answer."
        for label in ("Official Solution 1.", "Reference Solution:"):
            with self.subTest(label=label):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(1, f"{example}\n{label}\nx = 3.")], [text_element(2, prose)], start_page=1,
                ))
                self.assertFalse(ext.section_sealed_by_page[1])
                self.assertEqual(ext.texts_by_page, {1: [example], 2: [prose]})
                self.assertEqual(ext.sealed_texts_by_page[1], [f"{label}\nx = 3."])

    def test_numbered_question_overrides_worked_example_from_previous_page(self):
        example = "Example 1: Cyclic groups\nSolution: This group is abelian."
        stem = "1. Decide whether every cyclic group is abelian."
        proof = "Proof. Private continuation. ∎"
        prose = "Public prose after the proof."
        for label in ("解答：", "Solution:"):
            with self.subTest(label=label):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(1, example)], [text_element(2, f"{stem}\n{label}\nYes.")],
                    [text_element(3, proof)], [text_element(4, prose)], start_page=1,
                ))
                self.assertEqual(ext.texts_by_page, {1: [example], 2: [stem], 3: [], 4: [prose]})
                self.assertEqual(ext.sealed_texts_by_page[2], [f"{label}\nYes."])
                self.assertEqual(ext.sealed_texts_by_page[3], [proof])

    def test_numbered_question_at_page_end_seals_next_page_answer_and_proof(self):
        question = "Example 1: Cyclic groups\nSolution: An example.\n1. Is every cyclic group abelian?"
        proof = "Proof. Private continuation. ∎"
        prose = "Public prose after the proof."
        for label in ("解答：", "Solution:", "sOlUtIoN:"):
            with self.subTest(label=label):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(1, question)], [text_element(2, f"Page 2 of 4\n{label}\nYes.")],
                    [text_element(3, proof)], [text_element(4, prose)], start_page=1,
                ))
                self.assertTrue(ext.previous_numbered_question_by_page[1])
                self.assertFalse(ext.previous_numbered_question_by_page[2])
                self.assertIn(f"{label}\nYes.", "\n".join(ext.sealed_texts_by_page[2]))
                self.assertEqual(ext.sealed_texts_by_page[3], [proof])
                self.assertEqual(ext.texts_by_page[4], [prose])

    def test_heading_free_numbered_question_with_chinese_solution_seals_only_answer_and_proof(self):
        stem = "1. Decide whether every cyclic group is abelian."
        public = ["Introduction to cyclic groups.", "Public prose after the proof.",
                  "## Solutions\nA homogeneous mixture.", "Solutions\nSolutes dissolve in solvents."]
        pages = [public[0], f"{stem}\n解答：\nYes.", "证明。\nThe proof concludes. ∎", *public[1:]]
        ext = physical_pages.extract_physical_pages(result_for(*(
            [text_element(page, content)] for page, content in enumerate(pages, 1)
        ), start_page=1))
        self.assertEqual(ext.texts_by_page, {1: [public[0]], 2: [stem], 3: [],
                                             4: [public[1]], 5: [public[2]], 6: [public[3]]})
        self.assertEqual(ext.sealed_texts_by_page[2], ["解答：\nYes."])
        self.assertEqual(ext.sealed_texts_by_page[3], [pages[2]])

    def test_repeated_chinese_answer_labels_in_the_same_exercise_stay_inline(self):
        for label in ("答案：", "解答："):
            with self.subTest(label=label):
                result = result_for(
                    [text_element(10, f"练习\n（1）计算 x。\n{label}\n3.\n\n（2）计算 y。\n{label}\n4.")],
                    [text_element(11, "Public explanation.")],
                    start_page=10,
                )
                ext = physical_pages.extract_physical_pages(result)
                public_lines = [line for line in "\n".join(ext.texts_by_page[10]).splitlines() if line.strip()]
                self.assertEqual(public_lines, ["练习", "（1）计算 x。", "（2）计算 y。"])
                self.assertEqual(ext.sealed_texts_by_page[10], [label + "\n3.", label + "\n4."])
                self.assertFalse(ext.section_sealed_by_page[10])
                self.assertFalse(ext.inline_sealed_by_page[10])
                self.assertEqual(ext.texts_by_page[11], ["Public explanation."])

    def test_footer_only_bitmap_needs_scan_verification(self):
        for footer in ("123", "Chapter 1 (page 2 of 3)", "[illegible]"):
            with self.subTest(footer=footer):
                conversion = worker_pdf_conversion({11: footer, 12: "Public geometry notes."}, (11, 12))
                kinds = physical_pages.extract_physical_pages(conversion).visual_kinds_by_page
                self.assertEqual(kinds[11], ["scan", "picture"])
                self.assertEqual(kinds[12], ["picture"])

    def test_scan_without_native_text_keeps_visuals_and_inherited_section_seal(self):
        result = result_for(
            [],
            [text_element(12, "3. z = 5")],
        )
        ext = physical_pages.extract_physical_pages(result, initial_seal_mode="section_sealed")
        self.assertEqual(ext.texts_by_page[11], [])
        self.assertEqual(ext.visual_kinds_by_page[11], ["scan"])
        self.assertTrue(ext.section_sealed_by_page[11])
        self.assertFalse(ext.had_sealed_by_page[11])
        self.assertEqual(ext.texts_by_page[12], [])
        self.assertEqual(ext.visual_kinds_by_page[12], [])
        self.assertTrue(ext.had_sealed_by_page[12])

    def test_assignment_and_bare_multichar_container_titles_keep_answers_sealed(self):
        for title in (
            "Lecture 4: Homework", "Lecture 4: Assignments", "Lecture 4: Lab",
            "第 3 讲 作业题", "第 3 部分", "第 2 单元", "第 2 单元：阶段练习",
        ):
            with self.subTest(title=title):
                result = result_for([text_element(
                    11, f"Lecture 4: Solutions\n## {title}\n1. x = 5\n## 第 4 部分 向量空间\n定义：向量空间。",
                )])
                public = physical_pages.extract_physical_pages(result).texts_by_page[11]
                self.assertEqual(public, ["## 第 4 部分 向量空间\n定义：向量空间。"])

    def test_running_header_fragments_cannot_end_a_sealed_section(self):
        for header in ("Page 1 of 3", "# Page 1/3", "OCR text for page 1", "Chapter 1 (continued)", "Section 2",
                       "Chapter 1 (page 2 of 3)", "Chapter 1 (p. 4)", "Chapter 1 (第 2 页)", "# 123", "XVII", "[illegible]"):
            with self.subTest(header=header):
                conversion = result_for([
                    text_element(11, "Answer Key", 1),
                    text_element(11, header, 2, label="section_header"),
                    text_element(11, "x = 3.", 3),
                ], [text_element(12, "Chapter 2: Vectors", 1, label="section_header")])
                extracted = physical_pages.extract_physical_pages(conversion)
                self.assertEqual(extracted.texts_by_page[11], [])
                self.assertTrue(extracted.section_sealed_by_page[11])
                self.assertEqual(extracted.texts_by_page[12], ["Chapter 2: Vectors"])
                self.assertFalse(extracted.section_sealed_by_page[12])

    def test_numeric_heading_does_not_end_inherited_inline_seal(self):
        conversion = result_for([
            text_element(11, "# 123", 1, label="section_header"),
            text_element(11, "5 units.", 2),
        ])
        extracted = physical_pages.extract_physical_pages(conversion, initial_seal_mode="inline_sealed")
        self.assertEqual(extracted.texts_by_page[11], [])

    def test_round7_caption_inside_seal_lecture_answer_guard_and_had_sealed(self):
        import io
        import json
        import tempfile
        from contextlib import redirect_stdout

        result = result_for(
            [
                text_element(11, "Answer Key\n1. x = 2", 1),
                text_element(11, "Figure 1: Solution graph.", 2, DocItemLabel.CAPTION),
                text_element(11, "2. y = 4", 3),
            ],
            [
                text_element(12, "第 3 讲 参考答案\n1. 对", 1, DocItemLabel.SECTION_HEADER),
                text_element(12, "2. 错", 2),
            ],
            [
                text_element(13, "第 3 讲 特征值\n定义：Ax = λx。", 1, DocItemLabel.SECTION_HEADER),
            ],
            [
                text_element(14, "Theorem 1: Norm equivalence.", 1),
                text_element(14, "Answer: x = 1.", 2),
                text_element(14, "Chapter 2: Next Topic\nPublic proof.", 3),
            ],
            [
                text_element(15, "Chapter 3: Pure Public\nTheorem 2: Continuity.", 1),
            ],
        )
        ext = physical_pages.extract_physical_pages(result)
        self.assertEqual(ext.texts_by_page[11], [])
        self.assertTrue(ext.section_sealed_by_page[11])
        self.assertTrue(ext.had_sealed_by_page[11])

        self.assertEqual(ext.texts_by_page[12], [])
        self.assertTrue(ext.section_sealed_by_page[12])
        self.assertTrue(ext.had_sealed_by_page[12])

        self.assertFalse(ext.section_sealed_by_page[13])
        self.assertFalse(ext.had_sealed_by_page[13])
        self.assertIn("定义：Ax = λx。", "\n".join(ext.texts_by_page[13]))

        self.assertNotIn("Answer", "\n".join(ext.texts_by_page[14]))
        self.assertIn("Theorem 1: Norm equivalence.", "\n".join(ext.texts_by_page[14]))
        self.assertFalse(ext.section_sealed_by_page[14])
        self.assertTrue(ext.had_sealed_by_page[14])

        self.assertFalse(ext.section_sealed_by_page[15])
        self.assertFalse(ext.had_sealed_by_page[15])

        with tempfile.TemporaryDirectory() as tmp:
            pdf_path = Path(tmp) / "sample-r7.pdf"
            pdf_path.write_bytes(b"%PDF-1.4\n")
            stdout = io.StringIO()
            with patch.object(cli, "convert", return_value=result), patch.object(cli, "create_converter", return_value=None), redirect_stdout(stdout):
                code = cli.main(["--input", str(pdf_path), "--mime", "application/pdf", "--max-pages", "20"])
        self.assertEqual(code, 0)
        payload = json.loads(stdout.getvalue())
        self.assertEqual(len(payload["pages"]), 5)
        self.assertIs(payload["pages"][0].get("sectionSealedAtEnd"), True)
        self.assertIs(payload["pages"][0].get("hadSealedContent"), True)
        self.assertIs(payload["pages"][1].get("sectionSealedAtEnd"), True)
        self.assertIs(payload["pages"][1].get("hadSealedContent"), True)
        self.assertNotIn("sectionSealedAtEnd", payload["pages"][2])
        self.assertNotIn("hadSealedContent", payload["pages"][2])
        self.assertNotIn("sectionSealedAtEnd", payload["pages"][3])
        self.assertIs(payload["pages"][3].get("hadSealedContent"), True)
        self.assertNotIn("sectionSealedAtEnd", payload["pages"][4])
        self.assertNotIn("hadSealedContent", payload["pages"][4])

    def test_pending_exercise_answer_ignores_caption_labels_and_prose_references(self):
        for line in (
            "Figure:", "# Table:", "Table 1 gives the factorization.", "Theorem 2.1 states this fact.",
            "Lemma 1.2 implies x = 3.", "Definition 3.1 requires a field.", "Figure 2 illustrates the construction.",
            "**Theorem 2.1** states this fact.", "**Theorem 2.1 states this fact.**", "__Table 1__ gives the factorization.",
            "Chapter 2 explains why this equation holds.", "Section 2.1 shows the derivation.", "Appendix A gives the factorization.",
            "表 1 给出了分解结果。", "图 2 显示了图像", "第 2 章解释了原因。", "定理 2.1 说明了该事实。", "引理 1 给出了条件",
            "图 2（a）显示了函数图像。", "图 2(a) 显示了函数图像。", "表 3（1）列出了数据。",
            "Figure 2(a) shows the graph.", "Table 3 (b) lists the values.", "Theorem 2.1 (Lagrange) states that G is finite.",
            "Figure 2 a: shows the graph.", "Example 1 (Lagrange) gives the construction.",
            "Figure 2(a), which shows the graph, is useful here.", "Theorem 2.1 (Lagrange), applied to G, gives the result.",
            "定理 2.1（拉格朗日），应用于 G，可得结果。", "Figure 2(a):, which shows the graph.",
            "Theorem 2.1: This gives the result.",
            "3.14 is the desired approximation.", "3.14 Euler's constant is irrational.", "2.718 = e", "3.14 是所需近似值。",
            "3.14 V", "3.14 厘米", "3.14 kPa", "3.14 kg/m^3", "3.14 Mmol", "3.14 平方公里/秒", "3.14 有三个解",
        ):
            for label in (DocItemLabel.TEXT, DocItemLabel.SECTION_HEADER):
                with self.subTest(line=line, label=label):
                    ext = physical_pages.extract_physical_pages(result_for(
                        [text_element(11, "Exercise 1: Find x.\n【解答】", 1)],
                        [text_element(12, line, 1, label), text_element(12, "x = 3.", 2)],
                        [text_element(13, "Public explanation.", 1)],
                    ))
                    self.assertEqual(ext.texts_by_page[12], [])
                    self.assertEqual(ext.texts_by_page[13], ["Public explanation."])

    def test_pending_exercise_answer_reopens_at_verified_headings(self):
        for line, label in (
            ("Theorem 2.1.", DocItemLabel.TEXT),
            ("Theorem 2.1 (Lagrange)", DocItemLabel.TEXT),
            ("# Theorem 2.1: finite rings", DocItemLabel.TEXT),
            ("**Theorem 2.1.** finite rings", DocItemLabel.TEXT),
            ("**Theorem 2.1**", DocItemLabel.TEXT),
            ("Theorem 2.1 finite rings", DocItemLabel.SECTION_HEADER),
            ("Table A.2 Summary", DocItemLabel.TEXT),
            ("Fig. IV: Ring diagram", DocItemLabel.TEXT),
            ("**Table 1: Roots**", DocItemLabel.TEXT),
            ("Chapter 2", DocItemLabel.TEXT),
            ("Chapter 2 Rings", DocItemLabel.TEXT),
            ("# Section 2.2: finite rings", DocItemLabel.TEXT),
            ("第一章 环与域", DocItemLabel.TEXT),
            ("第 2 章：群", DocItemLabel.TEXT),
            ("表 1：分解结果", DocItemLabel.TEXT),
            ("表 1 分解结果", DocItemLabel.TEXT),
            ("定理 2.1：拉格朗日定理", DocItemLabel.TEXT),
            ("图 2（a）：函数图像", DocItemLabel.TEXT),
            ("Figure 2(a): Function graph", DocItemLabel.TEXT),
            ("定理 2.1（拉格朗日定理）", DocItemLabel.TEXT),
            ("2.1 Ring Homomorphisms", DocItemLabel.TEXT),
            ("2.1.3 Kernel of a Homomorphism", DocItemLabel.TEXT),
            ("2.3 线性变换的矩阵", DocItemLabel.TEXT),
            ("2.1 有限群", DocItemLabel.TEXT),
            ("2.2 有理数域", DocItemLabel.TEXT),
            ("2.3 有界算子", DocItemLabel.TEXT),
            ("2.4 在线算法", DocItemLabel.TEXT),
        ):
            with self.subTest(line=line, label=label):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, "Exercise 1: Find x.\n【解答】", 1)],
                    [text_element(12, "x =", 1)],
                    [text_element(13, line, 1, label)],
                ))
                self.assertEqual(ext.texts_by_page[12], [])
                self.assertEqual(ext.texts_by_page[13], [line])

    def test_inline_exercise_answer_ignores_parenthesized_footer_punctuation(self):
        for footer in ("(iv).", "第十二页（共三百页）", "共三百页 第十二页", "Page 12", "Chapter 2 — Page 12", "第 2 章 | 第 12 页", "- 12 -",
                       "Chapter 2 Algebra — Page 12", "Chapter 2: Algebra | Page 12", "Section 2.1 Rings - Page 12",
                       "第 2 章 线性代数 — 第 12 页", "2.1 Finite Groups — Page 12", "Algebra — Page 12"):
            with self.subTest(footer=footer):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, "Exercise 1: Find x.\n【解析】\n" + footer, 1)],
                    [text_element(12, "x = 3.", 1)],
                    [text_element(13, "Public explanation.", 1)],
                ))
                self.assertEqual(ext.texts_by_page[12], [])
                self.assertEqual(ext.texts_by_page[13], ["Public explanation."])

    def test_solutions_appendix_requires_assessment_context(self):
        for heading in ("Solutions\nChapter 1 Exercises", "## Solutions (continued):\n\nPage 304\nChapter 1",
                        "Solutions\nSection 1.1 Sets", "Solutions:\n1. The first answer.",
                        "Solutions\n(1) The first answer.", "Solutions\n(a) The first answer.",
                        "Solutions\n1) The first answer.", "Solutions\n1.\nThe first answer.", "Solutions\na. The first answer."):
            with self.subTest(heading=heading):
                chemistry = "## Solutions\nProblems arise when dissolved ions precipitate."
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, chemistry, 1)],
                    [text_element(12, heading + "\n3. A hidden derivation.", 1)],
                    [text_element(13, "Chapter 2 Exercises\n1. Another hidden derivation.", 1)],
                    [text_element(14, "Works Cited\nPublic references.", 1)],
                ))
                self.assertEqual("\n".join(ext.texts_by_page[11]), chemistry)
                self.assertEqual(ext.texts_by_page[12], [])
                self.assertEqual(ext.texts_by_page[13], [])
                self.assertEqual("\n".join(ext.texts_by_page[14]), "Works Cited\nPublic references.")

    def test_period_delimited_assessment_answers_and_worked_examples(self):
        theorem = "Theorem 2.1: Ax = b has a unique\nsolution. Moreover, x = A^{-1}b."
        example = "Example 1: Factor x.\nSolution. The worked example is public."
        labels = ("Solution.", "SOLUTION.", "Answer.", "ANSWER.", "Worked solution.", "Model answer.")
        assessment = "\n\n".join(f"Problem {index}. Find x.\n{label} The answer is private."
                                  for index, label in enumerate(labels, 1))
        ext = physical_pages.extract_physical_pages(result_for(
            [text_element(11, assessment, 1)],
            [text_element(12, theorem, 1), text_element(12, example, 2)],
        ))
        public_lines = [line for text in ext.texts_by_page[11] for line in text.splitlines() if line.strip()]
        self.assertEqual(public_lines, [f"Problem {index}. Find x." for index in range(1, len(labels) + 1)])
        self.assertEqual("\n".join(ext.texts_by_page[12]), theorem + "\n" + example)

    def test_nested_answer_proof_survives_paragraphs_and_page_breaks(self):
        problem = "Problem 1. Prove the identity."
        theorem = "Theorem 2.1: The identity.\n\nProof. The public justification. ∎"
        example = "Example 1: Factor x.\nSolution. The derivation.\n\nProof. The worked proof."
        for separator in ("\n", "\n\n"):
            for label in ("Solution.", "Answer:"):
                for end in ("", "∎", "Q.E.D.", "\\Box", "证毕"):
                    with self.subTest(separator=separator, label=label, end=end):
                        first = separator.join((problem, f"{label} We use strong induction.",
                                                "Proof. Base Cases: private calculation."))
                        second = separator.join(("Inductive Step: private computation.", "The equality follows."))
                        public_tail = "Public prose after the proof." if end else "Problem 2. Find the root."
                        third = f"The private conclusion. {end}\n\n{public_tail}" if end else public_tail
                        ext = physical_pages.extract_physical_pages(result_for(
                            [text_element(11, first)], [text_element(12, second)], [text_element(13, third)],
                            [text_element(14, theorem)], [text_element(15, example)],
                        ))
                        self.assertEqual(ext.texts_by_page[11], [problem])
                        self.assertEqual(ext.texts_by_page[12], [])
                        self.assertEqual(ext.texts_by_page[13], [public_tail])
                        self.assertEqual(ext.texts_by_page[14], [theorem])
                        self.assertEqual(ext.texts_by_page[15], [example])
                        self.assertTrue(ext.inline_proof_sealed_by_page[11])
                        self.assertTrue(ext.inline_proof_sealed_by_page[12])
                        self.assertFalse(ext.inline_sealed_by_page[13])
                        self.assertIn("proof", [block.kind for block in ext.discourse_blocks_by_page[14]])

    def test_closes_markdown_wrapped_answer_proofs(self):
        for proof in (
            "Proof. Starts.\nQ.E.D.",
            "**Proof. Done. ∎**",
            "Proof. Starts.\n**Q.E.D.**",
            "Proof. Starts.\n## Q.E.D. ###",
            "Proof. Starts.\n__Q.E.D.__",
            "*Proof. Done. ∎*",
            "_Proof. Done. ∎_",
            "Proof. Starts.\n*Q.E.D.*",
            "Proof. Starts.\n_Q.E.D._",
            "Proof. Done. *∎*",
            "Proof. Done. *Q.E.D.*",
            "Proof. Done. _Q.E.D._",
            "*Proof. Since 2 * 3 = 6, done. ∎*",
            "*Proof. Since 2 * 3 = 6. Q.E.D.*",
            "_Proof. Since a_1 + a_2 = 3. Q.E.D._",
            "*Proof. Since 2 * 3 = 6, continue. Q.E.D.*",
            "_Proof. Since a_1 + a_2 = 3, continue. Q.E.D._",
            "*Proof.* Calculation continues. *Q.E.D.*",
            "Proof. Starts.\n\\(\\Box \\)",
            "Proof. Starts.\n\\[\\blacksquare \\]",
            "Proof. Starts.\n$\\Box $",
            "Proof. Starts.\n(\\Box )",
            "*Proof. Done. \\(\\Box \\)*",
        ):
            with self.subTest(proof=proof):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, "Answer: No.\n" + proof)],
                    [text_element(12, "Public prose after the proof.")],
                ))
                self.assertEqual(ext.texts_by_page[11], [])
                self.assertFalse(ext.inline_proof_sealed_by_page[11])
                self.assertFalse(ext.inline_proof_boundary_by_page[11])
                self.assertEqual(ext.texts_by_page[12], ["Public prose after the proof."])

        for proof_heading in (
            "*Proof. Since 2 * 3 = 6, continue.*",
            "_Proof. Since a_1 + a_2 = 3, continue._",
            "*Proof. Since 2 * 3 = 6.* Calculation continues.",
        ):
            with self.subTest(proof_heading=proof_heading):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, "Answer: No.")],
                    [text_element(12, proof_heading)],
                    [text_element(13, "Still private continuation.")],
                    [text_element(14, "The proof ends. ∎")],
                    [text_element(15, "Public prose after the proof.")],
                ))
                self.assertEqual(ext.texts_by_page[11], [])
                self.assertEqual(ext.texts_by_page[12], [])
                self.assertEqual(ext.texts_by_page[13], [])
                self.assertEqual(ext.texts_by_page[14], [])
                self.assertEqual(ext.texts_by_page[15], ["Public prose after the proof."])
                self.assertTrue(ext.inline_proof_sealed_by_page[12])
                self.assertTrue(ext.inline_proof_sealed_by_page[13])

        for malformed_heading in ("*Proof** Calculation continues.*", "*Proof.** Calculation continues.*"):
            with self.subTest(malformed_heading=malformed_heading):
                self.assertIsNone(physical_pages._ANSWER_PROOF_HEADING_RE.match(malformed_heading))
                self.assertIsNone(physical_pages._PROOF_RE.match(malformed_heading))

        for unfinished in (
            "Answer: 2 * 3 * 4",
            "Answer: No.\nProof. Starts.\n*Q.E.D.",
            "Answer: No.\nProof. Starts.\nQ.E.D.*",
            "Answer: No.\nProof. Starts.\n_Q.E.D.",
            "Answer: No.\nProof. Starts.\nQ.E.D._",
            "Answer: No.\nProof. Starts.\n*∎",
            "Answer: No.\nProof. Starts.\n∎*",
            "Answer: No.\nProof. Done. *Q.E.D.",
            "Answer: No.\nProof. Done. Q.E.D.*",
            "Answer: No.\nProof. Starts.\n**Q.E.D.*",
            "Answer: No.\nProof. Starts.\n*Q.E.D.**",
            "Answer: No.\nProof. Done. ∎*",
            "Answer: No.\nProof. Done. foo_Q.E.D._",
            "Answer: No.\n*Proof.* Calculation continues. Q.E.D.*",
            "Answer: No.\n_Proof._ Calculation continues. Q.E.D._",
            "Answer: No.\n*Proof.* Calculation continues. *Q.E.D.",
            "Answer: No.\nProof. Starts.\n*Note.* Calculation continues. Q.E.D.*",
            "Answer: No.\nProof. This is not the end of answers.",
            "Answer: x =\n*∎",
            "Answer: x =\n_∎",
            "Answer: x =\n**∎*",
            "Answer: x =\n*□",
            "Answer: x =\n*Q.E.D.",
            "Answer: x =\n_Q.E.D.",
            "Answer: x =\n**Q.E.D.",
            "Answer: x =\n**Q.E.D.*",
            "Answer: x =\n*Q.E.D.**",
            "Answer: x =\nQ.E.D.*.",
            "Answer: x =\n*证毕。",
            "Answer: x =\n*End of Answers.",
            "Answer: x =\n*Note.* Calculation continues. Q.E.D.*.",
        ):
            with self.subTest(unfinished=unfinished):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, unfinished)],
                    [text_element(12, "Still private continuation.")],
                ))
                self.assertTrue(ext.inline_sealed_by_page[11])
                self.assertEqual(ext.texts_by_page[12], [])

    def test_preserves_interior_operators_in_answer_digests(self):
        def digest_for(answer_line: str) -> str:
            ext = physical_pages.extract_physical_pages(result_for([text_element(11, "1. Find x.\n" + answer_line)]))
            self.assertEqual(ext.texts_by_page[11], ["1. Find x."])
            self.assertTrue(ext.inline_proof_boundary_by_page[11])
            return ext.completed_inline_answer_digest_by_page[11]

        self.assertNotEqual(digest_for("Answer: 2**3."), digest_for("Answer: 23."))
        self.assertNotEqual(digest_for("Answer: 2**3 + 4**5."), digest_for("Answer: 23 + 45."))
        self.assertNotEqual(digest_for("Answer: (x)**(y) + (z)**(w)."), digest_for("Answer: (x)(y) + (z)(w)."))
        self.assertNotEqual(digest_for("Answer: 2 ** 3 + 4 ** 5."), digest_for("Answer: 2 3 + 4 5."))
        self.assertNotEqual(digest_for("Answer: x__1 + y__2."), digest_for("Answer: x1 + y2."))
        expected_exp = sha256(b"Answer: 2**3.").hexdigest()
        for wrapped in ("Answer: 2**3.", "**Answer:** 2**3.", "**Answer**: 2**3.", "**Answer: 2**3.**", "**Answer:** **2**3.**"):
            with self.subTest(wrapped=wrapped):
                self.assertEqual(digest_for(wrapped), expected_exp)
        expected_no = sha256(b"Answer: No.").hexdigest()
        for wrapped in ("## **Answer:** No. ##", "__Answer:__ No.", "Answer: **No.**", "**Answer:** **No.**", "__Answer:__ __No.__"):
            with self.subTest(wrapped=wrapped):
                self.assertEqual(digest_for(wrapped), expected_no)
        self.assertEqual(digest_for("**Model** **Answer**: No."), sha256(b"Model Answer: No.").hexdigest())

        for pathological in ("**a " * 10000, "__a " * 10000):
            started = perf_counter()
            stripped = physical_pages._strip_markdown_emphasis(pathological)
            elapsed = perf_counter() - started
            self.assertEqual(stripped, pathological)
            self.assertLess(elapsed, 0.05)

        for opener, trailing in (
            ("Answer: No.\nProof. Starts.", "*Q.E.D.*" + " " * 20000 + "continuing prose"),
            ("Answer Key", "*End of Answers.*" + " " * 20000 + "continuing prose"),
        ):
            started = perf_counter()
            matched = physical_pages._INLINE_SEALED_TERMINATOR_RE.search(trailing)
            elapsed = perf_counter() - started
            self.assertIsNone(matched)
            self.assertLess(elapsed, 0.05)
            ext = physical_pages.extract_physical_pages(result_for(
                [text_element(11, f"{opener}\n{trailing}")],
                [text_element(12, "Still private continuation.")],
            ))
            self.assertEqual(ext.texts_by_page[12], [])

    def test_closes_markdown_wrapped_section_and_public_proof(self):
        ext = physical_pages.extract_physical_pages(result_for(
            [text_element(11, "Answer Key\nPrivate calculation\n**End of Answers.**")],
            [text_element(12, "Public prose after the answer section.")],
            [text_element(13, "Proof. The public derivation.\n__Q.E.D.__")],
            [text_element(14, "Public prose after the proof.")],
            [text_element(15, "Answer Key\nPrivate calculation\n*End of Answers.*")],
            [text_element(16, "Public prose after italic end.")],
            [text_element(17, "*Proof. The public derivation. ∎*")],
            [text_element(18, "Public prose after italic proof.")],
            [text_element(19, "Answer Key\nCalculation complete. *End of Answers.*")],
            [text_element(20, "Public prose after inline italic end.")],
        ))
        self.assertEqual(ext.texts_by_page[12], ["Public prose after the answer section."])
        self.assertEqual([block.kind for block in ext.discourse_blocks_by_page[14]], ["narrative"])
        self.assertFalse(ext.discourse_blocks_by_page[13][-1].continues_on_next_page)
        self.assertEqual(ext.texts_by_page[16], ["Public prose after italic end."])
        self.assertEqual([block.kind for block in ext.discourse_blocks_by_page[18]], ["narrative"])
        self.assertFalse(ext.discourse_blocks_by_page[17][-1].continues_on_next_page)
        self.assertEqual(ext.texts_by_page[20], ["Public prose after inline italic end."])

        for valid_end in (
            "End of Answers.",
            "*End of Answers.*",
            "答案完。",
            "[End of Answers]",
            "（答案完）",
            "Calculation complete. End of Answers.",
            "Calculation complete. *End of Answers.*",
            "Calculation complete. _End of Answers._",
            "Calculation complete. **End of Answers.**",
            "*Calculation complete. End of Answers.*",
        ):
            with self.subTest(valid_end=valid_end):
                closed = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, "Answer Key\n" + valid_end)],
                    [text_element(12, "Public prose after valid section end.")],
                ))
                self.assertFalse(closed.section_sealed_by_page[11])
                self.assertEqual(closed.texts_by_page[12], ["Public prose after valid section end."])

        for unmatched_end in (
            "Calculation complete. *End of Answers.",
            "Calculation complete. End of Answers.*",
            "*Note.* Calculation continues. End of Answers.*",
            "This is not the end of answers.",
            "We have not reached the end of solutions.",
            "See the end of solutions.",
            "*This is not the end of answers.*",
            "这里不是答案完。",
        ):
            with self.subTest(unmatched_end=unmatched_end):
                unclosed = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, "Answer Key\n" + unmatched_end)],
                    [text_element(12, "Still private section continuation.")],
                ))
                self.assertTrue(unclosed.section_sealed_by_page[11])
                self.assertEqual(unclosed.texts_by_page[12], [])

    def test_same_line_answer_proof_and_terminal_boundary_are_sealed(self):
        ext = physical_pages.extract_physical_pages(result_for(
            [text_element(11, "Problem 1. Prove it.\nSolution. Proof. Private derivation.", 1)],
            [text_element(12, "Proof. Private continuation.", 2)],
            [text_element(13, "Problem 2. Public problem.", 3)],
        ))
        self.assertEqual(ext.texts_by_page[11], ["Problem 1. Prove it."])
        self.assertEqual(ext.texts_by_page[12], [])
        self.assertEqual(ext.texts_by_page[13], ["Problem 2. Public problem."])
        self.assertTrue(ext.inline_proof_sealed_by_page[11])

    def test_next_page_proof_boundary_skips_furniture(self):
        problem = "Problem 1. Prove the identity."
        for answer in ("Solution. The answer is 3.", "Answer: Yes. □"):
            for proof_at_start in (True, False):
                with self.subTest(answer=answer, proof_at_start=proof_at_start):
                    proof = "Proof. Private continuation."
                    public = "This paragraph introduces another method."
                    ext = physical_pages.extract_physical_pages(result_for(
                        [text_element(11, f"{problem}\n{answer}\nPage 11 of 40", 1)],
                        [text_element(12, "Course notes", 1, DocItemLabel.PAGE_HEADER),
                         text_element(12, "[原生提取]\nChapter 1 | Page 12\n"
                                      + (proof if proof_at_start else f"{public}\n{proof}"), 2)],
                        [text_element(13, "The next argument. ∎", 1)],
                    ))
                    self.assertTrue(ext.inline_proof_boundary_by_page[11])
                    self.assertEqual(ext.inline_proof_sealed_by_page[12], proof_at_start)
                    self.assertEqual(proof in "\n".join(ext.texts_by_page[12]), not proof_at_start)
                    self.assertEqual(bool(ext.texts_by_page[13]), not proof_at_start)

    def test_scans_public_proof_continuation_once_per_line(self):
        line = "Because the two terms agree, the inductive equality follows."
        proof = "\n".join(["Proof."] + [line] * 3200 + ["This concludes the proof. \\square"])
        fragments = [(proof + "\nThe following paragraph is outside the proof.", None)]
        scanned_characters = 0
        pattern = physical_pages._PROOF_TERMINATOR_RE

        class MeteredTerminator:
            def search(self, text):
                nonlocal scanned_characters
                scanned_characters += len(text)
                return pattern.search(text)

        with patch.object(physical_pages, "_PROOF_TERMINATOR_RE", MeteredTerminator()):
            start = perf_counter()
            blocks, *_ = physical_pages._build_page_blocks(1, fragments, set())
            elapsed = perf_counter() - start
        self.assertEqual([block.kind for block in blocks], ["proof", "narrative"])
        self.assertEqual(blocks[0].text, proof)
        self.assertEqual(scanned_characters, len(proof.replace("\n", "")))
        self.assertLess(elapsed, 0.25)

    def test_section_seal_withholds_proofs_and_reopens_at_structural_headings(self):
        for heading in ("Theorem 2.1 (Lagrange)", "定理 2.1（拉格朗日定理）", "Definition 1.2", "定义 1.2",
                        "Worked Example 2.1", "例题 2.1", "2.1 有限群", "2.1 AI", "2.1 ML", "2.1 OS", "2.1 LP",
                        "Preface", "Introduction: Rings", "序言", "前言", "引言：环"):
            with self.subTest(heading=heading):
                ext = physical_pages.extract_physical_pages(result_for(
                    [text_element(11, "Answer Key", 1)],
                    [text_element(12, "Proof:\n证明：\n5 units.", 1)],
                    [text_element(13, "Chapter 2: What Is Algebra? — Page 12", 1),
                     text_element(13, heading, 2), text_element(13, "Public explanation.", 3)],
                ))
                self.assertEqual(ext.texts_by_page[12], [])
                self.assertEqual(ext.texts_by_page[13], [heading, "Public explanation."])

    def test_measurements_result_clauses_and_markup_do_not_end_answer_seals(self):
        lines = (
            "3.14 千瓦时", "3.14 毫安时", "3.14 千瓦·时", "3.14 千伏安", "3.14 牛·米", "3.14 米每秒",
            "3.14 千米每小时", "3.14 公顷", "3.14 亩", "3.14 有实数解", "3.14 有唯一解", "3.14 在区间内", "3.14 在实数域上",
            "3.14 V", "3.14 Hz", "3.14 cm", "3.14 dB", "3.14 mL", "3.14 MB",
            "## Theorem 2.1 (Lagrange), applied to G, gives the result.", "## Figure 2(a), which shows the graph, is useful here.",
            "## Chapter 2 explains why this is true.", "## 图 2（a）显示了函数图像。", "## Example 2 gives the result.",
            "## The construction is shown below.", "## Introduction to Answers",
            "Chapter 2: What Is Algebra? — Page 12", "Section 1: What is a Ring? | Page 12",
            "第 2 章：什么是代数？｜第 12 页", "What Is Algebra? — Page 12",
        )
        for opener in ("Answer Key", "Exercise 1: Find x.\n【解答】"):
            for line in lines:
                with self.subTest(line=line, opener=opener):
                    ext = physical_pages.extract_physical_pages(result_for(
                        [text_element(11, opener, 1)],
                        [text_element(12, line, 1), text_element(12, "x = 3.", 2)],
                        [text_element(13, "Chapter 3: Fields", 1)],
                    ))
                    self.assertEqual(ext.texts_by_page[12], [])
                    self.assertEqual(ext.texts_by_page[13], ["Chapter 3: Fields"])

    def test_running_counters_do_not_match_prose_page_references(self):
        for line in ("The complete construction is shown on page 12.", "The derivation appears at page 12.",
                     "For the complete derivation, see page 12.", "完整推导见第 12 页。"):
            with self.subTest(line=line):
                self.assertFalse(physical_pages._is_running_page_heading(line))

    def test_round8_reading_order_tables_and_lecture_solutions(self):
        table_label = DocItemLabel.TABLE
        answer_table = Table(
            id=2,
            label=table_label,
            page_no=14,
            cluster=cluster(2, table_label),
            otsl_seq=[],
            num_rows=2,
            num_cols=1,
            table_cells=[
                TableCell(
                    text="Question",
                    row_span=1,
                    col_span=1,
                    start_row_offset_idx=0,
                    end_row_offset_idx=1,
                    start_col_offset_idx=0,
                    end_col_offset_idx=1,
                    column_header=True,
                ),
                TableCell(
                    text="sealed-table-answer",
                    row_span=1,
                    col_span=1,
                    start_row_offset_idx=1,
                    end_row_offset_idx=2,
                    start_col_offset_idx=0,
                    end_col_offset_idx=1,
                ),
            ],
        )
        result = result_for(
            [
                text_element(11, "Lecture 4: Solutions\n1. x = 5", 1, DocItemLabel.SECTION_HEADER),
            ],
            [
                text_element(12, "Lecture 1", 1, DocItemLabel.SECTION_HEADER),
                text_element(12, "第 1 讲", 2, DocItemLabel.SECTION_HEADER),
                text_element(12, "Lecture 4: Review", 3, DocItemLabel.SECTION_HEADER),
                text_element(12, "第 3 讲 思考题\n2. y = 6", 4, DocItemLabel.SECTION_HEADER),
            ],
            [
                text_element(13, "Lecture 5: Singular Values\nTheorem 5.1: SVD exists.", 1, DocItemLabel.SECTION_HEADER),
                text_element(13, "第 3 讲：解答\n1. 对", 2),
                text_element(13, "第 4 讲 习题答案\n2. 错", 3),
                text_element(13, "第 5 讲 特征值\n定义：Ax = λx。", 4, DocItemLabel.SECTION_HEADER),
            ],
            [
                text_element(14, "Answer Key", 1),
                answer_table,
                text_element(14, "Chapter 2: Rings\nRing axioms hold.", 3),
            ],
        )
        ext = physical_pages.extract_physical_pages(result)
        self.assertEqual(ext.texts_by_page[11], [])
        self.assertTrue(ext.section_sealed_by_page[11])
        self.assertTrue(ext.had_sealed_by_page[11])

        self.assertEqual(ext.texts_by_page[12], [])
        self.assertTrue(ext.section_sealed_by_page[12])
        self.assertTrue(ext.had_sealed_by_page[12])

        p13 = "\n".join(ext.texts_by_page[13])
        self.assertIn("Lecture 5: Singular Values", p13)
        self.assertIn("Theorem 5.1: SVD exists.", p13)
        self.assertNotIn("1. 对", p13)
        self.assertNotIn("2. 错", p13)
        self.assertIn("第 5 讲 特征值", p13)
        self.assertIn("定义：Ax = λx。", p13)
        self.assertFalse(ext.section_sealed_by_page[13])
        self.assertTrue(ext.had_sealed_by_page[13])

        p14 = "\n".join(ext.texts_by_page[14])
        self.assertNotIn("Answer Key", p14)
        self.assertNotIn("sealed-table-answer", p14)
        self.assertIn("Chapter 2: Rings", p14)
        self.assertIn("Ring axioms hold.", p14)
        self.assertFalse(ext.section_sealed_by_page[14])
        self.assertTrue(ext.had_sealed_by_page[14])

        # Verify fallback bbox vertical ordering when iterate_items is unavailable on a lightweight doc double.
        bbox_doc = SimpleNamespace(
            pages=[1],
            texts=[
                SimpleNamespace(text="Answer Key", label="text", prov=[ProvenanceItem(page_no=1, charspan=(0, 10), bbox=BoundingBox(l=72, t=100, r=400, b=120))]),
                SimpleNamespace(text="Chapter 2: Rings", label="section_header", prov=[ProvenanceItem(page_no=1, charspan=(0, 16), bbox=BoundingBox(l=72, t=220, r=400, b=240))]),
            ],
            tables=[
                SimpleNamespace(prov=[ProvenanceItem(page_no=1, charspan=(0, 5), bbox=BoundingBox(l=72, t=150, r=400, b=190))], export_to_markdown=lambda doc=None: "| sealed |"),
            ],
        )
        bbox_ext = physical_pages.extract_physical_pages(bbox_doc)
        self.assertEqual(bbox_ext.texts_by_page[1], ["Chapter 2: Rings"])
        self.assertTrue(bbox_ext.had_sealed_by_page[1])

        bbox_doc.iterate_items = lambda: ((item, 1) for item in bbox_doc.texts)
        partial_ext = physical_pages.extract_physical_pages(bbox_doc)
        self.assertEqual(partial_ext.raw_texts_by_page[1], ["Answer Key", "| sealed |", "Chapter 2: Rings"])
        self.assertEqual(partial_ext.texts_by_page[1], ["Chapter 2: Rings"])


if __name__ == "__main__":
    if WORKER_FIXTURE_MODE:
        print(json.dumps(worker_pdf_cli_fixtures()))
    else:
        unittest.main()
