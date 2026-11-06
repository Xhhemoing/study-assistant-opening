// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOpeningApi, OpeningApiError } from "../client/api";
import { Composer, type ComposerSubmit, type ComposerSubmitResult } from "./composer";
import { formatTurnError, isEphemeralNotSentError } from "./turn-errors";

let host: HTMLDivElement, root: Root;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const send = () => act(async () => {
  host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
});

it.each(["json", "sse"] as const)("retains the question and explicitly retries a server-confirmed not-sent %s reply with one new key", async transportKind => {
  const errorBody = { error: { code: "EPHEMERAL_REQUEST_NOT_SENT", message: "这次临时请求确定未发送。" } };
  const transport = vi.fn<typeof fetch>(async () => transportKind === "json"
    ? Response.json(errorBody, { status: 409 })
    : new Response(`event: error\ndata: ${JSON.stringify(errorBody)}\n\n`, { headers: { "content-type": "text/event-stream" } }));
  const api = createOpeningApi(transport);
  const submit = vi.fn<(input: ComposerSubmit) => Promise<ComposerSubmitResult>>().mockImplementation(async input => {
    try {
      await api.replyEphemeral({ text: input.text, mode: input.mode, sourceIds: [], history: [], clientKey: input.clientKey },
        undefined, transportKind === "sse" ? () => undefined : undefined);
      return { accepted: true };
    } catch (error) {
      expect(isEphemeralNotSentError(error)).toBe(true);
      expect(formatTurnError(error)).toContain("确定未发送");
      return { accepted: false, retryNotSent: true };
    }
  });
  await act(async () => root.render(<Composer privacy="ephemeral" draft="保留这个原问题"
    modePrefill={{ mode: "hint", nonce: 1 }} onDraftChange={() => undefined} onSubmit={submit} />));
  await send();
  expect(submit).toHaveBeenCalledOnce();
  expect(transport).toHaveBeenCalledOnce(); // No automatic second request.
  expect(host.querySelector("textarea")?.value).toBe("保留这个原问题");
  expect(host.textContent).toContain("只给提示");
  await send();
  expect(submit).toHaveBeenCalledTimes(2);
  expect(submit.mock.calls[1]?.[0]).toMatchObject({ text: "保留这个原问题", mode: "hint", privacy: "ephemeral" });
  expect(submit.mock.calls[1]?.[0].clientKey).not.toBe(submit.mock.calls[0]?.[0].clientKey);
  expect(transport).toHaveBeenCalledTimes(2);
});

it.each(["BUDGET_OUTCOME_UNKNOWN", "BUDGET_EXECUTION_CLAIMED", "BUDGET_REPLAY_COMPLETED", "BUDGET_REPLAY_RELEASED", "PROVIDER_TIMEOUT", "PROVIDER_NETWORK", "STREAM_INCOMPLETE"])("does not grant a new key for %s", async code => {
  const error = new OpeningApiError(502, "unknown response", code);
  const submit = vi.fn<(input: ComposerSubmit) => Promise<ComposerSubmitResult>>().mockResolvedValue({ accepted: false });
  expect(isEphemeralNotSentError(error)).toBe(false);
  await act(async () => root.render(<Composer privacy="ephemeral" draft="同一个原问题" onDraftChange={() => undefined} onSubmit={submit} />));
  await send(); await send();
  expect(submit.mock.calls[1]?.[0].clientKey).toBe(submit.mock.calls[0]?.[0].clientKey);
});

it("ignores a new-attempt signal outside the temporary-chat branch", async () => {
  const submit = vi.fn<(input: ComposerSubmit) => Promise<ComposerSubmitResult>>().mockResolvedValue({ accepted: false, retryNotSent: true });
  await act(async () => root.render(<Composer privacy="saved" draft="保存问题" onDraftChange={() => undefined} onSubmit={submit} />));
  await send(); await send();
  expect(submit.mock.calls[1]?.[0].clientKey).toBe(submit.mock.calls[0]?.[0].clientKey);
});

it("does not trust an arbitrary object claiming the new error code", () => {
  expect(isEphemeralNotSentError({ code: "EPHEMERAL_REQUEST_NOT_SENT" })).toBe(false);
});
