"""Physical-page text and academic discourse extraction from Docling pre-merge assemblies.

ReadingOrderModel 2.126.0 changes text when joining hyphenated continuations
without fixing provenance charspans. Neither merged text nor orig is sliceable
by those spans. ConversionResult.pages still holds the original page elements.
"""

from dataclasses import dataclass, replace
import re

ACADEMIC_DISCOURSE_KINDS = (
    "definition",
    "theorem",
    "proof",
    "worked_example",
    "exercise",
    "solution_sealed",
    "narrative",
    "figure_caption",
)
VISIBILITY_HINTS = ("public", "hint_gated", "sealed")
VISIBILITY_BY_KIND = {
    "definition": "public",
    "theorem": "public",
    "exercise": "public",
    "narrative": "public",
    "figure_caption": "public",
    "proof": "hint_gated",
    "worked_example": "hint_gated",
    "solution_sealed": "sealed",
}

_FURNITURE_LABELS = frozenset({"page_header", "page_footer"})
_HEADING_LABELS = frozenset({"section_header", "title"})
_CONTINUABLE_KINDS = frozenset({"definition", "theorem", "proof", "worked_example", "exercise", "solution_sealed"})

_MD_HASH_PREFIX_RE = re.compile(r"^(?:#{1,6}\s+)+")
_MD_WRAPPED_EMPHASIS_RE = re.compile(r"^(\*\*|__)(.+?)\1(.*)$")
_MD_EDGE_EMPHASIS_RE = re.compile(r"^(?:\*\*|__)+|(?:\*\*|__)+$")
_MD_HEADING_LINE_RE = re.compile(r"^#{1,6}\s+\S")
_CAPTION_PREFIX_RE = re.compile(
    r"^(?P<ref>(?:Figure|Fig\.?|Table|Chart|Diagram|Scheme|Algorithm|Listing)\s+\d+(?:[.\-]\d+)*)"
    r"(?:\s*[:.\-—]|$|\s+(?!(?:shows|illustrates|demonstrates|depicts|presents|indicates|is|was|are|can|will)\b))"
    r"|^(?P<zh_ref>(?:图|表|插图|附表|算法)\s*\d+(?:[.\-]\d+)*)(?:\s*[:：.．、\-—]|\s+|$)",
    re.IGNORECASE,
)
_TABLE_CAPTION_REF_RE = re.compile(r"^(?:Table|表|附表)\b", re.IGNORECASE)
_VISUAL_CAPTION_REF_RE = re.compile(r"^(?:Figure|Fig\.?|Chart|Diagram|Scheme|图|插图)\b", re.IGNORECASE)

# Dedicated multi-problem Answer-Key / Solutions section headings (case-sensitive for English to
# avoid matching lowercase wrapped prose like "solution." or bare chemistry "Solutions").
_SECTION_SEALED_RE = re.compile(
    r"^(?:"
    r"(?:(?:Appendix\s+[A-Z0-9]+|APPENDIX\s+[A-Z0-9]+|Chapter\s+\d+|CHAPTER\s+\d+|Section\s+\d+(?:\.\d+)*|SECTION\s+\d+(?:\.\d+)*|第\s*[一二三四五六七八九十百千\d]+\s*[章节篇部]|附录\s*[A-Z0-9一二三四五六七八九十]+)\s*[:：.\-—]?\s*)?"
    r"(?:(?:Answer\s+Key|ANSWER\s+KEY|Answers?\s+Key|ANSWERS?\s+KEY|Key\s+(?:to|TO)\s+(?:the\s+|THE\s+)?(?:Exercises|EXERCISES|Problems|PROBLEMS|Questions|QUESTIONS))(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*(?:[:：]|$)"
    r"|(?:Answers?|ANSWERS?|Solutions?|SOLUTIONS?)\s+(?:to|TO)\s+(?:(?:Selected|SELECTED|Odd-Numbered|ODD-NUMBERED|Even-Numbered|EVEN-NUMBERED|All|ALL|the|THE|Chapter\s+\d+|CHAPTER\s+\d+|Section\s+\d+(?:\.\d+)*|SECTION\s+\d+(?:\.\d+)*)\s+)*(?:Exercises?|EXERCISES?|Problems?|PROBLEMS?|Questions?|QUESTIONS?|Review\s+Questions?|REVIEW\s+QUESTIONS?|Practice\s+Problems?|PRACTICE\s+PROBLEMS?|Self-Check\s+Exercises?|SELF-CHECK\s+EXERCISES?|Chapter\s+\d+|CHAPTER\s+\d+|Section\s+\d+(?:\.\d+)*|SECTION\s+\d+(?:\.\d+)*)(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*(?:[:：]|$)"
    r"|(?:Selected\s+Answers?|SELECTED\s+ANSWERS?|Model\s+Answers?|MODEL\s+ANSWERS?|Official\s+Solutions?|OFFICIAL\s+SOLUTIONS?|Reference\s+Solutions?|REFERENCE\s+SOLUTIONS?|Answer\s+Section|ANSWER\s+SECTION|Solutions?\s+Manual|SOLUTIONS?\s+MANUAL|Answers?\s+(?:and|AND)\s+Solutions?|ANSWERS?\s+(?:and|AND)\s+SOLUTIONS?|Odd-Numbered\s+Answers?|ODD-NUMBERED\s+ANSWERS?|Even-Numbered\s+Answers?|EVEN-NUMBERED\s+ANSWERS?)(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*(?:[:：]|$)"
    r"|(?:Answers|ANSWERS)(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*(?:[:：]|$)"
    r"|【\s*(?:参考答案|标准答案|习题答案|练习答案|课后答案|课后练习答案|课后习题答案|思考题答案|答案与解析|参考解答|详细解答|参考答案与解析|部分习题答案)\s*】\s*$"
    r"|(?:参考答案与解析|参考答案|标准答案|课后习题答案|课后练习答案|课后答案|习题答案|练习答案|思考题答案|部分习题答案|答案与解析|参考解答|详细解答)(?:\s*(?:（续）|\(续\)|（接上页）|\(接上页\)))?\s*(?:[:：]|$)"
    r"|(?:习题\s*)?(?:答案|解答)(?:\s*(?:（续）|\(续\)|（接上页）|\(接上页\)))?\s*(?:[:：]|$)"
    r"))"
)
_INLINE_WITH_BODY_CHECK_RE = re.compile(r"[:：]\s*\S")
_QUALIFIED_MULTI_SECTION_RE = re.compile(
    r"^(?:(?:Appendix\s+[A-Z0-9]+|APPENDIX\s+[A-Z0-9]+|Chapter\s+\d+|CHAPTER\s+\d+|Section\s+\d+(?:\.\d+)*|SECTION\s+\d+(?:\.\d+)*|附录\s*[A-Z0-9一二三四五六七八九十]+|第\s*[一二三四五六七八九十百千\d]+\s*[章节篇部])\s*[:：.\-—]?\s*)?"
    r"(?:Answers?\s+(?:to|TO)\s+|ANSWERS?\s+(?:to|TO)\s+|Selected\s+Answers?|SELECTED\s+ANSWERS?|Model\s+Answers?|MODEL\s+ANSWERS?|"
    r"Official\s+Solutions?|OFFICIAL\s+SOLUTIONS?|Reference\s+Solutions?|REFERENCE\s+SOLUTIONS?|"
    r"Solutions?\s+(?:to|TO)\s+|SOLUTIONS?\s+(?:to|TO)\s+|Solutions?\s+Manual|SOLUTIONS?\s+MANUAL|"
    r"Key\s+(?:to|TO)\s+|KEY\s+(?:to|TO)\s+|"
    r"Answers?\s+(?:and|AND)\s+Solutions?|ANSWERS?\s+AND\s+SOLUTIONS?|"
    r"Odd-Numbered\s+Answers?|ODD-NUMBERED\s+ANSWERS?|Even-Numbered\s+Answers?|EVEN-NUMBERED\s+ANSWERS?|"
    r"参考答案与解析|答案与解析|课后习题答案|课后练习答案|课后答案|练习答案|习题答案|思考题答案|部分习题答案)"
)

