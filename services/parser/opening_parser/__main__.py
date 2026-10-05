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
    result.add_argument("--check", action="store_true", help="Check parser imports without converting a document")
    result.add_argument("--input")
    result.add_argument("--mime")
    result.add_argument("--max-pages", type=int)
    result.add_argument("--timeout-seconds", type=float, default=240)
    return result


def create_converter():
    root = Path(__file__).resolve().parents[3]
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ.setdefault("HF_HOME", str(root / ".local" / "hf-home"))
    # stdout is a strict JSON contract; docling's postprocessor warnings (e.g.
    # table cells) must never pollute it.
    logging.getLogger().setLevel(logging.ERROR)
    for _name in list(logging.root.manager.loggerDict):
        logging.getLogger(_name).setLevel(logging.ERROR)
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import PdfPipelineOptions
    from docling.document_converter import DocumentConverter, PdfFormatOption
    options = PdfPipelineOptions(do_ocr=False)
    ocr_dir = os.environ.get("PARSER_OCR_MODEL_DIR")
    if ocr_dir:
        from docling.datamodel.pipeline_options import RapidOcrOptions
        from rapidocr import OCRVersion, ModelType
        directory = Path(ocr_dir).resolve()
        files = {"det": directory / "ch_PP-OCRv4_det_mobile.pth",
                 "cls": directory / "ch_ptocr_mobile_v2.0_cls_mobile.pth",
                 "rec": directory / "ch_PP-OCRv4_rec_mobile.pth",
                 "keys": directory / "ppocr_keys_v1.txt"}
        if not all(file.is_file() for file in files.values()):
            raise FileNotFoundError("OCR requires prepared offline RapidOCR Torch PP-OCRv4 models and ppocr_keys_v1.txt in PARSER_OCR_MODEL_DIR")
        params = {f"{stage}.ocr_version": OCRVersion.PPOCRV4 for stage in ("Det", "Cls", "Rec")}
        params.update({f"{stage}.model_type": ModelType.MOBILE for stage in ("Det", "Cls", "Rec")})
        params["Global.log_level"] = "critical"
        options.do_ocr = True
        options.ocr_options = RapidOcrOptions(backend="torch", lang=["ch"],
            det_model_path=str(files["det"]), cls_model_path=str(files["cls"]), rec_model_path=str(files["rec"]),
            rec_keys_path=str(files["keys"]), rapidocr_params=params)
    manifest = json.loads((Path(__file__).parents[1] / "model-manifest.json").read_text(encoding="utf-8"))
    layout = next(model for model in manifest["models"] if model["model"] == options.layout_options.model_spec.repo_id)
    options.layout_options.model_spec.revision = layout["revision"]
    return DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})


def convert(path: Path, timeout: float):
    converter = create_converter()
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
    for table in getattr(document, "tables", []):
        text = table.export_to_markdown(doc=document)
        for page_no in {provenance.page_no for provenance in table.prov}:
            if page_no in result:
                result[page_no].append(text)
    return result


def main(argv=None):
    # Mathematical PDFs extract to non-ASCII text (˙, ∞, →). On Windows a
    # redirected stdout defaults to the ANSI codepage and would crash on print.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    args = parser().parse_args(argv)
    if args.check:
        try:
            create_converter()
            print("parser ready")
            return 0
        except Exception as error:
            print(f"parser check failed: {error}; install services/parser/requirements-lock.txt", file=sys.stderr)
            return 4
    if args.input is None or args.mime is None or args.max_pages is None:
        parser().error("--input, --mime and --max-pages are required for conversion")
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
