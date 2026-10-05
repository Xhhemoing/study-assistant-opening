"""Bounded PDF page rasterization for owner-authorized LLM calls, no network."""
import base64
import io
import json
import sys
import pypdfium2 as pdfium


def main():
    pages = json.loads(sys.argv[1])
    if not isinstance(pages, list) or not 1 <= len(pages) <= 3 or any(type(p) is not int or p < 1 for p in pages):
        raise ValueError('invalid physical page selection')
    data = sys.stdin.buffer.read(50 * 1024 * 1024 + 1)
    if len(data) > 50 * 1024 * 1024:
        raise ValueError('PDF exceeds rendering limit')
    document = pdfium.PdfDocument(data)
    images = []
    try:
        for number in pages:
            if number > len(document):
                raise ValueError('physical page unavailable')
            page = document[number - 1]
            bitmap = None
            try:
                width, height = page.get_size()
                if width <= 0 or height <= 0:
                    raise ValueError('invalid page size')
                bitmap = page.render(scale=min(2.0, 1600 / max(width, height)))
                image = bitmap.to_pil()
                output = io.BytesIO()
                image.save(output, format='PNG')
                image.close()
                value = output.getvalue()
                if len(value) > 2 * 1024 * 1024:
                    raise ValueError('page image exceeds limit')
                images.append('data:image/png;base64,' + base64.b64encode(value).decode('ascii'))
            finally:
                if bitmap is not None:
                    bitmap.close()
                page.close()
    finally:
        document.close()
    print(json.dumps(images))


if __name__ == '__main__':
    main()
