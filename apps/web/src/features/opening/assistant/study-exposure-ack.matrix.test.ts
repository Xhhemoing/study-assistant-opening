import { describe, expect, it, vi } from "vitest";
import { acknowledgeStudyExposure, acknowledgeStudyExposureHeaders } from "./study-exposure-ack";

// Fetch is always an injected promise double: no HTTP or browser is used.
let serial = 0;
const nextId = () => `ack-pure-matrix-${++serial}`;
describe("ACK is a permitted receipt effect, not evidence of independent mastery", () => {
  it.each([null, undefined])("does nothing only for absent receipt %s", async receipt => {
    const fetcher = vi.fn();
    await acknowledgeStudyExposure(receipt, fetcher);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("coalesces concurrent repeated ACKs, then suppresses only successful duplicates", async () => {
    const id = nextId();
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
    const first = acknowledgeStudyExposure({ id }, fetcher);
    const second = acknowledgeStudyExposure({ id }, fetcher);
    expect(second).toBe(first);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`/api/opening/study/exposures/${id}/ack`, { method: "POST" });
    finish(new Response(null, { status: 200 }));
    await Promise.all([first, second]);
    await acknowledgeStudyExposure({ id }, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([403, 404, 409, 410, 503])("does not mark failed/expired/wrong-scope status %s acknowledged, permits explicit retry", async status => {
    const id = nextId();
    const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status })).mockResolvedValue(new Response(null, { status: 200 }));
    await expect(acknowledgeStudyExposure({ id }, fetcher)).rejects.toThrow("学习记录暂未同步");
    expect(fetcher).toHaveBeenCalledOnce(); // No hidden retry.
    await acknowledgeStudyExposure({ id }, fetcher);
    await acknowledgeStudyExposure({ id }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("cleans up a rejected pending promise without claiming a successful ACK", async () => {
    const id = nextId(), error = new Error("synthetic network failure");
    const fetcher = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(new Response(null, { status: 200 }));
    await expect(acknowledgeStudyExposure({ id }, fetcher)).rejects.toBe(error);
    await acknowledgeStudyExposure({ id }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("ACKs each accepted header receipt while coalescing duplicates and ignoring empty fields", async () => {
    const a = nextId(), b = nextId();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    acknowledgeStudyExposureHeaders(new Response(null, { headers: { "X-Study-Exposure-Receipts": ` ${a}, ,${b},${a}, ` } }), fetcher);
    await Promise.all([acknowledgeStudyExposure({ id: a }, fetcher), acknowledgeStudyExposure({ id: b }, fetcher)]);
    expect(fetcher.mock.calls).toEqual([
      [`/api/opening/study/exposures/${a}/ack`, { method: "POST" }],
      [`/api/opening/study/exposures/${b}/ack`, { method: "POST" }],
    ]);
  });
  it("keeps unrelated receipts separate rather than globally forbidding ACK writes", async () => {
    const a = nextId(), b = nextId();
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    await acknowledgeStudyExposure({ id: a }, fetcher);
    await acknowledgeStudyExposure({ id: b }, fetcher);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
