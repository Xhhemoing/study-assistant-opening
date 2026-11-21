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

_MARKDOWN_PREFIX_RE = re.compile(r"^(?:#{1,6}\s+|\*\*|__)+")
_CAPTION_PREFIX_RE = re.compile(
    r"^(?P<ref>(?:Figure|Fig\.?|Table|Chart|Diagram|Scheme|Algorithm|Listing)\s+\d+(?:[.\-]\d+)*)"
    r"(?:\s*[:.\-—]|$|\s+(?!(?:shows|illustrates|demonstrates|depicts|presents|indicates|is|was|are|can|will)\b))"
    r"|^(?P<zh_ref>(?:图|表|插图|附表|算法)\s*\d+(?:[.\-]\d+)*)(?:\s*[:：.．、\-—]|\s+|$)",
    re.IGNORECASE,
)
_TABLE_CAPTION_REF_RE = re.compile(r"^(?:Table|表|附表)\b", re.IGNORECASE)
_VISUAL_CAPTION_REF_RE = re.compile(r"^(?:Figure|Fig\.?|Chart|Diagram|Scheme|图|插图)\b", re.IGNORECASE)

_SOLUTION_SEALED_RE = re.compile(
    r"^(?:"
    r"(?:Answer\s+Key|Answers?\s+to\s+(?:Exercises?|Problems?|Selected\s+(?:Exercises?|Problems?)|Odd-Numbered\s+(?:Exercises?|Problems?))|"
    r"Selected\s+Answers?|Model\s+Answers?|Key\s+to\s+Exercises?)\b(?:\s*(?:\(\s*continued\s*\))?\s*(?:[:：.\-—]|$))?"
    r"|(?:Answer|Answers)\s*(?:\d+(?:\.\d+)*)?\s*(?:\(\s*continued\s*\))?\s*(?:[:：.\-—]|$)"
    r"|(?:(?:Worked|Full|Official|Reference|Sample)\s+)?Solutions?(?:\s+to\s+(?:Exercises?|Problems?|Questions?)?(?:\s*\d+(?:\.\d+)*)?)?\s*(?:\(\s*continued\s*\))?\s*(?:\d+(?:\.\d+)*)?\s*(?:[:：.\-—]|$)"
    r"|【\s*(?:参考答案|标准答案|习题答案|练习答案|课后答案|答案与解析|参考解答|详细解答|答案|解答|详解|解析)\s*】"
    r"|(?:参考答案|标准答案|习题答案|练习答案|课后答案|答案与解析|参考解答|详细解答)\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*(?:[:：.．、\-—]|$)"
    r"|(?:答案|解答|详解|解析)\s*(?:\d+(?:[.\-]\d+)*)?\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*(?:[:：.．、\-—]|$)"
    r"|解\s*(?:\d+(?:[.\-]\d+)*)?\s*[:：]"
    r")",
    re.IGNORECASE,
)
_PROOF_RE = re.compile(
    r"^(?:"
    r"(?:Proof|Sketch\s+of\s+Proof|Proof\s+Sketch)(?:\s+of\s+(?:Theorem|Lemma|Proposition|Corollary)\s*[\d.]*)?(?:\s*\(\s*continued\s*\))?\s*(?:[:：.\-—]|$)"
    r"|【\s*(?:证明|证|略证|续证)\s*】"
    r"|(?:证明|略证|续证)\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*(?:[:：.．\-—]|$)"
    r"|证\s*(?:（续）|\(续\)|（接上页）|\(接上页\))?\s*[:：.．]"
    r")",
    re.IGNORECASE,
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
    r"(?:Chapter|Section|Part|Appendix)\s+\d+(?:\.\d+)*(?:\b|$)"
    r"|第\s*[一二三四五六七八九十百千\d]+\s*[章节篇部分]"
    r"|#{1,6}\s+\S"
    r"|\d+(?:\.\d+)+\s+\S"
    r")",
    re.IGNORECASE,
)
_PREV_CONTINUATION_RE = re.compile(
    r"^\s*(?:【\s*(?:续证|接上页|续)\s*】|续证\b|接上页\b|（(?:续|接上页)）|\((?:continued|cont\.?|续|接上页)\)|continued\b)"
    r"|\(\s*continued\s*\)|（\s*(?:续|接上页)\s*）|\(\s*(?:续|接上页)\s*\)",
    re.IGNORECASE,
)
_NEXT_CONTINUATION_RE = re.compile(
    r"(?:\(\s*(?:to\s+be\s+continued|continued(?:\s+on\s+next\s+page)?)\s*\)|（\s*(?:下接下页|转下页|未完待续)\s*）|\(\s*(?:下接下页|转下页|未完待续)\s*\)|接下页|转下页)\s*$",
    re.IGNORECASE,
)
_PROOF_TERMINATOR_RE = re.compile(r"(?:[□■∎]|Q\.?E\.?D\.?|证毕|证完)\s*[.。]?\s*$", re.IGNORECASE)
_SOLUTION_TERMINATOR_RE = re.compile(r"(?:[□■∎]|答案完|解答完)\s*$", re.IGNORECASE)
_TERMINAL_PUNCTUATION_RE = re.compile(r"[.。!?！？:：;；)）\]】□■∎]\s*$")


