import { describe, expect, it, vi } from "vitest";
import { activitySpecSchema } from "@aistudy/contracts";
import { createOpeningApi } from "./api";

const activityId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const input = { expectedContentVersion: 1, expectedRevisionNumber: 1, revisionNumber: 2 };
const spec = {
  id: otherId, activityId, teachingUnitId: otherId, documentId: otherId,
  revisionNumber: 2, version: 2, blockOrder: [], sourceRefs: [], goals: [],
  verificationStatus: "needs_check", generationConfig: {},
  createdAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:00.000Z",
};

describe("explicit reference revision client", () => {
  it("posts only CAS/pin values and strictly parses the adopted spec", async () => {
    expect(activitySpecSchema.safeParse(spec).success).toBe(true);
    const transport = vi.fn<typeof fetch>(async () => Response.json(spec));
    const result = await createOpeningApi(transport).adoptTeachingReferenceRevision(activityId, input);
    expect(result).toEqual(spec);
    expect(transport.mock.calls).toEqual([[`/api/opening/teaching-activities/${activityId}/reference-revision`, {
      method: "POST", headers: { "content-type": "application/json" }, body: '{"expectedContentVersion":1,"expectedRevisionNumber":1,"revisionNumber":2}',
    }]]);
    expect(transport.mock.calls[0]?.[1]?.body).not.toMatch(/cookie|token|workspace|owner/i);
  });

  it.each([
    { activityId: otherId }, { version: 1 }, { version: 3 }, { revisionNumber: 1 },
    { verificationStatus: "verified", authority: true }, { workspaceId: otherId },
  ])("rejects a mismatched or authority-extended response %j", async patch => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ ...spec, ...patch }));
    await expect(createOpeningApi(transport).adoptTeachingReferenceRevision(activityId, input)).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    { expectedContentVersion: 0 }, { expectedRevisionNumber: -1 }, { revisionNumber: 1.5 },
    { revisionNumber: "2" }, { revisionNumber: Infinity }, { verificationStatus: "verified" },
    { workspaceId: otherId }, { ownerUserId: otherId }, { expectedContentVersion: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects invalid input before transport %j", async patch => {
    const transport = vi.fn<typeof fetch>();
    // Object.assign deliberately exercises the untrusted runtime boundary without narrowing malformed values.
    await expect(createOpeningApi(transport).adoptTeachingReferenceRevision(activityId, Object.assign({}, input, patch))).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["bad", ` ${activityId}`, `${activityId}/other`])("rejects invalid activity %s without transport", async id => {
    const transport = vi.fn<typeof fetch>();
    await expect(createOpeningApi(transport).adoptTeachingReferenceRevision(id, input)).rejects.toThrow();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([401, 409, 503])("does not replay a write after HTTP %s", async status => {
    const transport = vi.fn<typeof fetch>(async () => Response.json({ error: { code: "CONFLICT", message: "reload" } }, { status }));
    await expect(createOpeningApi(transport).adoptTeachingReferenceRevision(activityId, input)).rejects.toMatchObject({ status });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
