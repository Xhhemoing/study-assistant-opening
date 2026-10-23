"""Physical-page text from Docling's retained, pre-document-merge assembly.

ReadingOrderModel 2.126.0 changes text when joining hyphenated continuations
without fixing provenance charspans. Neither merged text nor orig is sliceable
by those spans. ConversionResult.pages still holds the original page elements.
"""


def _document_texts(document):
    """PPTX / page-local document extraction; never split a merged item."""
    result = {page: [] for page in document.pages}

    def page_of(item):
        pages = {provenance.page_no for provenance in item.prov}
        if len(pages) != 1 or not pages.issubset(result):
            raise RuntimeError("text/table lacks unambiguous physical-page provenance; pre-merge assembly required")
        return next(iter(pages))

    for item in document.texts:
        text = item.text
        # Without formula enrichment Docling stores formula content only in orig.
        # This is a whole, single-page item, not a slice of merged provenance.
        if not text and getattr(item, "label", None) == "formula":
            text = item.orig
        result[page_of(item)].append(text)
    for table in getattr(document, "tables", []):
        result[page_of(table)].append(table.export_to_markdown(doc=document))
    return result


def _assemble_page(conversion, page):
    # Re-run only the rule-based reading-order/serialization stage on ONE page.
    # No layout/OCR/model inference or backend I/O. This keeps ordered text,
    # captions, nested figure/form text and rich tables without copying merged
    # document items into several pages or reimplementing Docling table export.
    from docling.datamodel.document import ConversionResult
    from docling.models.stages.reading_order.readingorder_model import ReadingOrderModel, ReadingOrderOptions

    local = ConversionResult(input=conversion.input, pages=[page], assembled=page.assembled)
    return ReadingOrderModel(ReadingOrderOptions())(local)


def texts_by_page(conversion):
    # Keep the document-only API for PPTX and existing single-page test doubles.
    # A document-only cross-page item fails rather than guessing its page text.
    if not hasattr(conversion, "document"):
        return _document_texts(conversion)
    if getattr(getattr(conversion, "status", None), "value", None) != "success":
        raise RuntimeError("conversion did not complete every requested page")
    document = conversion.document
    is_pdf = getattr(getattr(conversion, "input", None), "format", None) == "pdf"
    if not conversion.pages and not is_pdf:
        # SimplePipeline (PPTX) produces a document, not page assemblies.
        return _document_texts(document)

    numbers = [page.page_no for page in conversion.pages]
    if not numbers or len(set(numbers)) != len(numbers) or set(numbers) != set(document.pages):
        raise RuntimeError("incomplete physical-page assembly")
    result = {}
    for page in conversion.pages:
        if page.assembled is None:
            raise RuntimeError("missing pre-merge physical-page assembly")
        if any(element.page_no != page.page_no for element in page.assembled.elements):
            raise RuntimeError("assembly element belongs to another physical page")
        local = _document_texts(_assemble_page(conversion, page))
        if set(local) != {page.page_no}:
            raise RuntimeError("page assembly did not preserve the physical page number")
        result.update(local)
    return result
