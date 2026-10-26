import { describe, expect, it } from "vitest";
import {
  createDocumentPropertiesApi,
  DocumentPropertiesApiError,
} from "./document-properties-api";

const documentId = "11111111-1111-4111-8111-111111111111";
const payload = {
  document: [{
    id: "22222222-2222-4222-8222-222222222222",
    key: "priority",
    valueType: "number",
    value: 3,
    updatedAt: "2026-08-03T12:00:00.000Z",
  }],
  blocks: [],
};

describe("document properties API", () => {
  it("encodes document IDs and parses read-only metadata", async () => {
    let path = "";
    const api = createDocumentPropertiesApi((async (input) => {
      path = String(input);
      return Response.json(payload);
    }) as typeof fetch);

    await expect(api.get(`${documentId}/nested`)).resolves.toEqual(payload);
    expect(path).toBe(`/api/documents/${encodeURIComponent(`${documentId}/nested`)}/properties`);
  });

  it("preserves forbidden errors and rejects malformed responses", async () => {
    const denied = createDocumentPropertiesApi((async () => Response.json({
      error: { code: "WORKSPACE_FORBIDDEN", message: "denied" },
    }, { status: 403 })) as typeof fetch);
    await expect(denied.get(documentId)).rejects.toMatchObject({
      code: "WORKSPACE_FORBIDDEN", status: 403,
    } satisfies Partial<DocumentPropertiesApiError>);

    const malformed = createDocumentPropertiesApi((async () => Response.json({ document: "no", blocks: [] })) as typeof fetch);
    await expect(malformed.get(documentId)).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});
