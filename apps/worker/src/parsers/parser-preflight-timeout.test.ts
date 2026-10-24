import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preflightParser } from "./parser-preflight";

const deps = vi.hoisted(() => ({ access: vi.fn(), stat: vi.fn(), runner: vi.fn() }));
vi.mock("node:fs/promises", () => ({ access: deps.access, stat: deps.stat }));
vi.mock("./docling-process", () => ({ createNodeRunner: () => deps.runner }));
const config = { cwd: "/parser", pythonExecutable: "/venv/python" };

beforeEach(() => {
  vi.useFakeTimers();
  deps.access.mockResolvedValue(undefined); deps.stat.mockResolvedValue({ isDirectory: () => true });
  vi.spyOn(AbortSignal, "timeout").mockImplementation(milliseconds => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("preflight timed out", "TimeoutError")), milliseconds);
    return controller.signal;
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.resetAllMocks(); });

function delayedCheck(milliseconds: number) {
  deps.runner.mockImplementation((_args: string[], signal: AbortSignal) => new Promise((resolve, reject) => {
    const complete = setTimeout(() => resolve({ exitCode: 0, stdout: "parser ready", stderr: "" }), milliseconds);
    signal.addEventListener("abort", () => { clearTimeout(complete); reject(signal.reason); }, { once: true });
  }));
}

describe("parser cold-start budget", () => {
  it("allows a healthy cold dependency check beyond the former thirty-second budget", async () => {
    delayedCheck(70_000);
    const complete = vi.fn();
    const checking = preflightParser(config).then(runner => { complete(); return runner; });
    await vi.advanceTimersByTimeAsync(30_001);
    expect(complete).not.toHaveBeenCalled();
    expect(deps.runner.mock.calls[0]?.[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(await checking).toBe(deps.runner);
    expect(complete).toHaveBeenCalledOnce();
    expect(deps.runner).toHaveBeenCalledWith(["-m", "opening_parser", "--check"], expect.any(AbortSignal));
  });

  it("still aborts a stuck startup at the finite two-minute boundary", async () => {
    delayedCheck(180_000);
    const checking = preflightParser(config);
    const failed = expect(checking).rejects.toThrow(/Parser startup failed.*preflight timed out/);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(deps.runner.mock.calls[0]?.[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await failed;
    expect(deps.runner.mock.calls[0]?.[1].aborted).toBe(true);
    expect(deps.runner).toHaveBeenCalledOnce();
  });

  it("does not hide broken imports or reinterpret nonzero check exits as readiness", async () => {
    deps.runner.mockResolvedValue({ exitCode: 4, stdout: "", stderr: "missing offline model" });
    await expect(preflightParser(config)).rejects.toThrow(/missing offline model.*requirements-lock/);
    expect(deps.runner).toHaveBeenCalledOnce();
  });
});
