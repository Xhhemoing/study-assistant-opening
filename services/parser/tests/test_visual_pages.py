import unittest
from types import SimpleNamespace as N
from opening_parser.physical_pages import visual_kinds_by_page

class VisualPageTests(unittest.TestCase):
    def page(self, number, labels=(), cells=None):
        clusters = [N(label=label, children=[]) for label in labels]
        return N(page_no=number, predictions=N(layout=N(clusters=clusters)), assembled=N(elements=[]), cells=cells or [])

    def test_mixed_native_text_page_uses_layout_not_symbols(self):
        pages = [self.page(1, ["formula", "table", "picture"], [N(text="ordinary caption", from_ocr=False)]),
                 self.page(2, ["text"], [N(text="x = 2", from_ocr=False)])]
        self.assertEqual(visual_kinds_by_page(N(document=N(), pages=pages), {1: ["caption"], 2: ["x = 2"]}),
                         {1: ["formula", "table", "picture"], 2: []})

    def test_scan_remains_visual_after_local_ocr_and_nested_layout_is_retained(self):
        page = self.page(11, ["text"], [N(text="local OCR words", from_ocr=True)])
        page.predictions.layout.clusters[0].children = [N(label="formula", children=[])]
        self.assertEqual(visual_kinds_by_page(N(document=N(), pages=[page]), {11: ["OCR words"]}), {11: ["scan", "formula"]})

    def test_native_header_does_not_hide_scanned_or_handwritten_body(self):
        page = self.page(1, ["text"], [N(text="native heading", from_ocr=False), N(text="OCR body", from_ocr=True)])
        self.assertEqual(visual_kinds_by_page(N(document=N(), pages=[page]), {1: ["native heading", "OCR body"]}), {1: ["scan"]})

    def test_native_header_does_not_hide_embedded_scan_when_layout_has_no_cells(self):
        page = self.page(1, ["title", "text"], [N(text="native heading", from_ocr=False)])
        page.predictions.layout.clusters[0].cells = page.cells
        page.predictions.layout.clusters[1].cells = []
        page.parsed_page = N(bitmap_resources=[N()])
        self.assertEqual(visual_kinds_by_page(N(document=N(), pages=[page]), {1: ["native heading"]}), {1: ["picture"]})

    def test_empty_layout_assignments_do_not_turn_native_prose_into_a_scan(self):
        # Real 2.126.0 can assign native text to a containing key-value cluster,
        # leaving overlapping text clusters empty on an otherwise native page.
        page = self.page(1, ["text"], [N(text="native prose", from_ocr=False)])
        page.predictions.layout.clusters[0].cells = []
        page.parsed_page = N(bitmap_resources=[])
        self.assertEqual(visual_kinds_by_page(N(document=N(), pages=[page]), {1: ["native prose"]}), {1: []})

    def test_blank_and_document_only_fallback_need_visual_recognition(self):
        self.assertEqual(visual_kinds_by_page(N(pages=[4, 5], texts=[]), {4: ["native"], 5: []}), {4: [], 5: ["scan"]})

if __name__ == "__main__":
    unittest.main()
