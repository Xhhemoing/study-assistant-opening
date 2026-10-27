import { describe, expect, it } from "vitest";
import {
  createDocumentRelationsApi,
  DocumentRelationsApiError,
} from "./document-relations-api";

const documentId = "11111111-1111-4111-8111-111111111111";
const targetId = "22222222-2222-4222-8222-222222222222";
const relationId = "33333333-3333-4333-8333-333333333333";
const relation = {
  id: relationId,
  relationType: "references",
  from: { type: "document", id: documentId, documentId, title: "Source", text: null, status: "available" },
  to: { type: "document", id: targetId, documentId: targetId, title: "Target", text: null, status: "available" },
  createdAt: "2026-08-03T12:00:00.000Z",
};

function queuedFetch(responses: Response[]) {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
  return {
    calls,
    fetchImpl: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return responses.shift() ?? new Response(null, { status: 500 });
    },
  };
}

describe("document relations API", () => {
  it("encodes paths and sends typed create/update/delete requests", async () => {
    const queue = queuedFetch([
      Response.json({ relation }, { status: 201 }),
      Response.json({ relation: { ...relation, relationType: "supports" } }),
      new Response(null, { status: 204 }),
    ]);
    const api = createDocumentRelationsApi(queue.fetchImpl as typeof fetch);

    await expect(api.create(`${documentId}/nested`, { type: "document", id: targetId }, "references")).resolves.toEqual(relation);
    await expect(api.update(documentId, relationId, "supports")).resolves.toMatchObject({ relationType: "supports" });
    await expect(api.remove(documentId, relationId)).resolves.toBeUndefined();

    expect(queue.calls[0]?.[0]).toBe(`/api/documents/${encodeURIComponent(`${documentId}/nested`)}/relations`);
    expect(queue.calls[0]?.[1]).toMatchObject({ method: "POST", body: JSON.stringify({ to: { type: "document", id: targetId }, relationType: "references" }) });
    expect(queue.calls[1]?.[1]).toMatchObject({ method: "PATCH", body: JSON.stringify({ relationType: "supports" }) });
    expect(queue.calls[2]?.[1]).toMatchObject({ method: "DELETE" });
  });

  it("returns structured validation errors for invalid local input", async () => {
    const api = createDocumentRelationsApi((async () => Response.json({ relation })) as typeof fetch);
    await expect(api.create(documentId, { type: "document", id: "invalid" }, "references")).rejects.toMatchObject({
      code: "VALIDATION", status: 400,
    });
    await expect(api.update(documentId, relationId, "invalid" as never)).rejects.toMatchObject({
      code: "VALIDATION", status: 400,
    });
  });

  it("preserves API conflict and forbidden errors", async () => {
    const conflict = createDocumentRelationsApi((async () => Response.json({
      error: { code: "CONFLICT", message: "duplicate" },
    }, { status: 409 })) as typeof fetch);
    await expect(conflict.update(documentId, relationId, "related")).rejects.toMatchObject({
      code: "CONFLICT", status: 409,
    } satisfies Partial<DocumentRelationsApiError>);

    const forbidden = createDocumentRelationsApi((async () => Response.json({
      error: { code: "WORKSPACE_FORBIDDEN", message: "denied" },
    }, { status: 403 })) as typeof fetch);
    await expect(forbidden.list(documentId)).rejects.toMatchObject({
      code: "WORKSPACE_FORBIDDEN", status: 403,
    } satisfies Partial<DocumentRelationsApiError>);
  });
});
