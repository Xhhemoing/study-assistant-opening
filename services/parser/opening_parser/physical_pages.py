"""Physical-page text and academic discourse extraction from Docling pre-merge assemblies.

ReadingOrderModel 2.126.0 changes text when joining hyphenated continuations
without fixing provenance charspans. Neither merged text nor orig is sliceable
by those spans. ConversionResult.pages still holds the original page elements.
"""

from dataclasses import dataclass, field, replace
from inspect import signature
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

# Standalone assessment headings can open a seal across physical pages.
_SEALED_SECTION_CONTAINER = r"(?:Appendix\b(?:\s+[A-Z0-9]+)?|Chapter\s+\d+|Section\s+\d+(?:\.\d+)*|(?:Lecture|Part|Unit)\s+(?:\d+|[IVXLCDM]+)|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])|附录(?:\s*[A-Z0-9一二三四五六七八九十]+)?)"
_SEALED_CONTAINER_PREFIX = rf"(?:{_SEALED_SECTION_CONTAINER}(?:\s*[:：.\-—–]\s*|\s+)|附录)"
_SEALED_HEADING_CONTINUATION = r"(?:\s*\(\s*(?:continued|cont(?:['’]?d)?\.?)\s*\))?"
_ASSESSMENT_NUMBER = r"#?\d+(?:\.\d+)*"
_ASSESSMENT_TARGET = rf"(?:\s+{_ASSESSMENT_NUMBER}(?:(?:\s*[-–—]\s*|\s+(?:to|through)\s+){_ASSESSMENT_NUMBER})?)?"
_ASSESSMENT_ANSWER_HEADING = (
    r"(?:Answers?|Solutions?|Key)\s+to\s+"
    r"(?:(?:Selected|Odd-Numbered|Even-Numbered|All|the|Chapter\s+\d+|Section\s+\d+(?:\.\d+)*)\s+)*"
    rf"(?:(?:Exercises?|Problems?|Questions?|Review\s+Questions?|Practice\s+Problems?|Self[- ]Check\s+Exercises?){_ASSESSMENT_TARGET}|Chapter\s+\d+|Section\s+\d+(?:\.\d+)*)"
)
_QUALIFIED_ANSWER_SECTION = r"(?:(?:Selected|Odd-Numbered|Even-Numbered)\s+Answers?|Model\s+Answers|(?:Official|Reference)\s+Solutions|Solutions?\s+Manual|Answers?\s+and\s+Solutions?)"
_CONTAINER_SEALED_HEADING = (
    rf"{_SEALED_CONTAINER_PREFIX}(?:(?:Answers?\s+Key|"
    r"(?:(?:Model|Selected|Official|Reference|Correct|Sample|Odd-Numbered|Even-Numbered)\s+)?(?:Answers?|Solutions?))"
    rf"{_SEALED_HEADING_CONTINUATION}"
    r"|(?:参考答案与解析|参考答案|标准答案|课后习题答案|课后练习答案|课后答案|课后解答|习题答案|习题解答|练习答案|练习解答|思考题答案|部分习题答案|答案与解析|参考解答|详细解答|答案|解答)"
    r"(?:\s*[（(](?:续|接上页)[）)])?)\s*(?:[:：]|$)"
)

_SECTION_SEALED_RE = re.compile(
    r"^(?:"
    rf"(?:{_SEALED_SECTION_CONTAINER}\s*[:：.\-—–]?\s*)?"
    rf"(?:(?:Answers?\s+Key|{_ASSESSMENT_ANSWER_HEADING}|{_QUALIFIED_ANSWER_SECTION}|Answer\s+Section|Answers){_SEALED_HEADING_CONTINUATION}\s*(?:[:：]|$)"
    r"|【\s*(?:参考答案|标准答案|习题答案|习题解答|练习答案|练习解答|课后答案|课后练习答案|课后习题答案|课后解答|思考题答案|答案与解析|参考解答|详细解答|参考答案与解析|部分习题答案)\s*】\s*$"
    r"|(?:参考答案与解析|参考答案|标准答案|课后习题答案|课后练习答案|课后答案|课后解答|习题答案|习题解答|练习答案|练习解答|思考题答案|部分习题答案|答案与解析|参考解答|详细解答)(?:\s*(?:（续）|\(续\)|（接上页）|\(接上页\)))?\s*(?:[:：]|$)"
    r"|(?:习题\s*)?(?:答案|解答)(?:\s*(?:（续）|\(续\)|（接上页）|\(接上页\)))?\s*(?:[:：]|$)"
    r")"
    rf"|{_CONTAINER_SEALED_HEADING}"
    r")",
    re.IGNORECASE,
)
_INLINE_WITH_BODY_CHECK_RE = re.compile(r"[:：]\s*\S")
_QUALIFIED_MULTI_SECTION_RE = re.compile(
    rf"^(?:(?:{_SEALED_SECTION_CONTAINER}\s*[:：.\-—–]?\s*)?"
    rf"(?:{_ASSESSMENT_ANSWER_HEADING}|{_QUALIFIED_ANSWER_SECTION}|"
    r"参考答案与解析|答案与解析|课后习题答案|课后练习答案|课后答案|课后解答|练习答案|练习解答|习题答案|习题解答|思考题答案|部分习题答案)"
    rf"|{_CONTAINER_SEALED_HEADING})",
    re.IGNORECASE,
)

