import { describe, expect, it, vi } from "vitest";
import { fetchMaterialAuthorReview, MaterialAuthorReviewError, type MaterialAuthorSelector } from "./material-author-review-client";

const selector: MaterialAuthorSelector = {
  actorKey: "private-actor", accessEpoch: 1,
  courseId: "00000000-0000-4000-8000-000000000001",
  sourceId: "00000000-0000-4000-8000-000000000002", version: 3,
};
const unavailable = () => ({ status: "unavailable", reason: "manifest_reader_disabled",
  authorReview: null, contents: [], publishable: false });
const signal = () => new AbortController().signal;
const response = (raw: unknown, status = 200) => new Response(JSON.stringify(raw), { status });

describe("explicit same-origin disabled-host client", () => {
  it("makes only the selected GET with exact request policy and signal; copies only the five-field empty DTO", async () => {
    const raw = unavailable(), transport = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
    const abort = signal();
    expect(await fetchMaterialAuthorReview(selector, { fetch: transport, signal: abort })).toEqual(raw);
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      `/api/opening/courses/${selector.courseId}/material-author-review?sourceId=${selector.sourceId}&version=3`,
      { method: "GET", mode: "same-origin", credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort },
    );
    const url = new URL(String(transport.mock.calls[0]![0]), "https://synthetic.example.invalid");
    expect([...url.searchParams.keys()]).toEqual(["sourceId", "version"]);
    expect(url.href).not.toContain("private-actor");
  });

  it.each([
    { courseId: "//private.invalid" }, { courseId: `${selector.courseId}?ownerUserId=private` },
    { sourceId: `${selector.sourceId}&ready=true` }, { sourceId: "" },
    ...[-1, 1.5, NaN, Infinity, 2_147_483_648, Number.MAX_SAFE_INTEGER].map(version => ({ version })),
    ...["0", "01", "+0", "1"].map(version => ({ version })),
  ])("rejects an invalid selector before transport: %j", async change => {
    const transport = vi.fn<typeof fetch>();
    await expect(fetchMaterialAuthorReview({ ...selector, ...change } as MaterialAuthorSelector,
      { fetch: transport, signal: signal() })).rejects.toMatchObject({ code: "invalid_selection" });
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([0, 1, 2_147_483_647])("accepts host version boundary %i with exact URL and request policy", async version => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response(unavailable())), abort = signal();
    expect(await fetchMaterialAuthorReview({ ...selector, version }, { fetch: transport, signal: abort })).toEqual(unavailable());
    expect(transport).toHaveBeenCalledExactlyOnceWith(
      `/api/opening/courses/${selector.courseId}/material-author-review?sourceId=${selector.sourceId}&version=${version}`,
      { method: "GET", mode: "same-origin", credentials: "same-origin", cache: "no-store", redirect: "error", signal: abort },
    );
  });

  it.each([
    null, [], {}, { ...unavailable(), status: "ready" },
    { ...unavailable(), reason: "no_import" }, { ...unavailable(), reason: "unsupported_manifest_schema" },
    { ...unavailable(), authorReview: { answer_key: "PRIVATE_ANSWER" } },
    { ...unavailable(), contents: ["PRIVATE_CHUNK"] }, { ...unavailable(), publishable: true },
    { ...unavailable(), publishable: "false" }, { ...unavailable(), contents: null },
    { ...unavailable(), raw: "PRIVATE_BODY" }, { ...unavailable(), ready: false },
    { data: unavailable() }, { ...unavailable(), error: { message: "PRIVATE_BODY" } },
    ...Object.keys(unavailable()).map(missing => Object.fromEntries(Object.entries(unavailable()).filter(([key]) => key !== missing))),
  ])("rejects every unapproved/raw/envelope shape without retaining raw data: %#", async raw => {
    const transport = vi.fn<typeof fetch>().mockResolvedValue(response(raw));
    const error = await fetchMaterialAuthorReview(selector, { fetch: transport, signal: signal() }).catch(e => e);
    expect(error).toBeInstanceOf(MaterialAuthorReviewError);
    expect(error.code).toBe("invalid_response");
    expect(`${error.stack} ${JSON.stringify(error)}`).not.toContain("PRIVATE_");
  });

  it.each([[400, "unavailable"], [401, "session"], [403, "unavailable"], [404, "not_found"],
    [409, "stale"], [503, "unavailable"], [500, "unavailable"], [302, "unavailable"], [201, "unavailable"]])(
    "maps HTTP %i without parsing even an error body", async (status, code) => {
      const reply = response({ error: { message: "PRIVATE_SQL" } }, Number(status));
      const json = vi.spyOn(reply, "json");
      const transport = vi.fn<typeof fetch>().mockResolvedValue(reply);
      await expect(fetchMaterialAuthorReview(selector, { fetch: transport, signal: signal() })).rejects.toMatchObject({ code });
      expect(json).not.toHaveBeenCalled();
    },
  );

  it("closes JSON, redirect and network failures with no raw message/cause", async () => {
    const redirect = response(unavailable()); Object.defineProperty(redirect, "redirected", { value: true });
    for (const reply of [new Response("PRIVATE_INVALID_JSON"), redirect]) {
      const transport = vi.fn<typeof fetch>().mockResolvedValue(reply);
      await expect(fetchMaterialAuthorReview(selector, { fetch: transport, signal: signal() })).rejects.toMatchObject({ code: "invalid_response" });
    }
    const transport = vi.fn<typeof fetch>().mockRejectedValue(new Error("PRIVATE_NETWORK_TOKEN"));
    const error = await fetchMaterialAuthorReview(selector, { fetch: transport, signal: signal() }).catch(e => e);
    expect(error.code).toBe("network"); expect(error.cause).toBeUndefined();
    expect(String(error)).not.toContain("PRIVATE_");
  });
});
