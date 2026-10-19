import { expect, it, vi } from "vitest";
import { acknowledgeStudyExposure, acknowledgeStudyExposureHeaders } from "./study-exposure-ack";
it("acks an actually received receipt idempotently and retries failed acknowledgements", async () => {
  const id = crypto.randomUUID();
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValue(new Response(null, { status: 200 }));
  await expect(acknowledgeStudyExposure({ id }, fetcher)).rejects.toThrow();
  await acknowledgeStudyExposure({ id }, fetcher);
  await acknowledgeStudyExposure({ id }, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledWith(`/api/opening/study/exposures/${id}/ack`, { method: "POST" });
});
it("reads server issued receipt headers after accepted bodies, without posting client invented support levels", async () => {
  const id = crypto.randomUUID(), fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
  acknowledgeStudyExposureHeaders(new Response("{}", { headers: { "X-Study-Exposure-Receipts": id } }), fetcher);
  await acknowledgeStudyExposure({ id }, fetcher);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