_QUALIFIED_ANSWER_LABEL = r"(?:(?:Official|Model|Correct|Sample|Reference)\s+[Aa]nswer|(?:OFFICIAL|MODEL|CORRECT|SAMPLE|REFERENCE)\s+ANSWER)"
_ENGLISH_SOLUTION_LABEL = r"(?:(?:Worked|Full|Sample|Official|Reference)\s+[Ss]olutions?|(?:WORKED|FULL|SAMPLE|OFFICIAL|REFERENCE)\s+SOLUTIONS?|Solutions?|SOLUTIONS?)"
_CONTINUED_LABEL = r"(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?"

# Single-item answers use a colon or a standalone qualified heading.
_INLINE_SEALED_ALWAYS_RE = re.compile(
    r"^(?:"
    rf"(?:Answer\s+[Kk]ey|ANSWER\s+KEY|Answers?|ANSWERS?)(?:\s+\d+(?:\.\d+)*)?{_CONTINUED_LABEL}\s*[:：]"
    rf"|{_QUALIFIED_ANSWER_LABEL}(?:\s+\d+(?:\.\d+)*)?{_CONTINUED_LABEL}\s*(?:[:：]|$)"
    r"|【\s*(?:参考答案|标准答案|正确答案|答案)\s*】"
    r"|(?:参考答案与解析|参考答案|标准答案|正确答案|课后习题答案|课后练习答案|课后答案|练习答案|习题答案|思考题答案|部分习题答案|答案与解析|答案)\s*(?:\d+(?:[.\-]\d+)*)?\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*[:：]"
    r")"
)

# Inline solution/proof markers sealed ONLY outside worked_example context.
_INLINE_SEALED_NON_EXAMPLE_RE = re.compile(
    r"^(?:"
    rf"{_ENGLISH_SOLUTION_LABEL}(?:\s+(?:to|TO)\s+(?:Exercise|EXERCISE|Problem|PROBLEM|Question|QUESTION)\s*\d*(?:\.\d+)*)?(?:\s+\d+(?:\.\d+)*)?{_CONTINUED_LABEL}\s*[:：]"
    r"|【\s*(?:参考解答|详细解答|解答|详解|解析)\s*】"
    r"|(?:参考解答|详细解答|解答|详解|解析|解)\s*(?:\d+(?:[.\-]\d+)*)?\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*[:：]"
    r")"
)
_STANDALONE_SOLUTION_HEADING_RE = re.compile(
    rf"^(?!(?:Solutions|SOLUTIONS)\b)(?:{_ENGLISH_SOLUTION_LABEL}|解答|详细解答|参考解答|解析|详解){_CONTINUED_LABEL}\s*$"
)

