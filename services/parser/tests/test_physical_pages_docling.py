"""Installed Docling data/reading-order regression; no converter, models or network.

Run separately in the pinned parser venv. The stdlib-only suite tests boundary
failures; this suite exercises real ConversionResult/Page/ReadingOrderModel and
TableItem export, including the upstream merge that corrupts charspans.
"""
import os
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from docling.datamodel.base_models import AssembledUnit, Cluster, ConversionStatus, InputFormat, Page, Table, TextElement
from docling.datamodel.document import ConversionResult, InputDocument
from docling.models.stages.page_assemble.page_assemble_model import PageAssembleModel, PageAssembleOptions
from docling.models.stages.reading_order.readingorder_model import ReadingOrderModel, ReadingOrderOptions
from docling_core.types.doc import BoundingBox, ContentLayer, DocItemLabel, DoclingDocument, ProvenanceItem, Size, TableCell

from opening_parser import __main__ as cli
from opening_parser import physical_pages


SIZE = Size(width=612, height=792)


def cluster(identifier, label=DocItemLabel.TEXT):
    return Cluster(id=identifier, label=label, bbox=BoundingBox(l=72, t=72 + identifier * 40, r=500, b=100 + identifier * 40))


def text_element(page_no, text, identifier=1, label=DocItemLabel.TEXT):
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
            ("inline_sealed", "答案：", "5 units.", "inlineSealedAtEnd"),
            ("inline_sealed", "【参考答案】", "5 units.", "inlineSealedAtEnd"),
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

    def test_completed_inline_answer_releases_next_page_but_label_before_blank_does_not(self):
        result = result_for(
            [text_element(10, "Exercise 1: Find x.\nAnswer:\n\n5 units.\n")],
            [text_element(11, "Public explanation.")],
            start_page=10,
        )
        extracted = physical_pages.extract_physical_pages(result)
        self.assertEqual(extracted.texts_by_page[10], ["Exercise 1: Find x."])
        self.assertEqual(extracted.texts_by_page[11], ["Public explanation."])

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
    unittest.main()
