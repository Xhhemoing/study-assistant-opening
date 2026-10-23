"""Shared local-only OCR configuration and small, document-free readiness probe."""
import os
import time
from pathlib import Path

MODEL_FILES = {
    "det": "ch_PP-OCRv4_det_mobile.pth",
    "cls": "ch_ptocr_mobile_v2.0_cls_mobile.pth",
    "rec": "ch_PP-OCRv4_rec_mobile.pth",
    "keys": "ppocr_keys_v1.txt",
}


def local_models(directory):
    root = Path(directory)
    if not root.is_absolute() or not root.is_dir():
        raise FileNotFoundError("OCR requires an absolute prepared PARSER_OCR_MODEL_DIR")
    files = {key: root / name for key, name in MODEL_FILES.items()}
    for file in files.values():
        if not file.is_file() or file.stat().st_size == 0:
            raise FileNotFoundError("OCR requires all four non-empty offline model files")
        with file.open("rb") as stream:
            stream.read(1)
    return files


def model_params():
    from rapidocr import OCRVersion, ModelType
    from rapidocr.utils.download_file import DownloadFile

    def offline_only(*_args, **_kwargs):
        raise RuntimeError("runtime OCR downloads are disabled; prepare local models first")

    # RapidOCR does not honor HF_HUB_OFFLINE for its own downloader. Block its
    # fallback too, including file-removal races after the initial check.
    DownloadFile.run = staticmethod(offline_only)
    params = {f"{stage}.ocr_version": OCRVersion.PPOCRV4 for stage in ("Det", "Cls", "Rec")}
    params.update({f"{stage}.model_type": ModelType.MOBILE for stage in ("Det", "Cls", "Rec")})
    params["Global.log_level"] = "critical"
    return params


def tiny_inference(directory):
    # Explicit paths prohibit RapidOCR's missing-model download fallback. Never
    # run its setup/check/download command and never use an uploaded document.
    files = local_models(directory)
    os.environ["HF_HUB_OFFLINE"] = "1"
    import cv2
    import numpy as np
    from rapidocr import RapidOCR, EngineType
    from rapidocr.ch_ppocr_rec import TextRecInput
    params = model_params()
    params["Global.model_root_dir"] = Path(directory)
    for stage, key in (("Det", "det"), ("Cls", "cls"), ("Rec", "rec")):
        params[f"{stage}.engine_type"] = EngineType.TORCH
        params[f"{stage}.model_path"] = str(files[key])
    params["Rec.rec_keys_path"] = str(files["keys"])
    engine = RapidOCR(params=params)
    image = np.full((64, 192, 3), 255, dtype=np.uint8)
    cv2.putText(image, "OCR 123", (8, 42), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 2)
    # Calling the pipeline on blank pixels may skip cls/rec. Exercise all three
    # directly, even if detection finds no boxes. This is liveness, not accuracy.
    engine.text_det(image)
    classified = engine.text_cls([image])
    recognized = engine.text_rec(TextRecInput(img=[image], return_word_box=False))
    if classified.cls_res is None or recognized.txts is None:
        raise RuntimeError("OCR inference returned no result")


def probe_ocr(directory=None, infer=tiny_inference):
    configured = (os.environ.get("PARSER_OCR_MODEL_DIR", "") if directory is None else directory).strip()
    report = {"status": "not_configured", "directoryConfigured": bool(configured),
              "directoryExists": False, "missingFiles": [], "inferenceMs": None}
    if not configured:
        return report
    root = Path(configured)
    try:
        report["directoryExists"] = root.is_absolute() and root.is_dir()
        missing = []
        for name in MODEL_FILES.values():
            file = root / name
            try:
                if not report["directoryExists"] or not file.is_file() or file.stat().st_size == 0:
                    missing.append(name)
                    continue
                with file.open("rb") as stream:
                    stream.read(1)
            except OSError:
                missing.append(name)
        report["missingFiles"] = missing
        if missing:
            report["status"] = "missing_files"
            return report
        started = time.monotonic()
        infer(configured)
        report["inferenceMs"] = max(0, round((time.monotonic() - started) * 1000))
        report["status"] = "ready"
    except Exception:
        # Do not publish local paths, stack traces, or document data to Web.
        report["status"] = "preflight_failed"
    return report


if __name__ == "__main__":
    import contextlib
    import json
    import sys
    with contextlib.redirect_stdout(sys.stderr):
        result = probe_ocr()
    print(json.dumps(result))