_WORKED_EXAMPLE_INTERNAL_SOLUTION_RE = re.compile(
    r"^(?:"
    rf"(?!(?:(?:Official|Reference)\s+[Ss]olutions|(?:OFFICIAL|REFERENCE)\s+SOLUTIONS|Solutions|SOLUTIONS)\b)"
    rf"(?:{_ENGLISH_SOLUTION_LABEL}|Proof|PROOF){_CONTINUED_LABEL}\s*(?:[:：]|\.(?:\s|$)|$)"
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
    rf"^(?:{_SEALED_SECTION_CONTAINER}(?:\s*[:：.\-—–]\s*|\s+))?"
    r"(?:"
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
    r"(?:Chapter|Section|Part|Unit)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)(?:\b|$)"
    r"|(?:Appendix\s+[A-Z0-9]+|Lecture\s+(?:\d+|[IVXLCDM]+))(?:\b|$)"
    r"|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课])"
    r"|附录\s*[A-Z0-9一二三四五六七八九十]+(?:\s*[:：.\-—]|$|\s+\S)"
    r"|\d+(?:\.\d+)+\s+\S"
    r")",
    re.IGNORECASE,
)
_NUMBERED_CONTAINER_PREFIX_RE = re.compile(
    r"^(?:(?:(?:Chapter|Part|Unit|Lecture|Lesson|Module)\s+(?:\d+(?:\.\d+)*|[IVXLCDM]+)|Section\s+\d+(?:\.\d+)*)(?=[\s:：.．—–-]|$)"
    r"|第\s*[一二三四五六七八九十百千\d]+\s*(?:部分|单元|章节|讲义|专题|模块|[章节讲部篇卷册课]))",
    re.IGNORECASE,
)
_PAGE_METADATA_HEADING_RE = re.compile(
    r"^(?:[\[【(]\s*)?(?:(?:(?:scanned|physical|printed|pdf)\s+)*(?:pages?|slides?)\b|(?:p|pp)\.\s*\d"
    r"|(?:(?:cached|raw|readable|verified|automatic)\s+)*(?:transcription|ocr)\b"
    r"|(?:第\s*)?[\d一二三四五六七八九十百千]+(?:\s*(?:[/／\-–—]|共)\s*(?:第\s*)?[\d一二三四五六七八九十百千]+)?\s*[页頁张張]"
    r"|\d+\s*(?:of|[/／\-–—])\s*\d+\s*[.)。]?$|原图忠实转写|视觉转写与描述|原生提取|本地提取|图表观察描述|识别不确定)",
    re.IGNORECASE,
)
_RUNNING_COUNTER_RE = re.compile(
    r"(?:^[(（\[]?\s*(?:\d+(?:\.\d+)*|[ivxlcdm]{1,8})\s*[)）\].．、]?$"
    r"|[(（\[]\s*(?:(?:pages?|slides?)\s+\d+|pp?\.\s*\d+|第\s*\d+\s*[页頁])(?:\s*(?:of|[/／–-])\s*\d+)?\s*[)）\]]"
    r"|(?:\s|[:：—–-]\s*)(?:(?:pages?|slides?)\s+\d+|pp?\.\s*\d+|第\s*\d+\s*[页頁])(?:\s*(?:of|[/／–-])\s*\d+)?\s*[.。]?$)",
    re.IGNORECASE,
)
_OCR_PLACEHOLDER_RE = re.compile(
    r"^[\[【(（]\s*(?:illegible|unreadable|blank|unclear|ocr|no\s+(?:readable\s+)?text|无法识别|无法辨认|空白页"
    r"|图片描述|图像描述|图示与版面描述|不确定处)(?=[\s\]】)）：:]|$)",
    re.IGNORECASE,
)
_CONTINUATION_HEADING_RE = re.compile(
    r"\b(?:continued|cont(?:['’]?d)?)(?:\s+(?:from|on)\s+.+)?[.\s:：]*$"
    r"|[\[（(【]\s*(?:(?:to\s+be\s+)?continued|cont(?:['’]?d)?\.?|续|续上页|接上页)\s*[)\]）】]"
    r"|(?:接上页|续上页|\s续)\s*[:：.]?$",
    re.IGNORECASE,
)
_ANSWER_TITLE_WORD_RE = re.compile(
    r"\b(?:Answers?|Solutions?|Exercises?|Problems?|Questions?|Review|Practice|Quiz|Drills?|Self-Check"
    r"|Homework|Assignments?|Problem\s*Sets?|Worksheets?|Tutorials?|Recitations?|Labs?)\b"
    r"|答案|解答|习题|练习|思考题|复习题|自测题|作业|课后题|单元测试",
    re.IGNORECASE,
)
_TEXTBOOK_NON_ANSWER_HEADING_RE = re.compile(
    r"^(?:"
    r"(?:Definition|Notation|Terminology|Convention|Theorem|Lemma|Proposition|Corollary|Axiom|Conjecture|Claim|Worked\s+Example|Example)\b"
    r"|(?:定义|记号|约定|定理|引理|推论|命题|公理|猜想|例题|例\s*\d+|例\s*[:：])"
    r")"
)
_MAJOR_NON_ANSWER_HEADING_RE = re.compile(
    r"^(?:"
    r"(?:Bibliography|References|Works\s+Cited|Index|Subject\s+Index|Author\s+Index|Glossary|Notation\s+Index"
    r"|Acknowledg(?:e)?ments?|About\s+the\s+Authors?|Afterword|Colophon|参考文献|索引|名词索引|主题索引|符号表|词汇表|后记|致谢)"
    r"(?:\s*[:：.\-—–]|$)"
    r"|(?:Appendix(?:\s+[A-Z0-9]+)?|附录(?:\s*[A-Z0-9一二三四五六七八九十]+)?)"
    r"(?:\s*[:：.\-—–]\s*(?!.*(?:\b(?:Answers?|Solutions?|Keys?)\b|答案|解答)).*)?$"
    r")",
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
_BARE_ANSWER_LABEL_RE = re.compile(r"^(?:答案|解答)\s*[:：]$")
_MODEL_ANSWER_LABEL_RE = re.compile(
    r"^(?:Model\s+[Aa]nswer|MODEL\s+ANSWER)(?:\s+\d+(?:\.\d+)*)?"
    r"(?:\s*\(\s*(?:continued|cont\.?|CONTD?\.?|CONTINUED)\s*\))?\s*[:：]"
)
_TERMINAL_PUNCTUATION_RE = re.compile(r"[.。!?！？;；)）\]】□■∎]\s*$")


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
    section_sealed_by_page: dict[int, bool] = field(default_factory=dict)
    inline_sealed_by_page: dict[int, bool] = field(default_factory=dict)
    had_sealed_by_page: dict[int, bool] = field(default_factory=dict)
    in_worked_example_by_page: dict[int, bool] = field(default_factory=dict)


def _normalized_label(node):
    label = getattr(getattr(node, "label", None), "value", getattr(node, "label", None))
    return str(label).lower() if label is not None else None


def _item_sort_key(item, kind_bucket: int):
    for attr in ("reading_order", "order"):
        order_val = getattr(item, attr, None)
        if isinstance(order_val, (int, float)):
            return (0, float(order_val), 0.0, kind_bucket)
    bbox = None
    prov = getattr(item, "prov", None) or ()
    if prov:
        bbox = getattr(prov[0], "bbox", None)
    if bbox is None:
        bbox = getattr(getattr(item, "cluster", None), "bbox", None)
    top = getattr(bbox, "t", None) if bbox is not None else None
    left = getattr(bbox, "l", 0.0) if bbox is not None else 0.0
    if isinstance(top, (int, float)):
        return (1, float(top), float(left) if isinstance(left, (int, float)) else 0.0, kind_bucket)
    return (2, 0.0, 0.0, kind_bucket)


def _iterate_document_items(iterate):
    try:
        signature(iterate).bind_partial(included_content_layers=None)
    except (TypeError, ValueError):
        return iterate()
    from docling_core.types.doc import ContentLayer

    return iterate(included_content_layers={ContentLayer.BODY, ContentLayer.FURNITURE})


def _document_fragments(document):
    """PPTX / page-local document extraction; never split a merged item."""
    result = {page: [] for page in document.pages}

    def page_of(item):
        pages = {provenance.page_no for provenance in item.prov}
        if len(pages) != 1 or not pages.issubset(result):
            raise RuntimeError("text/table lacks unambiguous physical-page provenance; pre-merge assembly required")
        return next(iter(pages))

    def text_fragment(item):
        text = getattr(item, "text", None) or ""
        label = _normalized_label(item)
        # Without formula enrichment Docling stores formula content only in orig.
        # This is a whole, single-page item, not a slice of merged provenance.
        if not text and label == "formula":
            text = getattr(item, "orig", None) or ""
        return text, label

    def furniture_rank(row):
        label = row[1][1]
        return 0 if label == "page_header" else 2 if label == "page_footer" else 1

    def reading_order_key(row):
        item, fragment = row
        return (furniture_rank(row), _item_sort_key(item, int(fragment[1] == "table")))

    traversed = {page: [] for page in result}
    supplemental = {page: [] for page in result}
    seen_ids = set()
    iterate = getattr(document, "iterate_items", None)
    if callable(iterate):
        for entry in _iterate_document_items(iterate):
            item = entry[0] if isinstance(entry, tuple) else entry
            seen_ids.add(id(item))
            if hasattr(item, "export_to_markdown"):
                fragment = (item.export_to_markdown(doc=document), "table")
            elif getattr(item, "prov", None) is not None and (hasattr(item, "text") or hasattr(item, "orig")):
                fragment = text_fragment(item)
            else:
                continue
            traversed[page_of(item)].append((item, fragment))

    for item in getattr(document, "texts", ()):
        if id(item) not in seen_ids:
            supplemental[page_of(item)].append((item, text_fragment(item)))
    for table in getattr(document, "tables", ()):
        if id(table) not in seen_ids:
            supplemental[page_of(table)].append((table, (table.export_to_markdown(doc=document), "table")))

    for page, fragments in result.items():
        # Keep Docling's body traversal order while placing furniture around it
        # and inserting unattached items by their available reading-order data.
        remaining = iter(sorted(supplemental[page], key=reading_order_key))
        pending = next(remaining, None)
        for row in sorted(traversed[page], key=furniture_rank):
            key = reading_order_key(row)
            while pending is not None and reading_order_key(pending) < key:
                fragments.append(pending[1])
                pending = next(remaining, None)
            fragments.append(row[1])
        if pending is not None:
            fragments.append(pending[1])
            fragments.extend(fragment for _, fragment in remaining)
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
    m = _NUMBERED_CONTAINER_PREFIX_RE.match(stripped)
    if not m:
        return False
    title = re.sub(r"^[\s:：.．—–-]+", "", stripped[m.end():])
    if not any(char.isalpha() for char in title) or _ANSWER_TITLE_WORD_RE.search(title):
        return False
    if re.match(r"^(?:\*\*|__)?(?:Key\b|\(?cont|\(?续)", title, re.IGNORECASE):
        return False
    return not m[0].lower().startswith("section ") or bool(
        re.match(r"^(?:\*\*|__)?(?!(?:is|are|was|see)\b)[A-Za-z\u4e00-\u9fff]", title, re.IGNORECASE)
    )


def _is_running_page_heading(stripped: str) -> bool:
    if (_PAGE_METADATA_HEADING_RE.match(stripped) or _CONTINUATION_HEADING_RE.search(stripped)
            or _RUNNING_COUNTER_RE.search(stripped) or _OCR_PLACEHOLDER_RE.match(stripped)):
        return True
    container = _NUMBERED_CONTAINER_PREFIX_RE.match(stripped)
    return bool(container and not stripped[container.end():].strip(" \t:：.．—–-"))


def _is_section_sealed_exit(stripped: str, frag_label: str | None, is_markdown_heading: bool) -> bool:
    if _is_section_sealed_opener(stripped) or _is_running_page_heading(stripped):
        return False
    if re.fullmatch(r"\d+(?:\.\d+)*\s+(?:true|false|yes|no|none|[a-f](?:\s*,\s*[a-f])*)[.。]?", stripped, re.IGNORECASE):
        return False
    if _MAJOR_NON_ANSWER_HEADING_RE.match(stripped) and not _ANSWER_TITLE_WORD_RE.search(stripped):
        return True
    if _TEXTBOOK_NON_ANSWER_HEADING_RE.match(stripped):
        return True
    if _is_titled_non_answer_chapter(stripped):
        return True
    if _STANDALONE_SOLUTION_HEADING_RE.match(stripped):
        return False
    if re.match(
        r"^(?:(?:\d+[.)]|[A-Za-z][.)])(?:\s|$)|(?:\d+(?:\.\d+)*|[A-Za-z])$|[（(]\s*(?:\d+|[a-zA-Z]|[一二三四五六七八九十]+)\s*[)）]|(?:True|False|Yes|No|None)\.?$)",
        stripped,
        re.IGNORECASE,
    ):
        return False
    if (frag_label in _HEADING_LABELS or is_markdown_heading) and not _SECTION_BREAK_RE.match(stripped) and not _EXERCISE_RE.match(stripped) and not _SECTION_SEALED_RE.match(stripped) and not _INLINE_SEALED_ALWAYS_RE.match(stripped) and not _INLINE_SEALED_NON_EXAMPLE_RE.match(stripped) and not _ANSWER_TITLE_WORD_RE.search(stripped) and not re.search(r"(?:\b(?:Chapters?|Sections?|Parts?|Lectures?|Units?|Homework|Self-Check)\b|章|节|篇|部|讲|作业题)", stripped, re.IGNORECASE):
        return True
    if (frag_label in _HEADING_LABELS or is_markdown_heading) and re.match(r"^\d+(?:\.\d+)+\s+(?!True\.?$|False\.?$|Yes\.?$|No\.?$|None\.?$|[A-F](?:\s*,\s*[A-F])*\.?$)[A-Z]", stripped) and not _ANSWER_TITLE_WORD_RE.search(stripped):
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
    stripped = stripped.replace("**", "").replace("__", "")
    if not _SECTION_SEALED_RE.match(stripped):
        return False
    # Inline "Answer Key: text" is inline_sealed unless it is header-only ("Answer Key:" or "Answer Key").
    if _INLINE_WITH_BODY_CHECK_RE.search(stripped):
        return bool(_QUALIFIED_MULTI_SECTION_RE.match(stripped))
    return True


def _classify_segment(line_text: str, frag_label: str | None, page_visuals: set[str], *, in_worked_example: bool, in_exercise: bool, seal_mode: str | None):
    """Return (kind, seal_kind, is_explicit_opener, is_section_break, is_major_non_answer, caption_ref, associated_visual_kind)."""
    raw_trimmed = line_text.strip()
    is_markdown_heading = bool(_MD_HEADING_LINE_RE.match(raw_trimmed))
    stripped = _strip_heading_markup(line_text)
    if frag_label in _FURNITURE_LABELS:
        if _is_section_sealed_opener(stripped):
            return "solution_sealed", "section_sealed", True, False, False, None, None
        return "narrative", None, False, False, False, None, None

    exited_section_seal = False
    if seal_mode == "section_sealed":
        if _is_section_sealed_exit(stripped, frag_label, is_markdown_heading):
            # Re-classify the exiting line cleanly as its true public block kind.
            seal_mode = None
            exited_section_seal = True
        else:
            return "solution_sealed", "section_sealed", False, False, False, None, None

    if frag_label == "caption":
        cap_match = _CAPTION_PREFIX_RE.match(stripped)
        cap_ref = (cap_match.group("ref") or cap_match.group("zh_ref")) if cap_match else None
        return "figure_caption", None, True, False, exited_section_seal, cap_ref.strip() if cap_ref else None, _caption_visual_kind(stripped, page_visuals)
    if frag_label in ("table", "formula"):
        return "narrative", None, False, False, exited_section_seal, None, None

    if in_worked_example and _WORKED_EXAMPLE_INTERNAL_SOLUTION_RE.match(stripped):
        return "worked_example", None, False, False, False, None, None

    if _is_section_sealed_opener(stripped) and not (in_exercise and _BARE_ANSWER_LABEL_RE.match(stripped)):
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

    section_exit_candidate = bool(
        _MAJOR_NON_ANSWER_HEADING_RE.match(stripped)
        or _is_titled_non_answer_chapter(stripped)
        or _SECTION_BREAK_RE.match(stripped)
    )
    if is_markdown_heading or frag_label in _HEADING_LABELS or section_exit_candidate or exited_section_seal:
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


def _inline_answer_body(line_text: str) -> str:
    stripped = _strip_heading_markup(line_text)
    for label in (_INLINE_SEALED_ALWAYS_RE, _INLINE_SEALED_NON_EXAMPLE_RE, _STANDALONE_SOLUTION_HEADING_RE):
        match = label.match(stripped)
        if match:
            return re.sub(r"^\s*[:：]?\s*", "", stripped[match.end():])
    return stripped


def _build_page_blocks(page_number: int, fragments: list[tuple[str, str | None]], page_visuals: set[str], *, initial_in_worked_example: bool = False, initial_seal_mode: str | None = None):
    page_text = "\n".join(text for text, _ in fragments)
    blocks = []
    # Track tuple entries: (block_index, is_furniture, explicit_opener, seal_mode, is_section_exit)
    entries = []
    current = None  # [kind, start, end, visual_kind, caption_ref, is_furniture, explicit_opener, seal_mode, is_section_exit]
    page_seal_mode = initial_seal_mode
    in_worked_example = initial_in_worked_example
    in_exercise = False
    last_inline_body = ""
    inline_break_pending = False

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
            active_seal = current[7] if current is not None else page_seal_mode
            if active_seal == "inline_sealed":
                # A paragraph break closes a populated answer only if body text follows on this page.
                inline_break_pending = bool(last_inline_body)
            elif is_frag_start:
                # Empty fragments are omitted from sealed public_texts; do not merge blocks across them.
                flush()
            elif current is not None and current[0] == "figure_caption":
                flush()
            continue

        active_seal = current[7] if current is not None else page_seal_mode
        if active_seal == "inline_sealed":
            stripped = _strip_heading_markup(unit_text)
            numeric_exercise_answer = (in_exercise and not _MD_HEADING_LINE_RE.match(unit_text.strip())
                                       and re.fullmatch(r"\d+[.。]", stripped))
            if _is_running_page_heading(stripped) and not _is_section_sealed_opener(stripped) and not numeric_exercise_answer:
                # A running header is neither a new section nor part of the answer body.
                if current is None:
                    current = ["solution_sealed", unit_start, unit_end, None, None, False, False, active_seal, False]
                else:
                    current[2] = unit_end
                continue

        is_furniture = frag_label in _FURNITURE_LABELS
        if inline_break_pending and not is_furniture:
            flush()
            if page_seal_mode == "inline_sealed":
                page_seal_mode = None
            inline_break_pending = False
        active_seal = current[7] if current is not None else page_seal_mode
        kind, seal_kind, explicit_opener, section_break, major_non_answer, cap_ref, assoc_visual = _classify_segment(
            unit_text,
            frag_label,
            page_visuals,
            in_worked_example=in_worked_example,
            in_exercise=in_exercise,
            seal_mode=active_seal,
        )

        if is_furniture:
            flush()
            current = [kind, unit_start, unit_end, None, None, True, explicit_opener, seal_kind, False]
            flush()
            if seal_kind == "section_sealed":
                page_seal_mode = "section_sealed"
                in_worked_example = False
                in_exercise = False
            continue

        # An inline answer stays within the current exercise.
        if explicit_opener or section_break:
            in_worked_example = kind == "worked_example"
            if seal_kind != "inline_sealed":
                in_exercise = kind == "exercise"
            page_seal_mode = seal_kind

        if current is None or explicit_opener or section_break:
            flush()
            if active_seal == "inline_sealed" and not (explicit_opener or section_break):
                kind, seal_kind = "solution_sealed", "inline_sealed"
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, False, explicit_opener, seal_kind, major_non_answer]
        elif current[0] == "figure_caption" or (
            current[0] == "proof" and _PROOF_TERMINATOR_RE.search(page_text[current[1]:current[2]])
        ):
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, False, explicit_opener, seal_kind, major_non_answer]
        else:
            # Unmarked lines, tables and formulas continue the active block.
            current[2] = unit_end
        active_seal = current[7]
        if active_seal == "inline_sealed":
            last_inline_body = _inline_answer_body(unit_text) if explicit_opener else unit_text.strip()
        if (
            active_seal == "section_sealed" and _SECTION_SEALED_TERMINATOR_RE.search(unit_text)
        ) or (
            active_seal == "inline_sealed" and _INLINE_SEALED_TERMINATOR_RE.search(last_inline_body)
        ):
            flush()
            page_seal_mode = None

    flush()
    substantive = [entry for entry in entries if not entry[1]]
    if substantive:
        first_idx, _, explicit, first_seal, _ = substantive[0]
        if initial_seal_mode is not None and first_seal == initial_seal_mode and not explicit:
            blocks[first_idx] = replace(blocks[first_idx], continued_from_prev_page=True)
        if (page_seal_mode == "inline_sealed" and _TERMINAL_PUNCTUATION_RE.search(last_inline_body)
                and not _NEXT_CONTINUATION_RE.search(last_inline_body)):
            page_seal_mode = None
    return blocks, entries, in_worked_example, page_seal_mode