# Single-item inline answers attached to an exercise (always requires explicit ':' / '：' or 【...】).
_INLINE_SEALED_ALWAYS_RE = re.compile(
    r"^(?:"
    r"(?:Answer\s+Key|ANSWER\s+KEY|Official\s+Answer|OFFICIAL\s+ANSWER|Model\s+Answer|MODEL\s+ANSWER|Correct\s+Answer|CORRECT\s+ANSWER|Answer|ANSWER|Answers|ANSWERS)(?:\s+\d+(?:\.\d+)*)?(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*[:：]"
    r"|【\s*(?:参考答案|标准答案|正确答案|答案)\s*】"
    r"|(?:参考答案与解析|参考答案|标准答案|正确答案|课后习题答案|课后练习答案|课后答案|练习答案|习题答案|思考题答案|部分习题答案|答案与解析|答案)\s*(?:\d+(?:[.\-]\d+)*)?\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*[:：]"
    r")"
)

# Inline solution/proof markers sealed ONLY outside worked_example context.
_INLINE_SEALED_NON_EXAMPLE_RE = re.compile(
    r"^(?:"
    r"(?:Worked\s+Solution|WORKED\s+SOLUTION|Full\s+Solution|FULL\s+SOLUTION|Sample\s+Solution|SAMPLE\s+SOLUTION|Solution|SOLUTION|Solutions|SOLUTIONS)(?:\s+(?:to|TO)\s+(?:Exercise|EXERCISE|Problem|PROBLEM|Question|QUESTION)\s*\d*(?:\.\d+)*)?(?:\s+\d+(?:\.\d+)*)?(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*[:：]"
    r"|【\s*(?:参考解答|详细解答|解答|详解|解析)\s*】"
    r"|(?:参考解答|详细解答|解答|详解|解析|解)\s*(?:\d+(?:[.\-]\d+)*)?\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*[:：]"
    r")"
)
_STANDALONE_SOLUTION_HEADING_RE = re.compile(
    r"^(?:Worked\s+Solution|WORKED\s+SOLUTION|Full\s+Solution|FULL\s+SOLUTION|Sample\s+Solution|SAMPLE\s+SOLUTION|Solution|SOLUTION|解答|详细解答|参考解答|解析|详解)(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*$"
)

_WORKED_EXAMPLE_INTERNAL_SOLUTION_RE = re.compile(
    r"^(?:"
    r"(?:Worked\s+Solution|WORKED\s+SOLUTION|Full\s+Solution|FULL\s+SOLUTION|Sample\s+Solution|SAMPLE\s+SOLUTION|Solution|SOLUTION|Proof|PROOF)(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*(?:[:：]|(?:\.(?:\s|$))|$)"
    r"|(?:详细解答|参考解答|解答|详解|解析|证明|证|解|分析)(?:\s*(?:（续）|\(续\)|（接上页）|\(接上页\)))?\s*(?:[:：]|$)"
    r"|【\s*(?:解答|证明|证|解|详解|解析|分析)\s*】"
    r")"
)

