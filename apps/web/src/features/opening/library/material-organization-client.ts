import { z } from "zod";

export type MaterialCourse = { id: string; title: string; archived: boolean };
export type MaterialMembership = { courseId: string; sourceId: string; role: string };
export type MaterialOrganization = { courses: MaterialCourse[]; memberships: MaterialMembership[] };
export type OrganizationResult = { succeeded: string[]; failed: Array<{ id: string; message: string }> };
const organizationSchema = z.object({ courses: z.array(z.object({ id: z.string().uuid(), title: z.string(), archived: z.boolean() })), memberships: z.array(z.object({ courseId: z.string().uuid(), sourceId: z.string().uuid(), role: z.string() })) });
const errorSchema = z.object({ error: z.object({ message: z.string().optional(), code: z.string().optional() }).optional() });
export function createMaterialOrganizationClient(fetcher: typeof fetch = fetch) {
  async function read(): Promise<MaterialOrganization> {
    const response = await fetcher("/api/opening/material-organization", { cache: "no-store" });
    if (!response.ok) throw new Error(`material organization read failed (${response.status})`);
    return organizationSchema.parse(await response.json());
  }
  async function addToCourse(courseId: string, sourceIds: string[], role: "core" | "optional" | "reference"): Promise<OrganizationResult> {
    const succeeded: string[] = [], failed: Array<{ id: string; message: string }> = [];
    for (const sourceId of [...new Set(sourceIds)]) {
      let response: Response;
      try { response = await fetcher(`/api/courses/${courseId}/memberships`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetType: "source", assetId: sourceId, role, sortOrder: 0, visibility: "private" }) }); }
      catch { failed.push({ id: sourceId, message: "网络中断，结果尚未确认；请刷新后重试" }); continue; }
      if (response.ok) { succeeded.push(sourceId); continue; }
      const body = errorSchema.safeParse(await response.json().catch(() => null));
      if (response.status === 409) {
        try {
          const current = await read();
          if (current.memberships.some(item => item.courseId === courseId && item.sourceId === sourceId)) { succeeded.push(sourceId); continue; }
        } catch { /* Unverified conflicts remain failures, never assumed successful. */ }
      }
      failed.push({ id: sourceId, message: body.success ? body.data.error?.message ?? `request failed (${response.status})` : `request failed (${response.status})` });
    }
    return { succeeded, failed };
  }
  async function removeFromCourse(courseId: string, sourceIds: string[]): Promise<OrganizationResult> {
    const succeeded: string[] = [], failed: Array<{ id: string; message: string }> = [];
    for (const sourceId of [...new Set(sourceIds)]) {
      let response: Response;
      try { response = await fetcher(`/api/courses/${courseId}/memberships`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ assetType: "source", assetId: sourceId }) }); }
      catch { failed.push({ id: sourceId, message: "网络中断，结果尚未确认；请刷新后重试" }); continue; }
      if (response.ok) succeeded.push(sourceId);
      else failed.push({ id: sourceId, message: `request failed (${response.status})` });
    }
    return { succeeded, failed };
  }
  async function createCourse(title: string): Promise<{ id: string; title: string }> {
    const response = await fetcher("/api/courses", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: title.trim(), slug: `materials-${crypto.randomUUID()}` }) });
    if (!response.ok) throw new Error(`课程创建失败 (${response.status})`);
    return z.object({ course: z.object({ id: z.string().uuid(), title: z.string() }) }).parse(await response.json()).course;
  }
  return { read, addToCourse, removeFromCourse, createCourse };
}
