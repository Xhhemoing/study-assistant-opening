import argparse
import json
import logging
import os
import sys
import threading
import time
from pathlib import Path

PDF = "application/pdf"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
CAP = 8 * 1024 * 1024
TEXT_CAP = 200_000


def parser():
    result = argparse.ArgumentParser(description="Offline Docling parser; OCR and image extraction are deferred.")
    result.add_argument("--input", required=True)
    result.add_argument("--mime", required=True)
    result.add_argument("--max-pages", required=True, type=int)
    result.add_argument("--timeout-seconds", type=float, default=240)
    return result


def convert(path: Path, timeout: float):
    root = Path(__file__).resolve().parents[3]
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["HF_HOME"] = str(root / ".local" / "hf-home")
    # stdout is a strict JSON contract; docling's postprocessor warnings (e.g.
    # table cells) must never pollute it.
    logging.getLogger().setLevel(logging.ERROR)
    for _name in list(logging.root.manager.loggerDict):
        logging.getLogger(_name).setLevel(logging.ERROR)
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    options = PdfPipelineOptions(do_ocr=False)
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    box = {}

    def work():
        try:
            box["result"] = converter.convert(path)
        except BaseException as error:
            box["error"] = error

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        raise TimeoutError("conversion timed out")
    if "error" in box:
        raise box["error"]
    return box["result"].document


def texts_by_page(document):
    result = {page: [] for page in document.pages}
    for item in document.texts:
        for provenance in item.prov:
            if provenance.page_no in result:
                result[provenance.page_no].append(item.text)
    return result


def main(argv=None):
    # Mathematical PDFs extract to non-ASCII text (˙, ∞, →). On Windows a
    # redirected stdout defaults to the ANSI codepage and would crash on print.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parser().parse_args(argv)
    if args.max_pages <= 0 or args.timeout_seconds <= 0:
        parser().error("max-pages and timeout-seconds must be positive")
    if args.mime not in (PDF, PPTX):
        print("unsupported mime", file=sys.stderr)
        return 3
    path = Path(args.input)
    if not path.is_file():
        print("conversion failed: input file does not exist", file=sys.stderr)
        return 4
    started = time.monotonic()
    try:
        document = convert(path, args.timeout_seconds)
        pages = []
        for page_number, texts in sorted(texts_by_page(document).items()):
            text = "\n".join(texts)
            if len(text) > TEXT_CAP:
                text = text[:TEXT_CAP] + "\n…[truncated]"
            pages.append({"page": page_number, "text": text, "imagePath": None})
        if len(pages) > args.max_pages:
            raise ValueError("max-pages would truncate pages")
        output = json.dumps({"pages": pages}, ensure_ascii=False, separators=(",", ":"))
        if len(output.encode("utf-8")) > CAP:
            raise OverflowError("output size cap exceeded")
        print(output)
        print("conversion completed in {:.2f}s".format(time.monotonic() - started), file=sys.stderr)
        return 0
    except (OverflowError, ValueError) as error:
        print(str(error), file=sys.stderr)
        return 5
    except TimeoutError as error:
        print(str(error), file=sys.stderr)
        return 4
    except BaseException as error:
        print("conversion failed: {}".format(error), file=sys.stderr)
        return 4


if __name__ == "__main__":
    sys.exit(main())