_PROOF_RE = re.compile(
    r"^(?:"
    r"(?:Proof|PROOF|Sketch\s+of\s+Proof|Proof\s+Sketch)(?:\s+of\s+(?:Theorem|Lemma|Proposition|Corollary)\s*[\d.]*)?(?:\s*\(\s*(?:continued|cont\.?)\s*\))?\s*(?:[:：.\-—]|$)"
    r"|【\s*(?:证明|证|略证|续证)\s*】"
    r"|(?:证明|略证|续证)\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*(?:[:：.．\-—]|$)"
    r"|证\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*[:：.．]"
    r")"
)
_THEOREM_RE = re.compile(
    r"^(?:"
    r"(?:Theorem|Lemma|Proposition|Corollary|Axiom|Conjecture|Claim)"
    r"(?:\s+\d+(?:[.\-]\d+)*(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?(?:\s*[:：.\-—]|\s+|$)|(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?\s*(?:[:：.\-—]|$))"
    r"|(?:定理|引理|推论|命题|公理|猜想)"
    r"(?:\s*\d+(?:[.\-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?(?:\s*[:：.．\-—]|\s+|$)|(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?\s*(?:[:：.．\-—]|$))"
    r")",
    re.IGNORECASE,
)
_DEFINITION_RE = re.compile(
    r"^(?:"
    r"(?:Definition|Notation|Terminology|Convention)"
    r"(?:\s+\d+(?:[.\-]\d+)*(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?(?:\s*[:：.\-—]|\s+|$)|(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?\s*(?:[:：.\-—]|$))"
    r"|(?:定义|记号|约定)"
    r"(?:\s*\d+(?:[.\-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?(?:\s*[:：.．\-—]|\s+|$)|(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?\s*(?:[:：.．\-—]|$))"
    r")",
    re.IGNORECASE,
)
_WORKED_EXAMPLE_RE = re.compile(
    r"^(?:"
    r"(?:Worked\s+Example|Example)"
    r"(?:\s+\d+(?:[.\-]\d+)*(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?(?:\s*[:：.\-—]|\s+|$)|(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?\s*(?:[:：.\-—]|$))"
    r"|例题(?:\s*\d+(?:[.\-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?(?:\s*[:：.．\-—]|\s+|$)|\s*(?:（续）|\(续\))?\s*(?:[:：.．\-—]|$))"
    r"|例(?:\s*\d+(?:[.\-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?(?:\s*[:：.．\-—]|\s+|$)|\s*[:：])"
    r")",
    re.IGNORECASE,
)
_EXERCISE_RE = re.compile(
    r"^(?:"
    r"(?:Exercises?|Practice\s+Problems?|Homework|Quiz|Review\s+Questions?)"
    r"(?:\s+\d+(?:[.\-]\d+)*(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?(?:\s*[:：.\-—]|\s+|$)|(?:\s*\([^)]+\))?(?:\s*\(\s*continued\s*\))?\s*(?:[:：.\-—]|$))"
    r"|(?:Problem|Problems|Question|Questions)(?:\s+\d+(?:[.\-]\d+)*(?:\s*\([^)]+\))?(?:\s*[:：.\-—]|\s+|$)|\s*(?:[:：.\-—]|$))"
    r"|(?:习题|练习题|练习|思考题|作业题|课后习题)"
    r"(?:\s*\d+(?:[.\-]\d+)*(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?(?:\s*[:：.．\-—]|\s+|$)|(?:\s*[（(][^）)]+[）)])?(?:\s*(?:（续）|\(续\)))?\s*(?:[:：.．\-—]|$))"
    r"|(?:第\s*\d+\s*题|题\s*\d+)\s*(?:[:：.．\-—]|\s+|$)"
    r")",
    re.IGNORECASE,
)
_SECTION_BREAK_RE = re.compile(
    r"^(?:"
    r"(?:Chapter|Section|Part|Appendix)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)(?:\b|$)"
    r"|第\s*[一二三四五六七八九十百千\d]+\s*[章节篇部分]"
    r"|\d+(?:\.\d+)+\s+\S"
    r")",
    re.IGNORECASE,
)
_TITLED_CHAPTER_RE = re.compile(
    r"^(?:(?:Chapter|Part|Section)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)|第\s*[一二三四五六七八九十百千\d]+\s*[章节篇部分])(?:\s*[:：.\-—]\s*|\s+)?(?P<title>.*)$",
    re.IGNORECASE,
)
_ANSWER_TITLE_WORD_RE = re.compile(r"(?:Answer|Solution|Exercise|Problem|答案|解答|习题|练习)", re.IGNORECASE)
_TEXTBOOK_NON_ANSWER_HEADING_RE = re.compile(
    r"^(?:"
    r"(?:Definition|Notation|Terminology|Convention|Theorem|Lemma|Proposition|Corollary|Axiom|Conjecture|Claim|Worked\s+Example|Example|Lecture)\b"
    r"|(?:定义|记号|约定|定理|引理|推论|命题|公理|猜想|例题|例\s*\d+|例\s*[:：])"
    r")"
)
_MAJOR_NON_ANSWER_HEADING_RE = re.compile(
    r"^(?:"
    r"(?:Bibliography|References|Works\s+Cited|Index|Subject\s+Index|Author\s+Index|Glossary|Notation\s+Index|Acknowledgements?|About\s+the\s+Authors?)"
    r"|(?:参考文献|索引|名词索引|主题索引|符号表|后记|致谢)"
    r"|Appendix\s+[A-Z0-9]+(?:\s*[:.\-—]\s*(?!.*(?:Answer|Solution)).*)?$"
    r"|附录\s*[A-Z0-9一二三四五六七八九十]+(?:\s*[:：.\-—]\s*(?!.*(?:答案|解答)).*)?$"
    r")(?:\s*[:：.\-—]|$)",
    re.IGNORECASE,
)
_PREV_CONTINUATION_RE = re.compile(
    r"^\s*(?:"
    r"\(\s*(?:continued|cont\.?|续|续上页|接上页)\s*\)"
    r"|\[\s*(?:continued|cont\.?|续|续上页|接上页)\s*\]"
    r"|（\s*(?:续|续上页|接上页)\s*）"
    r"|【\s*(?:续证|接上页|续)\s*】"
    r"|continued\s+from\s+(?:the\s+)?previous\s+page\b"
    r"|续证\s*[:：]|接上页\s*[:：]?"
    r")"
    r"|^(?:Proof|Theorem|Lemma|Proposition|Corollary|Definition|Example|Worked\s+Example|Exercise|Solution|Answer(?:\s+Key)?|证明|定理|引理|推论|定义|例题|习题|参考答案|解答|答案)\s*(?:\d+(?:[.\-]\d+)*)?\s*(?:\(\s*(?:continued|cont\.?)\s*\)|（\s*(?:续|接上页|续上页)\s*）)",
    re.IGNORECASE,
)
_NEXT_CONTINUATION_RE = re.compile(
    r"(?:\(\s*(?:to\s+be\s+continued|continued(?:\s+on\s+next\s+page)?)\s*\)|（\s*(?:下接下页|转下页|未完待续)\s*）|\(\s*(?:下接下页|转下页|未完待续)\s*\)|接下页|转下页)\s*$",
    re.IGNORECASE,
)
_PROOF_TERMINATOR_RE = re.compile(r"(?:[□■∎]|Q\.?E\.?D\.?|证毕|证完)\s*[.。]?\s*$", re.IGNORECASE)
_SECTION_SEALED_TERMINATOR_RE = re.compile(r"(?:End\s+of\s+(?:Answers?|Solutions?)|答案完|解答完)\s*[.。]?\s*$", re.IGNORECASE)
_INLINE_SEALED_TERMINATOR_RE = re.compile(r"(?:[□■∎]|End\s+of\s+Answers?|答案完|解答完)\s*[.。]?\s*$", re.IGNORECASE)
_TERMINAL_PUNCTUATION_RE = re.compile(r"[.。!?！？:：;；)）\]】□■∎]\s*$")


@dataclass(frozen=True)
class DiscourseBlock:
    kind: str
    text: str
    page_number: int
    char_start: int | None
    char_end: int | None
    continued_from_prev_page: bool = False
    continues_on_next_page: bool = False
    visibility_hint: str = "public"
    associated_visual_kind: str | None = None
    caption_ref: str | None = None
    raw_char_start: int | None = None
    raw_char_end: int | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "kind": self.kind,
            "text": self.text,
            "page_number": self.page_number,
            "char_start": self.char_start,
            "char_end": self.char_end,
            "continued_from_prev_page": self.continued_from_prev_page,
            "continues_on_next_page": self.continues_on_next_page,
            "visibility_hint": self.visibility_hint,
            "associated_visual_kind": self.associated_visual_kind,
            "caption_ref": self.caption_ref,
            "raw_char_start": self.raw_char_start,
            "raw_char_end": self.raw_char_end,
        }


