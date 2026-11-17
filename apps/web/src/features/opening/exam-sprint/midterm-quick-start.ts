import "server-only";
import { createHash, randomUUID } from "node:crypto";
import type { ExamMaterialBinding, SourceRecord } from "@aistudy/contracts";
import { CourseMembershipError, createOpeningPrivacyRepository, UPLOAD_TTL_EXPIRED_ERROR } from "@aistudy/database";
import { EXAM_SPRINT_PACK } from "@aistudy/domain/exam-sprint-catalog";
import type { Principal } from "../../../lib/authorization";
import {
  addMembershipForPrincipal, ApiError, createCourseForPrincipal, listCourseAssetsForPrincipal,
  listCoursesForPrincipal, type AuthRuntime,
} from "../../auth/service";
import { createOpeningSourceService } from "../sources/source-service";
import { locateMidtermPdfs, readMidtermPdf, type MidtermPdf } from "./midterm-quick-start-files";
import { getExamIntegrationService, getExamSprintService } from "./runtime";

const title = "高数期中 Topic 1–5";
const slug = "math-i-midterm";
type Result = { pending: true } | { courseId: string; href: string };
const inProgress = new Map<string, Promise<Result>>();

function uploadId(workspaceId: string, name: string, generation: number): string {
  // The upload API requires a stable UUID for retries across process restarts.
  const key = `math-i-midterm:${workspaceId}:${name}`;
  const id = createHash("sha256").update(generation ? `${key}:${generation}` : key).digest("hex");
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-8${id.slice(13, 16)}-8${id.slice(17, 20)}-${id.slice(20, 32)}`;
}

const conflict = (message: string) => new ApiError("CONFLICT", message, 409);

async function existingCourse(runtime: AuthRuntime, principal: Principal, boundCourseId: string | undefined) {
  const courses = await listCoursesForPrincipal(runtime, principal, true);
  const matching = courses.filter(course => course.title === title && !course.archivedAt);
  const bound = matching.find(course => course.id === boundCourseId);
  if (boundCourseId && !bound) throw conflict("冲刺已绑定其他课程，请从原课程进入冲刺。");
  if (bound) return bound;
  if (matching.length > 1) throw conflict("有多个同名的高数期中课程，请在课程列表确认后重试。");
  if (matching[0]) return matching[0];
  if (courses.some(course => course.title === title || course.slug === slug)) {
    throw conflict("已有归档或同标识的高数课程，请在课程列表确认后重试。");
  }
  return null;
}

async function importPdf(
  service: ReturnType<typeof createOpeningSourceService>, principal: Principal, file: MidtermPdf,
  id: string, sha256: string,
) {
  const { body, metadata } = await readMidtermPdf(file);
  if (metadata.sha256 !== sha256) throw conflict("本地资料已变化，请先在课程资料中确认原版本。");
  const ticket = await service.beginUpload(principal, { ...metadata, uploadId: id });
  await service.putStaging(principal, ticket.source.id, { contentType: metadata.mime, bytes: body });
  return service.completeUpload(principal, ticket.source.id);
}

async function addCoursePdf(runtime: AuthRuntime, principal: Principal, courseId: string, source: SourceRecord, file: MidtermPdf) {
  try {
    await addMembershipForPrincipal(runtime, principal, courseId, {
      assetType: "source", assetId: source.id, role: file.exercise ? "reference" : "core",
      visibility: "private", purpose: file.exercise ? "practice" : "teaching",
    });
  } catch (error) {
    if (!(error instanceof CourseMembershipError) || error.code !== "DUPLICATE_MEMBERSHIP") throw error;
  }
}

async function prepare(runtime: AuthRuntime, principal: Principal, directory: string): Promise<Result> {
  const scope = { workspaceId: principal.workspaceId, ownerUserId: principal.userId };
  const integration = getExamIntegrationService(runtime.sql);
  const sprint = getExamSprintService(runtime.sql);
  const [overview, { binding }] = await Promise.all([sprint.read(scope), integration.read(scope)]);
  if (overview.pack.id !== EXAM_SPRINT_PACK.id) throw conflict("当前冲刺题包与高数期中资料不匹配。");
  let course = await existingCourse(runtime, principal, binding?.courseId);
  const files = await locateMidtermPdfs(directory);
  const service = createOpeningSourceService(runtime.sql);
  const [allSources, assets, excludedIds] = await Promise.all([
    service.listSources(principal), course ? listCourseAssetsForPrincipal(runtime, principal, course.id) : [],
    createOpeningPrivacyRepository(runtime.sql).listExcludedSourceIds(scope),
  ]);
  const sources = new Map(allSources.map(source => [source.id, source]));
  const attached = new Set(assets.flatMap(asset => asset.source ? [asset.source.id] : []));
  const excluded = new Set(excludedIds);
  const pinned = new Map(binding?.materials.map(material => [material.sourceTitle, material]));
  const imports = [];
  // Validate the complete batch and existing pins before writing any source or membership.
  for (const file of files) {
    const { metadata } = await readMidtermPdf(file);
    const sameBytes = (source: SourceRecord) => source.mime === metadata.mime
      && source.sha256.toLowerCase() === metadata.sha256 && source.bytes === metadata.bytes;
    const matches = (source: SourceRecord) => source.name === file.name && sameBytes(source);
    const matching = allSources.filter(matches);
    if (allSources.some(source => excluded.has(source.id) && sameBytes(source))) {
      throw conflict("期中资料曾被排除或删除，请在资料库确认后重试。");
    }
    let generation = 0;
    let id: string;
    let previous: SourceRecord | undefined;
    do {
      id = uploadId(principal.workspaceId, file.name, generation++);
      if (excluded.has(id)) throw conflict("期中资料曾被排除或删除，请在资料库确认后重试。");
      previous = sources.get(id);
      if (previous && !matches(previous)) throw conflict("本地资料已变化，请先在课程资料中确认原版本。");
    } while (previous?.uploadState === "rejected" && previous.error?.code === UPLOAD_TTL_EXPIRED_ERROR.code);
    const pin = file.exercise ? pinned.get(file.name) : undefined;
    const pinnedSource = pin ? matching.find(source => source.id === pin.sourceId && source.version === pin.sourceVersion
      && source.uploadState === "uploaded" && source.parseState === "ready") : undefined;
    if (pin && !pinnedSource) throw conflict("原题材料已有其他或不可读的版本，请在冲刺页确认后重试。");
    const reusable = matching.filter(source => source.uploadState === "uploaded");
    const source = pinnedSource ?? (previous?.uploadState === "uploaded" ? previous : undefined)
      ?? reusable.find(source => attached.has(source.id)) ?? reusable[0];
    imports.push({ file, id, sha256: metadata.sha256, source });
  }
  if (!course) {
    try {
      course = await createCourseForPrincipal(runtime, principal, { title, slug, description: "Mathematics I" });
    } catch (error) {
      if (!(error instanceof CourseMembershipError) || error.code !== "CONFLICT") throw error;
      course = await existingCourse(runtime, principal, undefined);
      if (!course) throw error;
    }
  }

  const materials: ExamMaterialBinding[] = [];
  let pending = false;
  let failed = false;

  for (const { file, id, sha256, source: reused } of imports) {
    const source = reused ?? await importPdf(service, principal, file, id, sha256);
    if (!attached.has(source.id)) await addCoursePdf(runtime, principal, course.id, source, file);
    if (!file.exercise) continue;

    if (source.parseState === "ready") {
      materials.push({ sourceTitle: file.name, sourceId: source.id, sourceVersion: source.version });
    } else if (source.parseState === "failed" || source.parseState === "unsupported") {
      failed = true;
    } else {
      pending = true;
    }
  }
  if (failed) throw new ApiError("SERVICE_UNAVAILABLE", "部分原题解析失败，请在课程资料中重试解析，再打开冲刺。", 503);
  if (pending) return { pending: true };

  await integration.bind(scope, {
    courseId: course.id, materials, expectedPackVersion: overview.pack.version,
    clientKey: randomUUID(), milestoneId: null, createKnowledgeNodes: true, skills: [],
  }, { addMissingMaterials: true });
  // Re-read after import and binding to avoid starting over a round opened meanwhile.
  if (!(await sprint.read(scope)).activeRun) {
    try {
      await sprint.act(scope, { action: "start", mode: "practice", topicId: "topic-1", clientKey: `math-i-midterm:${course.id}` });
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "CONFLICT") || !(await sprint.read(scope)).activeRun) throw error;
    }
  }
  return { courseId: course.id, href: `/opening/courses/${course.id}?mode=sprint` };
}

export async function startMidtermSprint(runtime: AuthRuntime, principal: Principal, directory: string): Promise<Result> {
  const key = principal.workspaceId;
  const pending = inProgress.get(key);
  if (pending) return pending;
  const run = prepare(runtime, principal, directory);
  inProgress.set(key, run);
  try {
    return await run;
  } finally {
    inProgress.delete(key);
  }
}
