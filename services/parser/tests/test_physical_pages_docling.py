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


if __name__ == "__main__":
    unittest.main()