@dataclass(frozen=True)
class PhysicalPagesExtraction:
    texts_by_page: dict[int, list[str]]
    raw_texts_by_page: dict[int, list[str]]
    public_texts_by_page: dict[int, list[str]]
    sealed_texts_by_page: dict[int, list[str]]
    discourse_blocks_by_page: dict[int, list[DiscourseBlock]]
    visual_kinds_by_page: dict[int, list[str]]


def _normalized_label(node):
    label = getattr(getattr(node, "label", None), "value", getattr(node, "label", None))
    return str(label).lower() if label is not None else None


def _document_fragments(document):
    """PPTX / page-local document extraction; never split a merged item."""
    result = {page: [] for page in document.pages}

    def page_of(item):
        pages = {provenance.page_no for provenance in item.prov}
        if len(pages) != 1 or not pages.issubset(result):
            raise RuntimeError("text/table lacks unambiguous physical-page provenance; pre-merge assembly required")
        return next(iter(pages))

    for item in document.texts:
        text = item.text or ""
        label = _normalized_label(item)
        # Without formula enrichment Docling stores formula content only in orig.
        # This is a whole, single-page item, not a slice of merged provenance.
        if not text and label == "formula":
            text = item.orig or ""
        result[page_of(item)].append((text, label))
    for table in getattr(document, "tables", []):
        result[page_of(table)].append((table.export_to_markdown(doc=document), "table"))
    return result


def _document_texts(document):
    return {page: [text for text, _label in fragments] for page, fragments in _document_fragments(document).items()}


def _assemble_page(conversion, page):
    # Re-run only the rule-based reading-order/serialization stage on ONE page.
    # No layout/OCR/model inference or backend I/O. This keeps ordered text,
    # captions, nested figure/form text and rich tables without copying merged
    # document items into several pages or reimplementing Docling table export.
    from docling.datamodel.document import ConversionResult
    from docling.models.stages.reading_order.readingorder_model import ReadingOrderModel, ReadingOrderOptions

    local = ConversionResult(input=conversion.input, pages=[page], assembled=page.assembled)
    return ReadingOrderModel(ReadingOrderOptions())(local)


def _collect_visual_labels(node, found):
    label = _normalized_label(node)
    if label in ("formula", "table", "picture"):
        found.add(label)
    for child in getattr(node, "children", []):
        _collect_visual_labels(child, found)
    cluster = getattr(node, "cluster", None)
    if cluster is not None:
        _collect_visual_labels(cluster, found)


def _collect_page_fragments(conversion):
    """Collect ordered single-page text fragments and raw visual labels once per conversion."""
    if not hasattr(conversion, "document"):
        fragments = _document_fragments(conversion)
        visual_sets = {page: set() for page in fragments}
        for field in ("texts", "tables", "pictures"):
            for item in getattr(conversion, field, []):
                for provenance in getattr(item, "prov", []):
                    if provenance.page_no in visual_sets:
                        _collect_visual_labels(item, visual_sets[provenance.page_no])
        return list(fragments.keys()), fragments, visual_sets
    if getattr(getattr(conversion, "status", None), "value", None) != "success":
        raise RuntimeError("conversion did not complete every requested page")
    document = conversion.document
    is_pdf = getattr(getattr(conversion, "input", None), "format", None) == "pdf"
    if not conversion.pages and not is_pdf:
        # SimplePipeline (PPTX) produces a document, not page assemblies.
        fragments = _document_fragments(document)
        visual_sets = {page: set() for page in fragments}
        for field in ("texts", "tables", "pictures"):
            for item in getattr(document, field, []):
                for provenance in getattr(item, "prov", []):
                    if provenance.page_no in visual_sets:
                        _collect_visual_labels(item, visual_sets[provenance.page_no])
        return list(fragments.keys()), fragments, visual_sets

    numbers = [page.page_no for page in conversion.pages]
    if not numbers or len(set(numbers)) != len(numbers) or set(numbers) != set(document.pages):
        raise RuntimeError("incomplete physical-page assembly")
    fragments = {}
    visual_sets = {}
    for page in conversion.pages:
        if page.assembled is None:
            raise RuntimeError("missing pre-merge physical-page assembly")
        if any(element.page_no != page.page_no for element in page.assembled.elements):
            raise RuntimeError("assembly element belongs to another physical page")
        local = _document_fragments(_assemble_page(conversion, page))
        if set(local) != {page.page_no}:
            raise RuntimeError("page assembly did not preserve the physical page number")
        fragments.update(local)
        found = set()
        if getattr(getattr(page, "parsed_page", None), "bitmap_resources", []):
            found.add("picture")
        layout = getattr(getattr(page, "predictions", None), "layout", None)
        for cluster in getattr(layout, "clusters", []):
            _collect_visual_labels(cluster, found)
        for element in getattr(getattr(page, "assembled", None), "elements", []):
            _collect_visual_labels(element, found)
        visual_sets[page.page_no] = found
    return numbers, fragments, visual_sets


def _strip_heading_markup(line_text: str) -> str:
    s = _MD_HASH_PREFIX_RE.sub("", line_text.strip())
    m = _MD_WRAPPED_EMPHASIS_RE.match(s)
    if m:
        s = f"{m.group(2)}{m.group(3)}"
    return _MD_EDGE_EMPHASIS_RE.sub("", s).strip()


def _is_titled_non_answer_chapter(stripped: str) -> bool:
    m = _TITLED_CHAPTER_RE.match(stripped)
    if not m:
        return False
    title = m.group("title").strip()
    if not title or re.fullmatch(r"[\d.\-:：—]+", title):
        return False
    return not _ANSWER_TITLE_WORD_RE.search(title)


def _is_section_sealed_exit(stripped: str, frag_label: str | None, is_markdown_heading: bool) -> bool:
    if _MAJOR_NON_ANSWER_HEADING_RE.match(stripped):
        return True
    if _TEXTBOOK_NON_ANSWER_HEADING_RE.match(stripped):
        return True
    if _is_titled_non_answer_chapter(stripped):
        return True
    if _STANDALONE_SOLUTION_HEADING_RE.match(stripped):
        return False
    if (frag_label in _HEADING_LABELS or is_markdown_heading) and not _SECTION_BREAK_RE.match(stripped) and not _EXERCISE_RE.match(stripped) and not _SECTION_SEALED_RE.match(stripped) and not _INLINE_SEALED_ALWAYS_RE.match(stripped) and not _INLINE_SEALED_NON_EXAMPLE_RE.match(stripped) and not re.search(r"(?:\b(?:Answers?|Solutions?|Exercises?|Problems?|Chapters?|Sections?|Parts?)\b|答案|解答|习题|练习|章|节)", stripped, re.IGNORECASE):
        return True
    if (frag_label in _HEADING_LABELS or is_markdown_heading) and re.match(r"^\d+(?:\.\d+)+\s+[A-Z]", stripped) and not _ANSWER_TITLE_WORD_RE.search(stripped):
        return True
    return False