@dataclass(frozen=True)
class DiscourseBlock:
    kind: str
    text: str
    page_number: int
    char_start: int
    char_end: int
    continued_from_prev_page: bool = False
    continues_on_next_page: bool = False
    visibility_hint: str = "public"
    associated_visual_kind: str | None = None
    caption_ref: str | None = None

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
        }


@dataclass(frozen=True)
class PhysicalPagesExtraction:
    texts_by_page: dict[int, list[str]]
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
        text = item.text
        label = _normalized_label(item)
        # Without formula enrichment Docling stores formula content only in orig.
        # This is a whole, single-page item, not a slice of merged provenance.
        if not text and label == "formula":
            text = item.orig
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
    return _MARKDOWN_PREFIX_RE.sub("", line_text.strip())


def _caption_visual_kind(caption_text: str, page_visuals: set[str]) -> str | None:
    if _TABLE_CAPTION_REF_RE.match(caption_text) or "table" in caption_text.lower() or "表" in caption_text:
        return "table"
    if _VISUAL_CAPTION_REF_RE.match(caption_text) or any(word in caption_text.lower() for word in ("figure", "fig", "chart", "diagram", "graph", "image")) or "图" in caption_text:
        return "picture"
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


def _classify_segment(line_text: str, frag_label: str | None, page_visuals: set[str]):
    """Return (kind, is_explicit_opener, is_section_break, caption_ref, associated_visual_kind)."""
    stripped = _strip_heading_markup(line_text)
    if frag_label in _FURNITURE_LABELS:
        if _SOLUTION_SEALED_RE.match(stripped):
            return "solution_sealed", True, False, None, None
        return "narrative", False, False, None, None
    if frag_label == "caption":
        cap_match = _CAPTION_PREFIX_RE.match(stripped)
        cap_ref = (cap_match.group("ref") or cap_match.group("zh_ref")) if cap_match else None
        return "figure_caption", True, False, cap_ref.strip() if cap_ref else None, _caption_visual_kind(stripped, page_visuals)
    if frag_label in ("table", "formula"):
        return "narrative", False, False, None, None

    if _SOLUTION_SEALED_RE.match(stripped):
        return "solution_sealed", True, False, None, None
    if _PROOF_RE.match(stripped):
        return "proof", True, False, None, None
    if _THEOREM_RE.match(stripped):
        return "theorem", True, False, None, None
    if _DEFINITION_RE.match(stripped):
        return "definition", True, False, None, None
    if _WORKED_EXAMPLE_RE.match(stripped):
        return "worked_example", True, False, None, None
    if _EXERCISE_RE.match(stripped):
        return "exercise", True, False, None, None

    cap_match = _CAPTION_PREFIX_RE.match(stripped)
    if cap_match:
        cap_ref = (cap_match.group("ref") or cap_match.group("zh_ref")).strip()
        return "figure_caption", True, False, cap_ref, _caption_visual_kind(stripped, page_visuals)

    if frag_label in _HEADING_LABELS or _SECTION_BREAK_RE.match(stripped):
        return "narrative", True, True, None, None

    return "narrative", False, False, None, None


def _iter_page_units(fragments: list[tuple[str, str | None]]):
    """Yield (start, end, text, label) in exact page_text = '\\n'.join(...) coordinates."""
    offset = 0
    for frag_index, (frag_text, frag_label) in enumerate(fragments):
        if frag_label in ("table", "formula") or "\n" not in frag_text:
            yield offset, offset + len(frag_text), frag_text, frag_label
        else:
            cursor = offset
            for part in frag_text.splitlines(keepends=True):
                line = part.rstrip("\r\n")
                yield cursor, cursor + len(line), line, frag_label
                cursor += len(part)
            if frag_text.endswith(("\n", "\r")):
                yield offset + len(frag_text), offset + len(frag_text), "", frag_label
        offset += len(frag_text)
        if frag_index + 1 < len(fragments):
            offset += 1  # '\n' joiner


