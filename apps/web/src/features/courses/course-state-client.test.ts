import { describe, expect, it, vi } from "vitest";
import { createCourseStateClient } from "./course-state-client";
const id = "00000000-0000-4000-8000-000000000001";
describe("course state client", () => {
  it("unlinks only the selected membership and accepts an empty 204 response", async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 204 }));
    await createCourseStateClient(fetcher).removeAsset(id, { assetId: "source", assetType: "source" });
    expect(fetcher).toHaveBeenCalledWith(`/api/courses/${id}/memberships`, expect.objectContaining({
      method: "DELETE", body: JSON.stringify({ assetType: "source", assetId: "source" }),
    }));
  });
  it("requests reversible course state only and returns the saved course", async () => {
    const course = { id, title: "代数", slug: "algebra", description: "", createdAt: "2026-09-29T00:00:00Z", updatedAt: "2026-09-29T00:00:00Z", archivedAt: "2026-09-29T00:00:00Z", learningPreferenceOverrides: {} };
    const fetcher = vi.fn(async () => Response.json({ course }));
    expect(await createCourseStateClient(fetcher).setArchived(id, true)).toEqual(course);
    expect(fetcher).toHaveBeenCalledWith(`/api/courses/${id}`, expect.objectContaining({ method: "PATCH", body: '{"archived":true}' }));
  });
  it("sends an explicit inherit choice without opting the account into anything", async () => {
    const preferences = { assessmentEnabled: false, retestSuggestionsEnabled: false, automaticRemindersEnabled: false };
    const fetcher = vi.fn(async () => Response.json({ learningPreferences: preferences }));
    expect(await createCourseStateClient(fetcher).savePreferences(id, { assessmentEnabled: true })).toEqual(preferences);
    expect(fetcher).toHaveBeenCalledWith(`/api/opening/courses/${id}/preferences`, expect.objectContaining({ method: "PUT", body: '{"assessmentEnabled":true}' }));
  });
  it("reports a failed mutation instead of treating it as success", async () => {
    const client = createCourseStateClient(async () => new Response(null, { status: 500 }));
    await expect(client.removeAsset(id, { assetId: "source", assetType: "source" })).rejects.toThrow("操作未完成");
  });
});