def _caption_visual_kind(caption_text: str, page_visuals: set[str]) -> str | None:
    if _VISUAL_CAPTION_REF_RE.match(caption_text):
        return "picture"
    if _TABLE_CAPTION_REF_RE.match(caption_text):
        return "table"
    lower = caption_text.lower()
    if any(word in lower for word in ("figure", "fig", "chart", "diagram", "graph", "image")) or "图" in caption_text:
        return "picture"
    if "table" in lower or "表" in caption_text:
        return "table"
    if "picture" in page_visuals and "table" not in page_visuals:
        return "picture"
    if "table" in page_visuals and "picture" not in page_visuals:
        return "table"
    if "picture" in page_visuals:
        return "picture"
    if "table" in page_visuals:
        return "table"
    if "formula" in page_visuals:
        return "formula"
    return None


def _is_section_sealed_opener(stripped: str) -> bool:
    if not _SECTION_SEALED_RE.match(stripped):
        return False
    # Inline "Answer Key: text" is inline_sealed unless it is header-only ("Answer Key:" or "Answer Key").
    if _INLINE_WITH_BODY_CHECK_RE.search(stripped):
        return bool(_QUALIFIED_MULTI_SECTION_RE.match(stripped))
    return True


def _classify_segment(line_text: str, frag_label: str | None, page_visuals: set[str], *, in_worked_example: bool, seal_mode: str | None):
    """Return (kind, seal_kind, is_explicit_opener, is_section_break, is_major_non_answer, caption_ref, associated_visual_kind)."""
    raw_trimmed = line_text.strip()
    is_markdown_heading = bool(_MD_HEADING_LINE_RE.match(raw_trimmed))
    stripped = _strip_heading_markup(line_text)
    if frag_label in _FURNITURE_LABELS:
        if _is_section_sealed_opener(stripped):
            return "solution_sealed", "section_sealed", True, False, False, None, None
        return "narrative", None, False, False, False, None, None
    if frag_label == "caption":
        cap_match = _CAPTION_PREFIX_RE.match(stripped)
        cap_ref = (cap_match.group("ref") or cap_match.group("zh_ref")) if cap_match else None
        return "figure_caption", None, True, False, False, cap_ref.strip() if cap_ref else None, _caption_visual_kind(stripped, page_visuals)
    if frag_label in ("table", "formula"):
        return "narrative", None, False, False, False, None, None

    exited_section_seal = False
    if seal_mode == "section_sealed":
        if _is_section_sealed_exit(stripped, frag_label, is_markdown_heading):
            # Re-classify the exiting line cleanly as its true public block kind.
            seal_mode = None
            exited_section_seal = True
        else:
            return "solution_sealed", "section_sealed", False, False, False, None, None

    if in_worked_example and _WORKED_EXAMPLE_INTERNAL_SOLUTION_RE.match(stripped):
        return "worked_example", None, False, False, False, None, None

    if _is_section_sealed_opener(stripped):
        return "solution_sealed", "section_sealed", True, False, False, None, None

    if _INLINE_SEALED_ALWAYS_RE.match(stripped):
        return "solution_sealed", "inline_sealed", True, False, False, None, None

    if not in_worked_example and (_INLINE_SEALED_NON_EXAMPLE_RE.match(stripped) or _STANDALONE_SOLUTION_HEADING_RE.match(stripped)):
        return "solution_sealed", "inline_sealed", True, False, False, None, None

    if _PROOF_RE.match(stripped):
        return "proof", None, True, False, exited_section_seal, None, None
    if _THEOREM_RE.match(stripped):
        return "theorem", None, True, False, True, None, None
    if _DEFINITION_RE.match(stripped):
        return "definition", None, True, False, True, None, None
    if _WORKED_EXAMPLE_RE.match(stripped):
        return "worked_example", None, True, False, True, None, None
    if _EXERCISE_RE.match(stripped):
        return "exercise", None, True, False, exited_section_seal, None, None

    cap_match = _CAPTION_PREFIX_RE.match(stripped)
    if cap_match:
        cap_ref = (cap_match.group("ref") or cap_match.group("zh_ref")).strip()
        return "figure_caption", None, True, False, exited_section_seal, cap_ref, _caption_visual_kind(stripped, page_visuals)

    if is_markdown_heading or frag_label in _HEADING_LABELS or _SECTION_BREAK_RE.match(stripped) or exited_section_seal:
        return "narrative", None, True, True, _is_section_sealed_exit(stripped, frag_label, is_markdown_heading) or exited_section_seal, None, None

    return "narrative", None, False, False, False, None, None


def _iter_page_units(fragments: list[tuple[str, str | None]]):
    """Yield (start, end, text, label, is_frag_start) in exact page_text = '\\n'.join(...) coordinates."""
    offset = 0
    for frag_index, (frag_text, frag_label) in enumerate(fragments):
        if frag_label in ("table", "formula") or "\n" not in frag_text:
            yield offset, offset + len(frag_text), frag_text, frag_label, True
        else:
            cursor = offset
            for line_idx, part in enumerate(frag_text.splitlines(keepends=True)):
                line = part.rstrip("\r\n")
                yield cursor, cursor + len(line), line, frag_label, line_idx == 0
                cursor += len(part)
            if frag_text.endswith(("\n", "\r")):
                yield offset + len(frag_text), offset + len(frag_text), "", frag_label, False
        offset += len(frag_text)
        if frag_index + 1 < len(fragments):
            offset += 1  # '\n' joiner