def _build_page_blocks(page_number: int, fragments: list[tuple[str, str | None]], page_visuals: set[str]):
    page_text = "\n".join(text for text, _ in fragments)
    blocks = []
    # Track tuple entries so we also remember whether a block came from page furniture.
    entries = []
    current = None  # [kind, start, end, visual_kind, caption_ref, is_furniture, explicit_opener]

    def flush():
        nonlocal current
        if current is None:
            return
        kind, start, end, visual_kind, caption_ref, is_furniture, explicit_opener = current
        text = page_text[start:end]
        if text.strip():
            block = DiscourseBlock(
                kind=kind,
                text=text,
                page_number=page_number,
                char_start=start,
                char_end=end,
                continued_from_prev_page=bool(_PREV_CONTINUATION_RE.search(text[:120])),
                continues_on_next_page=False,
                visibility_hint=VISIBILITY_BY_KIND[kind],
                associated_visual_kind=visual_kind,
                caption_ref=caption_ref,
            )
            blocks.append(block)
            entries.append((len(blocks) - 1, is_furniture, explicit_opener))
        current = None

    for unit_start, unit_end, unit_text, frag_label in _iter_page_units(fragments):
        if not unit_text.strip():
            if current is not None and current[0] == "figure_caption":
                flush()
            continue

        is_furniture = frag_label in _FURNITURE_LABELS
        kind, explicit_opener, section_break, cap_ref, assoc_visual = _classify_segment(
            unit_text, frag_label, page_visuals
        )

        if is_furniture and kind != "solution_sealed":
            flush()
            current = ["narrative", unit_start, unit_end, None, None, True, False]
            flush()
            continue

        if current is None:
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, is_furniture, explicit_opener]
            continue

        prev_kind = current[0]
        prev_text = page_text[current[1]:current[2]]

        if explicit_opener or section_break:
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, is_furniture, explicit_opener]
            continue

        # Continuation within the same page under an open block.
        if prev_kind == "figure_caption":
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, is_furniture, explicit_opener]
            continue
        if prev_kind == "proof" and _PROOF_TERMINATOR_RE.search(prev_text):
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, is_furniture, explicit_opener]
            continue
        if prev_kind == "solution_sealed" and _SOLUTION_TERMINATOR_RE.search(prev_text):
            flush()
            current = [kind, unit_start, unit_end, assoc_visual, cap_ref, is_furniture, explicit_opener]
            continue

        # Merge unmarked continuation line/table/formula into the active block.
        current[2] = unit_end

    flush()
    return page_text, blocks, entries


def _apply_cross_page_continuations(page_order, blocks_by_page, entries_by_page):
    for index, page_number in enumerate(page_order):
        blocks = blocks_by_page[page_number]
        entries = entries_by_page[page_number]
        substantive = [idx for idx, is_furniture, _explicit in entries if not is_furniture]
        if not substantive:
            continue
        last_idx = substantive[-1]
        last_block = blocks[last_idx]
        explicit_next = bool(_NEXT_CONTINUATION_RE.search(last_block.text)) or (
            last_block.kind == "narrative" and last_block.text.endswith(("-", "\u00ad"))
        )
        mid_sentence = not _TERMINAL_PUNCTUATION_RE.search(last_block.text)
        has_next_adjacent = index + 1 < len(page_order) and page_order[index + 1] == page_number + 1

        if explicit_next or (not has_next_adjacent and last_block.kind in _CONTINUABLE_KINDS and mid_sentence and not _PROOF_TERMINATOR_RE.search(last_block.text)):
            blocks[last_idx] = replace(last_block, continues_on_next_page=True)

        if not has_next_adjacent:
            continue

        next_page = page_order[index + 1]
        next_blocks = blocks_by_page[next_page]
        next_entries = entries_by_page[next_page]
        next_substantive = [(idx, explicit) for idx, is_furniture, explicit in next_entries if not is_furniture]
        if not next_substantive:
            continue

        first_idx, first_explicit = next_substantive[0]
        first_block = next_blocks[first_idx]
        prev_block = blocks[last_idx]

        # Determine if prev_block continues onto next_page's first substantive block.
        continues = explicit_next or first_block.continued_from_prev_page
        inherit_kind = False

        if not continues:
            if prev_block.kind == "proof" and not _PROOF_TERMINATOR_RE.search(prev_block.text):
                if not first_explicit or (first_block.kind == "proof" and first_block.continued_from_prev_page):
                    continues = True
                    inherit_kind = not first_explicit
            elif prev_block.kind == "solution_sealed" and not _SOLUTION_TERMINATOR_RE.search(prev_block.text):
                if not first_explicit:
                    continues = True
                    inherit_kind = True
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
    sealed_spans = [(b.char_start, b.char_end) for b in blocks if b.kind == "solution_sealed" or b.visibility_hint == "sealed"]
    if not sealed_spans:
        return [] if sealed_only else [text for text, _ in fragments]

    kept: list[str] = []
    offset = 0
    for frag_index, (frag_text, _frag_label) in enumerate(fragments):
        frag_start = offset
        frag_end = frag_start + len(frag_text)
        offset = frag_end + (1 if frag_index + 1 < len(fragments) else 0)

        if not frag_text:
            if not sealed_only:
                kept.append(frag_text)
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
        native = any(getattr(cell, "text", "").strip() and not getattr(cell, "from_ocr", False) for cell in cells) if cells is not None else has_any_text
        has_ocr = any(getattr(cell, "text", "").strip() and getattr(cell, "from_ocr", False) for cell in cells) if cells is not None else False
        if not native or has_ocr:
            found.add("scan")
        if all_sealed_only and not has_ocr:
            found.clear()

    if not physical:
        for number, texts in by_page.items():
            raw_texts = [text for text, _ in raw_fragments.get(number, ())]
            has_sealed_only = not "\n".join(texts).strip() and bool("\n".join(raw_texts).strip())
            if not "\n".join(texts).strip() and not has_sealed_only:
                kinds[number].add("scan")
            elif has_sealed_only:
                kinds[number].clear()

    order = ("scan", "formula", "table", "picture")
    return {number: [kind for kind in order if kind in found] for number, found in kinds.items()}

