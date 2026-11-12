import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../../auth/service";
import { GET } from "../../../../app/api/opening/courses/[id]/material-author-review/route";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), load: vi.fn() }));
vi.mock("../../runtime", () => ({ requireOpeningScope: mocks.authenticate }));
vi.mock("./material-author-review-host", async importOriginal => ({
  ...await importOriginal<typeof import("./material-author-review-host")>(),
  loadMaterialAuthorReviewHost: mocks.load,
}));
const courseId = randomUUID(), sourceId = randomUUID();
const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
const context = { params: Promise.resolve({ id: courseId }) };
const request = (query = `sourceId=${sourceId}&version=1`) => new Request(`http://review.test/api?${query}`);
beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticate.mockResolvedValue({ sql: {}, scope });
  mocks.load.mockResolvedValue({ status: "unavailable", reason: "manifest_reader_disabled",
    authorReview: null, contents: [], publishable: false });
});

it("binds the disabled server reader only after request authentication", async () => {
  const req = request();
  const response = await GET(req, context);
  expect(mocks.authenticate).toHaveBeenCalledWith(req);
  const { disabledMaterialAuthorReviewManifestReader } = await import("./material-author-review-host");
  expect(mocks.load).toHaveBeenCalledWith({}, scope, { courseId, sourceId, version: 1 }, disabledMaterialAuthorReviewManifestReader);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(response.headers.get("Vary")).toBe("Cookie");
  expect(await response.json()).toEqual({ status: "unavailable", reason: "manifest_reader_disabled",
    authorReview: null, contents: [], publishable: false });
});

it.each([
  "", `sourceId=${sourceId}&version=-1`, `sourceId=${sourceId}&version=01`,
  `sourceId=${sourceId}&version=%2B0`, `sourceId=${sourceId}&version=+0`,
  `sourceId=${sourceId}&version=2147483648`, `sourceId=${sourceId}&version=1.5`,
  `sourceId=${sourceId}&version=1&version=2`, `sourceId=${sourceId}&sourceId=${sourceId}&version=1`,
  `sourceId=bad&version=1`, `sourceId=${sourceId}&version=1&ownerUserId=${scope.ownerUserId}`,
  `sourceId=${sourceId}&version=1&explicitHelp=true`, `sourceId=${sourceId}&version=1&trustedScope=allow`,
])("rejects ambiguous/forged selectors before calling host: %s", async query => {
  const response = await GET(request(query), context);
  expect(response.status).toBe(400);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(mocks.load).not.toHaveBeenCalled();
});

it.each([0, 1, 2_147_483_647])("accepts canonical host version boundary %i with the same disabled reader", async version => {
  const response = await GET(request(`sourceId=${sourceId}&version=${version}`), context);
  const { disabledMaterialAuthorReviewManifestReader } = await import("./material-author-review-host");
  expect(mocks.authenticate).toHaveBeenCalledOnce();
  expect(mocks.load).toHaveBeenCalledExactlyOnceWith({}, scope, { courseId, sourceId, version }, disabledMaterialAuthorReviewManifestReader);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: "unavailable", reason: "manifest_reader_disabled",
    authorReview: null, contents: [], publishable: false });
});

it("authenticates even malformed selectors and never invokes the reader for invalid session", async () => {
  mocks.authenticate.mockRejectedValue(new ApiError("UNAUTHENTICATED", "private token detail", 401));
  const response = await GET(request("owner=forged"), context);
  expect(response.status).toBe(401);
  expect(await response.text()).not.toContain("private token detail");
  expect(mocks.load).not.toHaveBeenCalled();
});

it.each([404, 409, 503])("sanitizes %i host errors and disables caching", async status => {
  mocks.load.mockRejectedValue(new ApiError(status === 404 ? "NOT_FOUND" : status === 409 ? "CONFLICT" : "CONFIGURATION", "RAW_ANSWER SQL secret", status));
  const response = await GET(request(), context);
  expect(response.status).toBe(status);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  expect(await response.text()).not.toMatch(/RAW_ANSWER|SQL secret/);
});

it("sanitizes unexpected failures without returning raw content", async () => {
  mocks.load.mockRejectedValue(new Error("RAW_ANSWER postgres credential"));
  const response = await GET(request(), context);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: { code: "UNAVAILABLE", message: "Material review temporarily unavailable" } });
});