def _build_page_blocks(page_number: int, fragments: list[tuple[str, str | None]], page_visuals: set[str], *, initial_in_worked_example: bool = False):
    page_text = "\n".join(text for text, _ in fragments)
    blocks = []
    # Track tuple entries: (block_index, is_furniture, explicit_opener, seal_mode, is_section_exit)
    entries = []
    current = None  # [kind, start, end, visual_kind, caption_ref, is_furniture, explicit_opener, seal_mode, is_section_exit]
    page_seal_mode: str | None = None
    in_worked_example = initial_in_worked_example

    def flush():
        nonlocal current
        if current is None:
            return
        kind, start, end, visual_kind, caption_ref, is_furniture, explicit_opener, seal_mode, is_section_exit = current
        text = page_text[start:end]
        if text.strip():
            continued_prev = kind != "figure_caption" and bool(_PREV_CONTINUATION_RE.search(text[:120]))
            block = DiscourseBlock(
                kind=kind,
                text=text,
                page_number=page_number,
                char_start=start,
                char_end=end,
                continued_from_prev_page=continued_prev,
                continues_on_next_page=False,
                visibility_hint=VISIBILITY_BY_KIND[kind],
                associated_visual_kind=visual_kind,
                caption_ref=caption_ref,
                raw_char_start=start,
                raw_char_end=end,
            )
            blocks.append(block)
            entries.append((len(blocks) - 1, is_furniture, explicit_opener, seal_mode, is_section_exit))
        current = None

    for unit_start, unit_end, unit_text, frag_label, is_frag_start in _iter_page_units(fragments):
        if not unit_text.strip():
            if is_frag_start:
                # Empty fragments are omitted from sealed public_texts; do not merge blocks across them.
                flush()
            elif current is not None and current[0] == "figure_caption":
                flush()
            elif current is not None and current[7] == "inline_sealed":
                flush()
                page_seal_mode = None
            continue

        is_furniture = frag_label in _FURNITURE_LABELS
        active_seal = current[7] if current is not None else page_seal_mode
        kind, seal_kind, explicit_opener, section_break, major_non_answer, cap_ref, assoc_visual = _classify_segment(
            unit_text,
            frag_label,
            page_visuals,
            in_worked_example=in_worked_example,
            seal_mode=active_seal,
        )

        if is_furniture:
            flush()
            current = [kind, unit_start, unit_end, None, None, True, explicit_opener, seal_kind, False]
            flush()
            if seal_kind == "section_sealed":
                page_seal_mode = "section_sealed"
                in_worked_example = False
            continue

        # Update worked_example context on explicit non-example transitions.
        if explicit_opener or section_break:
            in_worked_example = kind == "worked_example"
            page_seal_mode = seal_kind

        if current is None:
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, False, explicit_opener, seal_kind, major_non_answer]
            continue

        prev_kind = current[0]
        prev_seal = current[7]
        prev_text = page_text[current[1]:current[2]]

        if prev_seal == "section_sealed" and not (explicit_opener or section_break):
            current[2] = unit_end
            if _SECTION_SEALED_TERMINATOR_RE.search(unit_text):
                flush()
                page_seal_mode = None
            continue

        if explicit_opener or section_break:
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, False, explicit_opener, seal_kind, major_non_answer]
            continue

        # Continuation within the same page under an open block.
        if prev_kind == "figure_caption":
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, False, explicit_opener, seal_kind, major_non_answer]
            continue
        if prev_kind == "proof" and _PROOF_TERMINATOR_RE.search(prev_text):
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, False, explicit_opener, seal_kind, major_non_answer]
            continue
        if prev_seal == "inline_sealed" and _INLINE_SEALED_TERMINATOR_RE.search(prev_text):
            flush()
            page_seal_mode = None
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, False, explicit_opener, seal_kind, major_non_answer]
            continue

        # Merge unmarked continuation line/table/formula into the active block.
        current[2] = unit_end
        if prev_seal == "inline_sealed" and _INLINE_SEALED_TERMINATOR_RE.search(unit_text):
            flush()
            page_seal_mode = None

    flush()
    return page_text, blocks, entries, in_worked_example


def _is_next_page_section_exit(block: DiscourseBlock) -> bool:
    raw_trimmed = block.text.strip()
    is_markdown_heading = bool(_MD_HEADING_LINE_RE.match(raw_trimmed))
    first_line = raw_trimmed.splitlines()[0] if raw_trimmed else ""
    stripped = _strip_heading_markup(first_line)
    return _is_section_sealed_exit(stripped, None, is_markdown_heading)


def _apply_cross_page_continuations(page_order, blocks_by_page, entries_by_page):
    for index, page_number in enumerate(page_order):
        blocks = blocks_by_page[page_number]
        entries = entries_by_page[page_number]
        substantive = [(idx, seal_mode) for idx, is_furniture, _explicit, seal_mode, _exit in entries if not is_furniture]
        if not substantive:
            # Check if furniture activated section_sealed for this page even with no body blocks.
            furniture_sealed = any(seal_mode == "section_sealed" for _idx, is_furniture, _exp, seal_mode, _exit in entries if is_furniture)
            if furniture_sealed and index + 1 < len(page_order) and page_order[index + 1] == page_number + 1:
                next_page = page_order[index + 1]
                _propagate_section_seal_to_page(blocks_by_page[next_page], entries_by_page[next_page])
            continue
        last_idx, last_seal_mode = substantive[-1]
        last_block = blocks[last_idx]
        explicit_next = bool(_NEXT_CONTINUATION_RE.search(last_block.text)) or (
            last_block.kind == "narrative" and last_block.text.endswith(("-", "\u00ad"))
        )
        mid_sentence = not _TERMINAL_PUNCTUATION_RE.search(last_block.text)
        has_next_adjacent = index + 1 < len(page_order) and page_order[index + 1] == page_number + 1

        sealed_closed = (
            last_seal_mode == "section_sealed" and bool(_SECTION_SEALED_TERMINATOR_RE.search(last_block.text))
        ) or (
            last_seal_mode == "inline_sealed" and bool(_INLINE_SEALED_TERMINATOR_RE.search(last_block.text))
        )

        if not has_next_adjacent:
            if explicit_next or (
                last_block.kind == "proof" and not _PROOF_TERMINATOR_RE.search(last_block.text)
            ) or (
                last_block.kind == "solution_sealed" and not sealed_closed and (last_seal_mode == "section_sealed" or mid_sentence)
            ) or (
                last_block.kind in _CONTINUABLE_KINDS and last_block.kind not in ("proof", "solution_sealed") and mid_sentence
            ):
                blocks[last_idx] = replace(last_block, continues_on_next_page=True)
            continue

        next_page = page_order[index + 1]
        next_blocks = blocks_by_page[next_page]
        next_entries = entries_by_page[next_page]
        next_substantive = [(idx, explicit, section_exit) for idx, is_furniture, explicit, _seal, section_exit in next_entries if not is_furniture]
        if not next_substantive:
            continue

        first_idx, first_explicit, first_section_exit = next_substantive[0]
        first_block = next_blocks[first_idx]
        prev_block = blocks[last_idx]
        exits_section_seal = first_section_exit or _is_next_page_section_exit(first_block)

        continues = explicit_next or first_block.continued_from_prev_page
        inherit_kind = False

        if not continues:
            if prev_block.kind == "proof" and not _PROOF_TERMINATOR_RE.search(prev_block.text):
                if not first_explicit or (first_block.kind == "proof" and first_block.continued_from_prev_page):
                    continues = True
                    inherit_kind = not first_explicit
            elif prev_block.kind == "solution_sealed" and not sealed_closed:
                if last_seal_mode == "section_sealed":
                    if not exits_section_seal:
                        continues = True
                        inherit_kind = True
                elif not first_explicit and mid_sentence:
                    continues = True
                    inherit_kind = True
            elif prev_block.kind in ("definition", "theorem", "worked_example", "exercise") and mid_sentence and not first_explicit:
                continues = True
                inherit_kind = True
            elif prev_block.kind == "narrative" and prev_block.text.endswith(("-", "\u00ad")):
                continues = True

        if continues:
            blocks[last_idx] = replace(prev_block, continues_on_next_page=True)
            if last_seal_mode == "section_sealed" and prev_block.kind == "solution_sealed" and not exits_section_seal:
                _propagate_section_seal_to_page(next_blocks, next_entries, mark_first_continued=True)
            elif inherit_kind or (not first_explicit and prev_block.kind in _CONTINUABLE_KINDS and first_block.kind == "narrative"):
                target_kind = prev_block.kind
                next_blocks[first_idx] = replace(
                    first_block,
                    kind=target_kind,
                    visibility_hint=VISIBILITY_BY_KIND[target_kind],
                    continued_from_prev_page=True,
                )
            else:
                next_blocks[first_idx] = replace(first_block, continued_from_prev_page=True)


