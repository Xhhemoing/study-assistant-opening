import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSourceActionsClient } from "./source-actions-client";
import { subscribeOpeningPrivacyChange } from "../client/privacy-change";
import { SourceImpactSummary, sourceActionNotice } from "./source-actions-panel";

const id = "11111111-1111-4111-8111-111111111111";
const membershipId = "22222222-2222-4222-8222-222222222222";
describe("material actions", () => {
  it("sends the displayed version and course references with explicit confirmation", async () => {
    const fetcher = vi.fn(async () => Response.json({ sourceId: id, aiExcluded: true, deleted: false, cleanupPending: 0, retryAfter: null }));
    const api = createSourceActionsClient(fetcher);
    await api.act(id, { action: "exclude", expectedVersion: 2, expectedMembershipIds: [membershipId] });
    expect(fetcher).toHaveBeenCalledWith(`/api/opening/sources/${id}/actions`, expect.objectContaining({
      method: "POST", body: JSON.stringify({ action: "exclude", expectedVersion: 2, expectedMembershipIds: [membershipId] }),
    }));
  });
  it("requires reviewing changed impact instead of hiding a conflict", async () => {
    const api = createSourceActionsClient(async () => new Response(null, { status: 409 }));
    await expect(api.act(id, { action: "delete", expectedVersion: 1, expectedMembershipIds: [] })).rejects.toMatchObject({ status: 409 });
  });
  it("shows active and archived references and distinguishes partial cleanup", () => {
    const html = renderToStaticMarkup(createElement(SourceImpactSummary, { impact: {
      sourceId: id, version: 2, aiExcluded: false, courses: [
        { membershipId, courseId: id, title: "Linear Algebra", archivedAt: null },
        { membershipId: id, courseId: membershipId, title: "Old Course", archivedAt: "2026-09-01T00:00:00.000Z" },
      ],
    } }));
    expect(html).toContain("Linear Algebra"); expect(html).toContain("Old Course"); expect(html).toContain("已归档");
    expect(sourceActionNotice({ sourceId: id, aiExcluded: true, deleted: true, cleanupPending: 1, retryAfter: null })).toContain("清理未完成");
    expect(sourceActionNotice({ sourceId: id, aiExcluded: true, deleted: true, cleanupPending: 1, retryAfter: "2026-09-30T01:00:00.000Z" })).toContain("上传链接尚在有效期");
  });
  it("rejects a response containing private storage keys", async () => {
    const api = createSourceActionsClient(async () => Response.json([{ sourceId: id, cleanupPending: 1, retryAfter: null, keys: ["private/object"] }]));
    await expect(api.deletions()).rejects.toThrow();
  });
});

const dispose: Array<() => void> = [];
afterEach(() => { dispose.splice(0).forEach(cancel => cancel()); });
describe("material action privacy notifications", () => {
  it.each(["exclude", "delete"] as const)("notifies only after a valid successful %s response without passing material data", async action => {
    const listener = vi.fn(); dispose.push(subscribeOpeningPrivacyChange(listener));
    const result = { sourceId: id, aiExcluded: true, deleted: action === "delete", cleanupPending: 0, retryAfter: null };
    const api = createSourceActionsClient(async () => {
      expect(listener).not.toHaveBeenCalled();
      return Response.json(result);
    });
    await expect(api.act(id, { action, expectedVersion: 1, expectedMembershipIds: [] })).resolves.toEqual(result);
    expect(listener).toHaveBeenCalledExactlyOnceWith();
  });
  it("does not clear drafts for a cleanup retry that changes no privacy decision", async () => {
    const listener = vi.fn(); dispose.push(subscribeOpeningPrivacyChange(listener));
    const api = createSourceActionsClient(async () => Response.json({ sourceId: id, aiExcluded: true, deleted: true, cleanupPending: 0, retryAfter: null }));
    await api.act(id, { action: "retry_cleanup" });
    expect(listener).not.toHaveBeenCalled();
  });
  it.each([409, 500, "invalid-success"] as const)("does not notify after %s", async failure => {
    const listener = vi.fn(); dispose.push(subscribeOpeningPrivacyChange(listener));
    const api = createSourceActionsClient(async () => failure === "invalid-success"
      ? Response.json({ sourceId: id, aiExcluded: true, deleted: true, cleanupPending: 0, retryAfter: null, privateKey: "hidden" })
      : new Response(null, { status: failure }));
    await expect(api.act(id, { action: "delete", expectedVersion: 1, expectedMembershipIds: [] })).rejects.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});
