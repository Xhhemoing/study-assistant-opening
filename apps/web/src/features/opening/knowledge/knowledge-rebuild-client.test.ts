import { expect, it, vi } from "vitest";
import { createKnowledgeRebuildClient, KnowledgeRebuildRequestError } from "./knowledge-rebuild-client";

const courseId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", jobId = "11111111-1111-4111-8111-111111111111";
const record = { version: 3, snapshot: { courseId, version: 3, nodes: [], edges: [] }, sourceVersions: {} };

it("posts only the client key to the course rebuild route and accepts an existing job", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ jobId, kind: "build-course-knowledge", created: false }));
  await expect(createKnowledgeRebuildClient(transport).rebuild(courseId, "knowledge-rebuild:key-1")).resolves.toEqual({ jobId, kind: "build-course-knowledge", created: false });
  const [path, init] = transport.mock.calls[0]!;
  expect(path).toBe(`/api/opening/courses/${courseId}/knowledge/rebuild`);
  expect(init?.method).toBe("POST");
  expect(JSON.parse(String(init?.body))).toEqual({ clientKey: "knowledge-rebuild:key-1" });
});

it("forwards the abort signal to the rebuild request unchanged", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json({ jobId, kind: "build-course-knowledge", created: true }));
  const controller = new AbortController();
  await createKnowledgeRebuildClient(transport).rebuild(courseId, "knowledge-rebuild:key-1", controller.signal);
  expect(transport.mock.calls[0]?.[1]?.signal).toBe(controller.signal);
});

it("reads the current knowledge record without the HTTP cache and forwards the abort signal", async () => {
  const transport = vi.fn<typeof fetch>(async () => Response.json(record));
  const controller = new AbortController();
  await expect(createKnowledgeRebuildClient(transport).read(courseId, controller.signal)).resolves.toEqual(record);
  expect(transport).toHaveBeenCalledWith(`/api/opening/courses/${courseId}/knowledge`, expect.objectContaining({ method: "GET", cache: "no-store", signal: controller.signal }));
});

it("keeps the server message and status when the request is rejected", async () => {
  const client = createKnowledgeRebuildClient(async () => Response.json({ error: { code: "NOT_FOUND", message: "找不到这门课程" } }, { status: 404 }));
  const failure = await client.rebuild(courseId, "knowledge-rebuild:key-1").catch((reason: unknown) => reason);
  expect(failure).toBeInstanceOf(KnowledgeRebuildRequestError);
  expect(failure).toMatchObject({ status: 404, message: "找不到这门课程" });
});

it("does not accept a receipt for another job kind or a malformed knowledge record", async () => {
  await expect(createKnowledgeRebuildClient(async () => Response.json({ jobId, kind: "tutor", created: true })).rebuild(courseId, "knowledge-rebuild:key-1")).rejects.toThrow();
  await expect(createKnowledgeRebuildClient(async () => Response.json({ ...record, version: -1 })).read(courseId)).rejects.toThrow();
});