def _propagate_section_seal_to_page(next_blocks, next_entries, *, mark_first_continued: bool = False):
    first_marked = False
    for i, entry in enumerate(next_entries):
        idx, is_furniture, _explicit, _seal_mode, section_exit = entry
        if is_furniture:
            continue
        block = next_blocks[idx]
        if section_exit or _is_next_page_section_exit(block):
            break
        next_blocks[idx] = replace(
            block,
            kind="solution_sealed",
            visibility_hint="sealed",
            continued_from_prev_page=block.continued_from_prev_page or (mark_first_continued and not first_marked),
        )
        next_entries[i] = (idx, is_furniture, False, "section_sealed", section_exit)
        first_marked = True
        if _SECTION_SEALED_TERMINATOR_RE.search(block.text):
            break


def _filter_fragments_by_visibility(fragments: list[tuple[str, str | None]], blocks: list[DiscourseBlock], *, sealed_only: bool) -> list[str]:
    if not blocks:
        return [] if sealed_only else [text for text, _ in fragments]
    sealed_spans = [
        (b.raw_char_start if b.raw_char_start is not None else b.char_start, b.raw_char_end if b.raw_char_end is not None else b.char_end)
        for b in blocks
        if b.kind == "solution_sealed" or b.visibility_hint == "sealed"
    ]
    sealed_spans = [(s, e) for s, e in sealed_spans if s is not None and e is not None]
    if not sealed_spans:
        return [] if sealed_only else [text for text, _ in fragments]

    kept: list[str] = []
    offset = 0
    for frag_index, (frag_text, _frag_label) in enumerate(fragments):
        frag_start = offset
        frag_end = frag_start + len(frag_text)
        offset = frag_end + (1 if frag_index + 1 < len(fragments) else 0)

        if not frag_text.strip():
            continue

        if sealed_only:
            for s_start, s_end in sealed_spans:
                ov_start = max(frag_start, s_start)
                ov_end = min(frag_end, s_end)
                if ov_start < ov_end:
                    part = frag_text[ov_start - frag_start:ov_end - frag_start].strip("\r\n")
                    if part.strip():
                        kept.append(part)
        else:
            cursor = frag_start
            parts: list[str] = []
            for s_start, s_end in sealed_spans:
                if s_end <= frag_start or s_start >= frag_end:
                    continue
                if cursor < s_start:
                    parts.append(frag_text[cursor - frag_start:s_start - frag_start])
                cursor = max(cursor, s_end)
            if cursor < frag_end:
                parts.append(frag_text[cursor - frag_start:frag_end - frag_start])
            cleaned = "".join(parts).strip("\r\n")
            if cleaned.strip():
                kept.append(cleaned)
    return kept


def _compute_visual_kinds(conversion, by_page, page_order, visual_sets, raw_fragments):
    kinds = {number: set(visual_sets.get(number, ())) for number in by_page}
    physical = getattr(conversion, "pages", []) if hasattr(conversion, "document") else []

    for page in physical:
        number = page.page_no
        if number not in kinds:
            raise RuntimeError("visual metadata belongs to another physical page")
        found = kinds[number]
        cells = getattr(page, "cells", None)
        raw_texts = [text for text, _ in raw_fragments.get(number, ())]
        has_any_text = bool("\n".join(by_page[number]).strip()) or bool("\n".join(raw_texts).strip())
        all_sealed_only = not "\n".join(by_page[number]).strip() and bool("\n".join(raw_texts).strip())
        if all_sealed_only:
            found.clear()
            continue
        native = any((getattr(cell, "text", None) or "").strip() and not getattr(cell, "from_ocr", False) for cell in cells) if cells is not None else has_any_text
        has_ocr = any((getattr(cell, "text", None) or "").strip() and getattr(cell, "from_ocr", False) for cell in cells) if cells is not None else False
        if not native or has_ocr:
            found.add("scan")

    if not physical:
        for number, texts in by_page.items():
            raw_texts = [text for text, _ in raw_fragments.get(number, ())]
            has_sealed_only = not "\n".join(texts).strip() and bool("\n".join(raw_texts).strip())
            if has_sealed_only:
                kinds[number].clear()
            elif not "\n".join(texts).strip():
                kinds[number].add("scan")

    order = ("scan", "formula", "table", "picture")
    return {number: [kind for kind in order if kind in found] for number, found in kinds.items()}


def _align_block_charspans(blocks: list[DiscourseBlock], page_public_text: str, *, include_sealed: bool) -> list[DiscourseBlock]:
    if include_sealed:
        return blocks
    aligned: list[DiscourseBlock] = []
    public_cursor = 0
    for block in blocks:
        if block.kind == "solution_sealed" or block.visibility_hint == "sealed":
            aligned.append(replace(block, char_start=None, char_end=None))
            continue
        pos = page_public_text.find(block.text, public_cursor)
        if pos >= 0:
            end = pos + len(block.text)
            public_cursor = end
            aligned.append(replace(block, char_start=pos, char_end=end))
        else:
            aligned.append(replace(block, char_start=None, char_end=None))
    return aligned