def extract_physical_pages(conversion, *, include_sealed: bool = False) -> PhysicalPagesExtraction:
    page_order, raw_fragments, visual_sets = _collect_page_fragments(conversion)
    blocks_by_page: dict[int, list[DiscourseBlock]] = {}
    entries_by_page = {}
    for page_number in page_order:
        _page_text, blocks, entries = _build_page_blocks(
            page_number, raw_fragments[page_number], visual_sets.get(page_number, set())
        )
        blocks_by_page[page_number] = blocks
        entries_by_page[page_number] = entries

    _apply_cross_page_continuations(page_order, blocks_by_page, entries_by_page)

    public_texts: dict[int, list[str]] = {}
    sealed_texts: dict[int, list[str]] = {}
    for page_number in page_order:
        frags = raw_fragments[page_number]
        blocks = blocks_by_page[page_number]
        public_texts[page_number] = _filter_fragments_by_visibility(frags, blocks, sealed_only=False)
        sealed_texts[page_number] = _filter_fragments_by_visibility(frags, blocks, sealed_only=True)

    selected_texts = {p: [t for t, _ in raw_fragments[p]] for p in page_order} if include_sealed else public_texts
    visuals = _compute_visual_kinds(conversion, selected_texts, page_order, visual_sets, raw_fragments)
    return PhysicalPagesExtraction(
        texts_by_page=selected_texts,
        public_texts_by_page=public_texts,
        sealed_texts_by_page=sealed_texts,
        discourse_blocks_by_page=blocks_by_page,
        visual_kinds_by_page=visuals,
    )


def discourse_blocks_by_page(conversion) -> dict[int, list[DiscourseBlock]]:
    """Extract ordered, single-page academic discourse blocks with exact in-page charspans."""
    return extract_physical_pages(conversion).discourse_blocks_by_page


def texts_by_page(conversion, *, include_sealed: bool = False):
    """Return physical-page text fragments, sealing solution_sealed blocks by default."""
    return extract_physical_pages(conversion, include_sealed=include_sealed).texts_by_page


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
        raw_non_empty = any(getattr(el, "text", "").strip() for el in assembled_elements)
        public_empty = not "\n".join(by_page[number]).strip()
        native = any(getattr(cell, "text", "").strip() and not getattr(cell, "from_ocr", False)
                     for cell in cells) if cells is not None else (not public_empty or raw_non_empty)
        has_ocr = any(getattr(cell, "text", "").strip() and getattr(cell, "from_ocr", False)
                      for cell in cells) if cells is not None else False
        if not native or has_ocr:
            found.add("scan")
        if public_empty and raw_non_empty and not has_ocr:
            # Entire page was native text that got sealed (solution_sealed); never re-transcribe via scan/vision.
            continue
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
                    getattr(item, "text", "").strip() and any(getattr(p, "page_no", None) == number for p in getattr(item, "prov", []))
                    for item in getattr(document, "texts", [])
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
