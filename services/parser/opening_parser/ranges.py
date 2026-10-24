"""Sequential PDF ranges with a single converter and bounded JSONL output."""
import contextlib
import json
import logging
import os
import re
import sys
import threading


def parse_ranges(value):
    """Accept ascending, disjoint inclusive physical ranges, including gaps."""
    ranges = []
    for item in value.split(","):
        if not re.fullmatch(r"[0-9]+-[0-9]+", item):
            raise ValueError("malformed PDF ranges")
        start, end = map(int, item.split("-"))
        if start < 1 or end < start or (ranges and start <= ranges[-1][1]):
            raise ValueError("PDF ranges must be positive, ordered and non-overlapping")
        ranges.append((start, end))
    return ranges


def json_line(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n"


def failure(page_range, error):
    return {"range": list(page_range), "error": error}


@contextlib.contextmanager
def protocol_stdout():
    """Keep Python prints, pre-bound log handlers and native stdout off JSONL.

    The duplicated descriptor is the only protocol writer. StringIO fallback
    keeps the same contract for stdlib-only embedding/tests without a descriptor.
    """
    output = sys.stdout
    saved_fd = None
    try:
        stdout_fd, stderr_fd = output.fileno(), sys.stderr.fileno()
    except (AttributeError, OSError, ValueError):
        stdout_fd = stderr_fd = None
    if stdout_fd is not None:
        output.flush()
        saved_fd = os.dup(stdout_fd)
        output = os.fdopen(os.dup(saved_fd), "w", encoding="utf-8", newline="\n", buffering=1)
        os.dup2(stderr_fd, stdout_fd)
    disabled = logging.root.manager.disable
    logging.disable(logging.CRITICAL)
    try:
        with contextlib.redirect_stdout(sys.stderr):
            yield output
    finally:
        logging.disable(disabled)
        if saved_fd is not None:
            output.close()
            os.dup2(saved_fd, stdout_fd)
            os.close(saved_fd)


def convert_range(converter, path, timeout, page_range):
    box = {}

    def work():
        try:
            box["result"] = converter.convert(path, page_range=page_range)
        except BaseException as error:
            box["error"] = error

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    thread.join(timeout)
    if thread.is_alive():
        # Caller MUST stop: the daemon may still own/use the converter.
        raise TimeoutError("conversion timed out")
    if "error" in box:
        raise box["error"]
    result = box["result"]
    if getattr(getattr(result, "status", None), "value", None) != "success":
        raise RuntimeError("conversion did not complete every requested page")
    return result


def pages_for_range(conversion, page_range, texts_by_page, text_cap):
    by_page = texts_by_page(conversion)
    start, end = page_range
    if set(by_page) != set(range(start, end + 1)):
        raise ValueError("parser did not preserve requested physical pages")
    pages = []
    for number, texts in sorted(by_page.items()):
        text = "\n".join(texts)
        if len(text) > text_cap:
            text = text[:text_cap] + "\n…[truncated]"
        pages.append({"page": number, "text": text, "imagePath": None})
    return pages


def run(args, path, ranges, create_converter, pdf_page_count, texts_by_page, cap, text_cap, *,
        terminate_on_timeout=False):
    with protocol_stdout() as output:
        try:
            total = pdf_page_count(path)
            if total < 1 or total > args.max_pages or ranges[-1][1] > total:
                raise ValueError("PDF ranges or max-pages exceed document bounds")
        except ValueError as error:
            print(str(error), file=sys.stderr)
            return 5
        except BaseException as error:
            print(f"PDF inspection failed: {error}", file=sys.stderr)
            return 4

        # Reserve the largest permitted failure line for EVERY pending range.
        # Thus an oversized success cannot prevent subsequent error reporting.
        reserves = [max(len(json_line(failure(r, error)).encode("utf-8"))
                        for error in ("timeout", "invalid_output", "conversion_failed")) for r in ranges]
        remaining = sum(reserves)
        if remaining > cap:
            print("output size cap cannot accommodate range errors", file=sys.stderr)
            return 5
        converter = None
        initialization_failed = False
        try:
            converter = create_converter()
        except BaseException as error:
            print(f"converter initialization failed: {error}", file=sys.stderr)
            initialization_failed = True

        written = 0
        exit_code = 0
        for page_range, reserve in zip(ranges, reserves):
            remaining -= reserve
            timed_out = False
            try:
                if initialization_failed:
                    raise RuntimeError("converter unavailable")
                conversion = convert_range(converter, path, args.timeout_seconds, page_range)
            except TimeoutError:
                payload = failure(page_range, "timeout")
                timed_out = True
                exit_code = 4
            except BaseException as error:
                print(f"range {page_range} conversion failed: {error}", file=sys.stderr)
                payload = failure(page_range, "conversion_failed")
                exit_code = exit_code or 4
            else:
                try:
                    pages = pages_for_range(conversion, page_range, texts_by_page, text_cap)
                    payload = {"range": list(page_range), "pages": pages}
                    # Serialize inside this boundary: invalid Unicode/text is not
                    # allowed to break the JSONL stream or masquerade as success.
                    json_line(payload).encode("utf-8")
                except BaseException as error:
                    print(f"range {page_range} invalid output: {error}", file=sys.stderr)
                    payload = failure(page_range, "invalid_output")
                    exit_code = exit_code or 4
            line = json_line(payload)
            size = len(line.encode("utf-8"))
            if written + size + remaining > cap:
                line = json_line(failure(page_range, "invalid_output"))
                size = len(line.encode("utf-8"))
                print("output size cap exceeded", file=sys.stderr)
                exit_code = 5
            output.write(line)
            output.flush()
            written += size
            if timed_out:
                # Native libraries/executors may own non-daemon threads. sys.exit
                # waits for those during interpreter shutdown, so the standalone
                # CLI must exit after flushing the protocol receipt. Embedded
                # callers retain the return-value API and own their lifecycle.
                if terminate_on_timeout:
                    sys.stderr.flush()
                    os._exit(4)
                return 4
        return exit_code