def _seal_furniture_on_all_sealed_page(blocks: list[DiscourseBlock], entries: list[tuple[int, bool, bool, str | None, bool]]) -> list[DiscourseBlock]:
    has_sealed = any(b.kind == "solution_sealed" or b.visibility_hint == "sealed" for b in blocks)
    if not has_sealed:
        return blocks
    has_public_body = any(
        not is_furniture and blocks[idx].kind != "solution_sealed" and blocks[idx].visibility_hint != "sealed"
        for idx, is_furniture, _exp, _seal, _exit in entries
    )
    if has_public_body:
        return blocks
    updated = list(blocks)
    for idx, is_furniture, _exp, _seal, _exit in entries:
        if is_furniture and updated[idx].visibility_hint != "sealed":
            updated[idx] = replace(updated[idx], kind="solution_sealed", visibility_hint="sealed")
    return updated


def extract_physical_pages(conversion, *, include_sealed: bool = False) -> PhysicalPagesExtraction:
    page_order, raw_fragments, visual_sets = _collect_page_fragments(conversion)
    blocks_by_page: dict[int, list[DiscourseBlock]] = {}
    entries_by_page = {}
    in_worked_example = False
    prev_page_number: int | None = None
    for page_number in page_order:
        if prev_page_number is not None and page_number != prev_page_number + 1:
            in_worked_example = False
        _page_text, blocks, entries, in_worked_example = _build_page_blocks(
            page_number,
            raw_fragments[page_number],
            visual_sets.get(page_number, set()),
            initial_in_worked_example=in_worked_example,
        )
        blocks_by_page[page_number] = blocks
        entries_by_page[page_number] = entries
        prev_page_number = page_number

    _apply_cross_page_continuations(page_order, blocks_by_page, entries_by_page)

    raw_texts = {p: [t for t, _ in raw_fragments[p]] for p in page_order}
    public_texts: dict[int, list[str]] = {}
    sealed_texts: dict[int, list[str]] = {}
    for page_number in page_order:
        frags = raw_fragments[page_number]
        blocks = _seal_furniture_on_all_sealed_page(blocks_by_page[page_number], entries_by_page[page_number])
        public_texts[page_number] = _filter_fragments_by_visibility(frags, blocks, sealed_only=False)
        sealed_texts[page_number] = _filter_fragments_by_visibility(frags, blocks, sealed_only=True)
        blocks_by_page[page_number] = _align_block_charspans(
            blocks,
            "\n".join(public_texts[page_number]),
            include_sealed=include_sealed,
        )

    selected_texts = raw_texts if include_sealed else public_texts
    visuals = _compute_visual_kinds(conversion, selected_texts, page_order, visual_sets, raw_fragments)
    return PhysicalPagesExtraction(
        texts_by_page=selected_texts,
        raw_texts_by_page=raw_texts,
        public_texts_by_page=public_texts,
        sealed_texts_by_page=sealed_texts,
        discourse_blocks_by_page=blocks_by_page,
        visual_kinds_by_page=visuals,
    )


def discourse_blocks_by_page(conversion, *, include_sealed: bool = False) -> dict[int, list[DiscourseBlock]]:
    """Extract ordered, single-page academic discourse blocks with exact in-page charspans."""
    return extract_physical_pages(conversion, include_sealed=include_sealed).discourse_blocks_by_page


def texts_by_page(conversion, *, include_sealed: bool = False):
    """Return physical-page text fragments, sealing solution_sealed blocks by default."""
    return extract_physical_pages(conversion, include_sealed=include_sealed).texts_by_page


def _element_has_raw_content(element) -> bool:
    if (getattr(element, "text", None) or "").strip():
        return True
    if (getattr(element, "orig", None) or "").strip():
        return True
    if getattr(element, "table_cells", None):
        return True
    cluster = getattr(element, "cluster", None)
    if cluster is not None and getattr(cluster, "cells", None):
        return any((getattr(cell, "text", None) or "").strip() for cell in cluster.cells)
    return False


def visual_kinds_by_page(conversion, by_page):
    """Use retained physical layout and text-layer cells, never symbol guessing.

    OCR output is not evidence of a native text layer: scanned pages still need
    faithful visual transcription even when local OCR emitted plausible words.
    """
    kinds = {number: set() for number in by_page}

    physical = getattr(conversion, "pages", []) if hasattr(conversion, "document") else []
    for page in physical:
        number = page.page_no
        if number not in kinds:
            raise RuntimeError("visual metadata belongs to another physical page")
        found = kinds[number]
        cells = getattr(page, "cells", None)
        assembled_elements = getattr(getattr(page, "assembled", None), "elements", [])
        raw_non_empty = any(_element_has_raw_content(el) for el in assembled_elements)
        public_empty = not "\n".join(by_page[number]).strip()
        if public_empty and raw_non_empty:
            # Entire page was text/table that got sealed (solution_sealed); never re-transcribe via scan/vision.
            continue
        native = any((getattr(cell, "text", None) or "").strip() and not getattr(cell, "from_ocr", False)
                     for cell in cells) if cells is not None else (not public_empty or raw_non_empty)
        has_ocr = any((getattr(cell, "text", None) or "").strip() and getattr(cell, "from_ocr", False)
                      for cell in cells) if cells is not None else False
        if not native or has_ocr:
            found.add("scan")
        # Cluster cell assignment is not text-layer coverage: overlapping text
        # clusters can be empty after cells move to a containing layout region.
        # Actual embedded images retain mixed scanned bodies even if layout
        # labels their content as text and local OCR is disabled.
        if getattr(getattr(page, "parsed_page", None), "bitmap_resources", []):
            found.add("picture")
        layout = getattr(getattr(page, "predictions", None), "layout", None)
        for cluster in getattr(layout, "clusters", []):
            _collect_visual_labels(cluster, found)
        for element in assembled_elements:
            _collect_visual_labels(element, found)

    if not physical:
        document = getattr(conversion, "document", conversion)
        sealed_only_pages = set()
        for number, texts in by_page.items():
            if not "\n".join(texts).strip():
                has_doc_text = any(
                    ((getattr(item, "text", None) or "").strip() or (getattr(item, "orig", None) or "").strip())
                    and any(getattr(p, "page_no", None) == number for p in getattr(item, "prov", []))
                    for item in getattr(document, "texts", [])
                ) or any(
                    any(getattr(p, "page_no", None) == number for p in getattr(tbl, "prov", []))
                    for tbl in getattr(document, "tables", [])
                )
                if has_doc_text:
                    sealed_only_pages.add(number)
                else:
                    kinds[number].add("scan")
        for field in ("texts", "tables", "pictures"):
            for item in getattr(document, field, []):
                for provenance in getattr(item, "prov", []):
                    if provenance.page_no in kinds and provenance.page_no not in sealed_only_pages:
                        _collect_visual_labels(item, kinds[provenance.page_no])
    order = ("scan", "formula", "table", "picture")
    return {number: [kind for kind in order if kind in found] for number, found in kinds.items()}