def _apply_cross_page_continuations(page_order, blocks_by_page, entries_by_page, end_seals):
    for index, page_number in enumerate(page_order):
        blocks = blocks_by_page[page_number]
        entries = entries_by_page[page_number]
        substantive = [idx for idx, is_furniture, _explicit, _seal_mode, _exit in entries if not is_furniture]
        if not substantive:
            continue
        last_idx = substantive[-1]
        last_block = blocks[last_idx]
        explicit_next = bool(_NEXT_CONTINUATION_RE.search(last_block.text)) or (
            last_block.kind == "narrative" and last_block.text.endswith(("-", "\u00ad"))
        )
        mid_sentence = not _TERMINAL_PUNCTUATION_RE.search(last_block.text)
        has_next_adjacent = index + 1 < len(page_order) and page_order[index + 1] == page_number + 1

        if not has_next_adjacent:
            if explicit_next or (
                last_block.kind == "proof" and not _PROOF_TERMINATOR_RE.search(last_block.text)
            ) or (
                last_block.kind == "solution_sealed" and end_seals[page_number] is not None
            ) or (
                last_block.kind in _CONTINUABLE_KINDS and last_block.kind not in ("proof", "solution_sealed") and mid_sentence
            ):
                blocks[last_idx] = replace(last_block, continues_on_next_page=True)
            continue

        next_page = page_order[index + 1]
        next_blocks = blocks_by_page[next_page]
        next_entries = entries_by_page[next_page]
        next_substantive = [(idx, explicit) for idx, is_furniture, explicit, _seal, _exit in next_entries if not is_furniture]
        if not next_substantive:
            continue

        first_idx, first_explicit = next_substantive[0]
        first_block = next_blocks[first_idx]
        prev_block = last_block

        if prev_block.kind == "solution_sealed":
            if end_seals[page_number] is not None and first_block.kind == "solution_sealed" and first_block.continued_from_prev_page:
                blocks[last_idx] = replace(prev_block, continues_on_next_page=True)
            continue
        if first_block.kind == "solution_sealed":
            continue

        continues = explicit_next or first_block.continued_from_prev_page
        inherit_kind = False

        if not continues:
            if prev_block.kind == "proof" and not _PROOF_TERMINATOR_RE.search(prev_block.text):
                if not first_explicit or (first_block.kind == "proof" and first_block.continued_from_prev_page):
                    continues = True
                    inherit_kind = not first_explicit
            elif prev_block.kind in ("definition", "theorem", "worked_example", "exercise") and mid_sentence and not first_explicit:
                continues = True
                inherit_kind = True
            elif prev_block.kind == "narrative" and prev_block.text.endswith(("-", "\u00ad")):
                continues = True

        if continues:
            blocks[last_idx] = replace(prev_block, continues_on_next_page=True)
            if inherit_kind or (not first_explicit and prev_block.kind in _CONTINUABLE_KINDS and first_block.kind == "narrative"):
                target_kind = prev_block.kind
                next_blocks[first_idx] = replace(
                    first_block,
                    kind=target_kind,
                    visibility_hint=VISIBILITY_BY_KIND[target_kind],
                    continued_from_prev_page=True,
                )
            else:
                next_blocks[first_idx] = replace(first_block, continued_from_prev_page=True)


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


