import { z } from "zod";
import { createOpeningSourceRepository, CourseMembershipError, type OpeningSourceRepository } from "@aistudy/database";
import type { Principal } from "../../../lib/authorization";
import { assertAuthorized } from "../../../lib/authorization";
import { ApiError, createCourseForPrincipal, listCoursesForPrincipal, type AuthRuntime } from "../../auth/service";

const inputSchema = z.object({ sourceId: z.string().uuid(), sourceVersion: z.number().int().nonnegative().optional() }).strict();

/** A learner explicitly starts a photo exercise; preparing it never calls a model. */
export async function preparePhotoPractice(runtime: AuthRuntime, principal: Principal, body: unknown,
  sources: Pick<OpeningSourceRepository, "get"> = createOpeningSourceRepository(runtime.sql)) {
  const input = inputSchema.parse(body);
  const scope = { workspaceId: principal.workspaceId, ownerUserId: principal.userId };
  const source = await sources.get(scope, input.sourceId);
  assertAuthorized(principal, "source.read", { type: "workspace", workspaceId: source.workspaceId });
  if (source.uploadState !== "uploaded" || source.parseState !== "ready") {
    throw new ApiError("CONFLICT", "题目资料还没有解析完成，请稍后重新读取。", 409);
  }
  if (input.sourceVersion !== undefined && source.version !== input.sourceVersion) {
    throw new ApiError("CONFLICT", "题目资料已更新，请重新查看并确认题干。", 409);
  }

  // The existing workspace/slug unique constraint makes retries and concurrent
  // tabs converge, including a lost create response. No per-click course is made.
  const slug = `quick-practice-${principal.userId}`;
  const findCourse = async () => (await listCoursesForPrincipal(runtime, principal, true)).find(course => course.slug === slug);
  let course = await findCourse();
  if (!course) {
    try {
      course = await createCourseForPrincipal(runtime, principal, { title: "随手练习", slug, description: "从拍题开始的练习与学习记录。" });
    } catch (error) {
      if (!(error instanceof CourseMembershipError) || error.code !== "CONFLICT") throw error;
      course = await findCourse();
      if (!course) throw error;
    }
  }
  if (course.archivedAt) throw new ApiError("CONFLICT", "随手练习已归档，请先在课程中恢复，再开始新的作答。", 409);
  assertAuthorized(principal, "course.update", { type: "course", workspaceId: course.workspaceId, courseId: course.id });
  const membership = { workspaceId: scope.workspaceId, courseId: course.id, assetType: "source" as const, assetId: source.id };
  const prepared = { courseId: course.id, sourceId: source.id, sourceVersion: source.version };
  // A lost-response retry is a read once the relationship is already present.
  // Keep the insert conflict path below for two genuinely simultaneous starts.
  try {
    await runtime.courses.getMembership(membership);
    return prepared;
  } catch (error) {
    if (!(error instanceof CourseMembershipError) || error.code !== "NOT_FOUND") throw error;
  }
  try {
    await runtime.courses.addAssetMembership({ ...membership, role: "reference", visibility: "private" });
  } catch (error) {
    if (!(error instanceof CourseMembershipError) || error.code !== "DUPLICATE_MEMBERSHIP") throw error;
    await runtime.courses.getMembership(membership);
  }
  return prepared;
}
