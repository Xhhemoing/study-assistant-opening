import { describe, expect, it, vi } from "vitest";
import { captureReaderReturnPoint, restoreReaderReturnPoint } from "./reader-return-point";

function element(parentElement: HTMLElement | null, top: number, left: number): HTMLElement {
  return { parentElement, scrollTop: top, scrollLeft: left, isConnected: true, focus: vi.fn() } as unknown as HTMLElement;
}

describe("reader return position", () => {
  it("restores the source title focus and every mounted scroll container after reading", () => {
    const page = element(null, 20, 0);
    const list = element(page, 720, 8);
    const title = element(list, 0, 0);
    const point = captureReaderReturnPoint(title);
    list.scrollTop = 0; list.scrollLeft = 0; page.scrollTop = 0;
    vi.mocked(title.focus).mockImplementation(() => { list.scrollTop = 15; });
    restoreReaderReturnPoint(point);
    expect(title.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(list.scrollTop).toBe(720);
    expect(list.scrollLeft).toBe(8);
    expect(page.scrollTop).toBe(20);
  });
  it("does not focus a source removed while reading and still restores the surviving list", () => {
    const list = element(null, 800, 0);
    const title = element(list, 0, 0);
    const point = captureReaderReturnPoint(title);
    Object.assign(title, { isConnected: false });
    list.scrollTop = 0;
    restoreReaderReturnPoint(point);
    expect(title.focus).not.toHaveBeenCalled();
    expect(list.scrollTop).toBe(800);
    expect(() => restoreReaderReturnPoint(captureReaderReturnPoint(null))).not.toThrow();
  });
});