def _has_substantive_text(text: str) -> bool:
    return any(line.strip() and not _is_running_page_heading(_strip_heading_markup(line))
               for line in text.splitlines())


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
        public_text = "\n".join(by_page[number])
        all_sealed_only = not public_text.strip() and any(_has_substantive_text(text) for text in raw_texts)
        if all_sealed_only:
            found.clear()
            continue
        native = (any(not getattr(cell, "from_ocr", False) and _has_substantive_text(getattr(cell, "text", None) or "")
                      for cell in cells) if cells is not None else _has_substantive_text(public_text))
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


def extract_physical_pages(conversion, *, include_sealed: bool = False, initial_seal_mode: str | None = None,
                           initial_in_worked_example: bool = False) -> PhysicalPagesExtraction:
    page_order, raw_fragments, visual_sets = _collect_page_fragments(conversion)
    blocks_by_page: dict[int, list[DiscourseBlock]] = {}
    entries_by_page = {}
    end_seals: dict[int, str | None] = {}
    worked_examples: dict[int, bool] = {}
    seal_mode = initial_seal_mode
    in_worked_example = initial_in_worked_example
    prev_page_number: int | None = None
    for page_number in page_order:
        if prev_page_number is not None and page_number != prev_page_number + 1:
            in_worked_example = False
            seal_mode = None
        blocks, entries, in_worked_example, seal_mode = _build_page_blocks(
            page_number,
            raw_fragments[page_number],
            visual_sets.get(page_number, set()),
            initial_in_worked_example=in_worked_example,
            initial_seal_mode=seal_mode,
        )
        blocks_by_page[page_number] = blocks
        entries_by_page[page_number] = entries
        end_seals[page_number] = seal_mode
        worked_examples[page_number] = in_worked_example
        prev_page_number = page_number

    _apply_cross_page_continuations(page_order, blocks_by_page, entries_by_page, end_seals)

    raw_texts = {p: [t for t, _ in raw_fragments[p]] for p in page_order}
    public_texts: dict[int, list[str]] = {}
    sealed_texts: dict[int, list[str]] = {}
    had_sealed_by_page: dict[int, bool] = {}
    for page_number in page_order:
        frags = raw_fragments[page_number]
        blocks = _seal_furniture_on_all_sealed_page(blocks_by_page[page_number], entries_by_page[page_number])
        had_sealed_by_page[page_number] = any(
            b.kind == "solution_sealed" or b.visibility_hint == "sealed" for b in blocks
        )
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
        section_sealed_by_page={page: mode == "section_sealed" for page, mode in end_seals.items()},
        inline_sealed_by_page={page: mode == "inline_sealed" for page, mode in end_seals.items()},
        had_sealed_by_page=had_sealed_by_page,
        in_worked_example_by_page=worked_examples,
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
