import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const calls = vi.hoisted(() => ({
  callback: vi.fn(async () => ({ eventId: "event-1", duplicate: false, imported: 1, sourceId: "source-1", receiptId: "receipt-1" })),
  success: vi.fn(() => ({ msg_signature: "ack-signature", timeStamp: "1760000000", nonce: "fixture", encrypt: "ack-ciphertext" })),
}));
const sql = vi.hoisted(() => vi.fn());

vi.mock("../../../../../../server/runtime", () => ({ getAuthRuntime: () => ({ sql }) }));
vi.mock("../../../../../../features/opening/server/data-services", () => ({ getOpeningConnectorStorage: () => ({}) }));
vi.mock("../../../../../../features/opening/connections/dingtalk-callback-service", async () => {
  const actual = await vi.importActual<typeof import("../../../../../../features/opening/connections/dingtalk-callback-service")>("../../../../../../features/opening/connections/dingtalk-callback-service");
  return { ...actual, createDingTalkCallbackHttpService: () => calls };
});

import { POST } from "./route";

describe("DingTalk callback envelope", () => {
  afterEach(() => {
    calls.callback.mockClear();
    calls.success.mockClear();
  });

  it("passes the standard event envelope ciphertext to the callback service", async () => {
    const request = new NextRequest("https://study.example/api/opening/connections/dingtalk/events?msg_signature=provider-signature&timeStamp=1760000000&nonce=fixture", {
      method: "POST",
      body: JSON.stringify({ encrypt: "provider-ciphertext" }),
      headers: { "content-type": "application/json" },
      duplex: "half",
    });
    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(calls.callback).toHaveBeenCalledWith({
      signature: "provider-signature",
      timestamp: "1760000000",
      nonce: "fixture",
      encryptedBody: "provider-ciphertext",
    });
    expect(calls.success).toHaveBeenCalledWith("1760000000", "fixture");
    await expect(response.json()).resolves.toEqual({
      msg_signature: "ack-signature",
      timeStamp: "1760000000",
      nonce: "fixture",
      encrypt: "ack-ciphertext",
    });
  });
});
