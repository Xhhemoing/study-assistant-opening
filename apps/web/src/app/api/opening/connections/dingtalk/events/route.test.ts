import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { middleware } from "../../../../../../middleware";
import { POST } from "./route";

const path = "/api/opening/connections/dingtalk/events";
const base = "https://study.example";
const sql = vi.hoisted(() => vi.fn());
vi.mock("../../../../../../server/runtime", () => ({ getAuthRuntime: () => ({ sql }) }));

describe("DingTalk webhook ingress", () => {
  beforeEach(() => {
    sql.mockClear();
    vi.stubEnv("PUBLIC_BASE_URL", base);
    vi.stubEnv("OPENING_DINGTALK_CALLBACK_TOKEN", "fixture-token");
    vi.stubEnv("OPENING_DINGTALK_ENCODING_AES_KEY", "A".repeat(43));
    vi.stubEnv("OPENING_DINGTALK_CORP_ID", "fixture-corp");
  });
  afterEach(() => vi.unstubAllEnvs());

  function webhook(body: BodyInit, headers?: HeadersInit) {
    const timestamp = Math.floor(Date.now() / 1000);
    return new NextRequest(`${base}${path}?signature=forged&timestamp=${timestamp}&nonce=fixture`, {
      method: "POST", body, headers, duplex: "half",
    });
  }

  it("passes an originless webhook to signature verification and strips cookies", async () => {
    const request = webhook("encrypted", { cookie: "aistudy_session=fixture" });
    const next = middleware(request);
    expect(next.headers.get("x-middleware-next")).toBe("1");
    expect(next.headers.get("x-middleware-override-headers")?.split(",")).not.toContain("cookie");
    const response = await POST(request);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "SIGNATURE" } });
    expect(sql).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/api/opening/connections/imap"], ["POST", `${path}/`],
    ["POST", `${path}/extra`], ["PATCH", path],
  ])("still requires Origin for %s %s", (method, pathname) => {
    expect(middleware(new NextRequest(`${base}${pathname}`, { method })).status).toBe(403);
  });

  it("cancels a multi-chunk webhook above the byte limit before signature verification", async () => {
    const cancel = vi.fn();
    const chunk = new TextEncoder().encode("中".repeat(12_000));
    let chunks = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (++chunks <= 4) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    });
    const response = await POST(webhook(stream));
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledOnce();
    expect(sql).not.toHaveBeenCalled();
  });

  it("rejects a declared oversized body even when signing parameters are absent", async () => {
    const request = new Request(`${base}${path}`, { method: "POST", headers: { "content-length": "65537" } });
    const response = await POST(request);
    expect(response.status).toBe(413);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(sql).not.toHaveBeenCalled();
  });
});
