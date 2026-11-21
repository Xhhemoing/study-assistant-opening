"""Installed Docling data/reading-order regression; no converter, models or network.

Run separately in the pinned parser venv. The stdlib-only suite tests boundary
failures; this suite exercises real ConversionResult/Page/ReadingOrderModel and
TableItem export, including the upstream merge that corrupts charspans.
"""
import os
import unittest
from pathlib import Path
from unittest.mock import patch

from docling.datamodel.base_models import AssembledUnit, Cluster, ConversionStatus, InputFormat, Page, Table, TextElement
from docling.datamodel.document import ConversionResult, InputDocument
from docling.models.stages.page_assemble.page_assemble_model import PageAssembleModel, PageAssembleOptions
from docling.models.stages.reading_order.readingorder_model import ReadingOrderModel, ReadingOrderOptions
from docling_core.types.doc import BoundingBox, DocItemLabel, DoclingDocument, ProvenanceItem, Size, TableCell

from opening_parser import __main__ as cli
from opening_parser import physical_pages


SIZE = Size(width=612, height=792)


def cluster(identifier, label=DocItemLabel.TEXT):
    return Cluster(id=identifier, label=label, bbox=BoundingBox(l=72, t=72 + identifier * 40, r=500, b=100 + identifier * 40))


def text_element(page_no, text, identifier=1, label=DocItemLabel.TEXT):
    return TextElement(id=identifier, label=label, page_no=page_no, text=text, cluster=cluster(identifier, label))


def result_for(*page_elements):
    pages = [Page(page_no=number, size=SIZE, assembled=AssembledUnit(elements=elements))
        for number, elements in enumerate(page_elements, 11)]
    # A data-only InputDocument avoids opening any backend or PDF file.
    source = InputDocument.model_construct(file=Path("physical-pages.pdf"), format=InputFormat.PDF, document_hash="0" * 64)
    doc = DoclingDocument(name="physical-pages")
    for page in pages:
        doc.add_page(page_no=page.page_no, size=SIZE)
    return ConversionResult(input=source, status=ConversionStatus.SUCCESS, pages=pages,
        assembled=AssembledUnit(elements=[element for page in pages for element in page.assembled.elements]), document=doc)


class PhysicalPagesDoclingTests(unittest.TestCase):
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
                text_element(11, "", 3),
            ],
        )
        # Simulate defensive text=None and OCR cells on an all-sealed page.
        object.__setattr__(result.pages[0].assembled.elements[2], "text", None)
        result.pages[0].cells = [type("Cell", (), {"text": "1.1 x = 3", "from_ocr": True})()]
        pub = cli.texts_by_page(result)
        self.assertEqual(pub[11], [])
        self.assertEqual(cli.visual_kinds_by_page(result, pub)[11], [])

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


if __name__ == "__main__":
    unittest.main()
