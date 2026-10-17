import { createHash, randomUUID } from "node:crypto";
import {
  knowledgeSnapshotSchema, openingAdaptivePrefsSchema,
  type ExamBindInput, type ExamCourseBinding, type ExamMaterialBinding, type ExamPack,
  type ExamSkillBinding, type KnowledgeSnapshot, type Scope,
} from "@aistudy/contracts";
import { validateKnowledgeSnapshot } from "@aistudy/domain";
import type { TransactionSql } from "postgres";
import { z } from "zod";
import { learningError } from "./opening-learning-facts";

const sourceVersionsSchema = z.record(z.string().uuid(), z.number().int().nonnegative());
const conflict = (message: string) => learningError("CONFLICT", message);
export type ExamPublicSourceWriter = (source: {
  sourceId: string; version: 0; mime: "text/plain"; body: Uint8Array;
}) => Promise<void>;

async function assertCourseAndMilestone(tx: TransactionSql, scope: Scope, input: ExamBindInput): Promise<void> {
  const rows = await tx`SELECT c.id FROM courses c JOIN workspaces w ON w.id=c.workspace_id
    WHERE c.id=${input.courseId} AND c.workspace_id=${scope.workspaceId}
      AND w.owner_user_id=${scope.ownerUserId} AND c.archived_at IS NULL`;
  if (!rows.length) throw learningError("NOT_FOUND", "课程不存在或已归档");
  if (input.milestoneId === null) return;
  const prefs = await tx`SELECT adaptive_planning FROM workspace_preferences WHERE workspace_id=${scope.workspaceId}`;
  const parsed = openingAdaptivePrefsSchema.safeParse(prefs[0]?.adaptive_planning);
  if (!parsed.success || !parsed.data.courseGoals[input.courseId]?.milestones?.some(item => item.id === input.milestoneId)) {
    throw conflict("所选阶段成果不属于该课程的现有目标，请刷新后重试");
  }
}

/** Validate metadata and readability without loading any learner source content. */
export async function assertExamMaterialAvailable(
  tx: TransactionSql, scope: Scope, sourceId: string, sourceVersion: number,
): Promise<void> {
  const rows = await tx`SELECT s.id FROM opening_sources s
    JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=${sourceVersion}
    JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    WHERE s.id=${sourceId} AND s.workspace_id=${scope.workspaceId}
      AND s.upload_state='uploaded' AND s.parse_state='ready' AND s.version>=${sourceVersion}
      AND v.availability='available'
      AND NOT EXISTS (SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)
      AND EXISTS (SELECT 1 FROM opening_source_chunks c WHERE c.source_id=s.id AND c.source_version=${sourceVersion}
        AND (c.text ~ '[^[:space:]]' OR (c.image_object_key IS NOT NULL AND c.image_object_key<>'')))
    FOR SHARE OF s,v`;
  if (!rows.length) throw conflict("材料版本尚未就绪、已删除或已排除，请选择可读取的材料版本");
}

async function addSourceMembership(tx: TransactionSql, scope: Scope, courseId: string, sourceId: string, now: string): Promise<void> {
  await tx`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility,created_at,updated_at)
    VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'reference','private',${now},${now})
    ON CONFLICT(course_id,asset_type,asset_id) DO NOTHING`;
}

async function mapMaterials(tx: TransactionSql, scope: Scope, pack: ExamPack, input: ExamBindInput, now: string): Promise<ExamMaterialBinding[]> {
  const titles = new Set(pack.sourceItems.map(item => item.sourceTitle));
  const seen = new Set<string>();
  for (const material of [...input.materials].sort((a, b) => a.sourceId.localeCompare(b.sourceId))) {
    if (!titles.has(material.sourceTitle) || seen.has(material.sourceTitle)) throw conflict("材料映射包含未知或重复的原材料名称");
    seen.add(material.sourceTitle);
    await assertExamMaterialAvailable(tx, scope, material.sourceId, material.sourceVersion);
    await addSourceMembership(tx, scope, input.courseId, material.sourceId, now);
  }
  return input.materials.map(material => ({ ...material }));
}

/** Whitelist public lesson fields. The question pool is never serialized into the course material. */
async function createPublicPackSource(
  tx: TransactionSql, scope: Scope, pack: ExamPack, courseId: string, now: string, writePublicSource?: ExamPublicSourceWriter,
) {
  const sourceId = randomUUID();
  const sections = [
    { lessonId: null, title: pack.title, text: `${pack.title}\n\n${pack.description}\n\n${pack.limitations.join("\n")}` },
    ...pack.lessons.map(lesson => ({ lessonId: lesson.id, title: lesson.title,
      text: `${lesson.title}\n\n${lesson.summary}\n\n${lesson.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n\n例题讲解\n${lesson.workedExample}\n\n易错点\n${lesson.pitfalls.join("\n")}` })),
  ];
  const body = sections.map(section => section.text).join("\n\n");
  const bytes = Buffer.byteLength(body, "utf8"), digest = createHash("sha256").update(body).digest("hex");
  // Production supplies the object writer. Await it before declaring a source
  // uploaded/ready so ordinary downloads, backups and re-parsing share the same original.
  await writePublicSource?.({ sourceId, version: 0, mime: "text/plain", body: Buffer.from(body, "utf8") });
  await tx`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state,created_at,updated_at)
    VALUES(${sourceId},${scope.workspaceId},${`${pack.title} · 公开串讲`.slice(0, 180)},'text/plain',${bytes},${digest},0,'uploaded','ready',${now},${now})`;
  await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    VALUES(${sourceId},0,${scope.workspaceId},${bytes},${digest},'available')`;
  const lessonChunks = new Map<string, string>();
  for (const [index, section] of sections.entries()) {
    const chunkId = randomUUID();
    await tx`INSERT INTO opening_source_chunks(id,source_id,source_version,page,slide_label,text,created_at)
      VALUES(${chunkId},${sourceId},0,${index + 1},${section.title},${section.text},${now})`;
    if (section.lessonId !== null) lessonChunks.set(section.lessonId, chunkId);
  }
  await addSourceMembership(tx, scope, courseId, sourceId, now);
  return { sourceId, lessonChunks };
}

/**
 * Called once for a new binding in the sprint transaction, after workspace-history,
 * workspace and course locks. The caller persists/replays the returned identities.
 * This references existing goals only; it never changes planning preferences.
 */
export async function ensureExamCourseBinding(
  tx: TransactionSql, scope: Scope, pack: ExamPack, input: ExamBindInput, now: string,
  existing?: ExamCourseBinding, writePublicSource?: ExamPublicSourceWriter,
): Promise<ExamCourseBinding> {
  await assertCourseAndMilestone(tx, scope, input);
  if (input.expectedPackVersion !== pack.version) throw conflict("冲刺题包版本已变化，请刷新后重试");
  if (existing) {
    if (existing.courseId !== input.courseId) throw conflict("冲刺已绑定课程，不可改绑其他课程");
    const seen = new Set<string>();
    for (const mapping of input.skills) {
      if (seen.has(mapping.skillId) || !existing.skills.some(skill => skill.skillId === mapping.skillId && skill.nodeId === mapping.nodeId)) {
        throw conflict("冲刺已有稳定技能映射，不可在更新材料时改变技能身份");
      }
      seen.add(mapping.skillId);
    }
    const materials = await mapMaterials(tx, scope, pack, input, now);
    return { ...existing, milestoneId: input.milestoneId, materials };
  }
  const rows = await tx`SELECT owner_user_id,version,snapshot,source_versions FROM opening_course_knowledge
    WHERE workspace_id=${scope.workspaceId} AND course_id=${input.courseId} FOR UPDATE`;
  const row = rows[0];
  let graph: KnowledgeSnapshot = { courseId: input.courseId, version: 0, nodes: [], edges: [] };
  let sourceVersions: Record<string, number> = {};
  if (row) {
    const parsed = knowledgeSnapshotSchema.safeParse(row.snapshot), versions = sourceVersionsSchema.safeParse(row.source_versions);
    if (row.owner_user_id !== scope.ownerUserId || !parsed.success || !versions.success
      || parsed.data.courseId !== input.courseId || !Number.isInteger(Number(row.version)) || Number(row.version) < 0) {
      throw conflict("课程知识图谱无法校验，未修改现有图谱");
    }
    try { graph = validateKnowledgeSnapshot({ ...parsed.data, version: Number(row.version) }); }
    catch { throw conflict("课程知识图谱无法校验，未修改现有图谱"); }
    sourceVersions = versions.data;
  }
  const skillIds = [...new Set(pack.questions.map(question => question.skillId))];
  const explicit = new Map<string, string>();
  for (const mapping of input.skills) {
    const node = graph.nodes.find(item => item.id === mapping.nodeId);
    if (!skillIds.includes(mapping.skillId) || explicit.has(mapping.skillId)) throw conflict("技能映射包含未知或重复的技能");
    if (!node || node.courseId !== input.courseId || node.kind === "chapter") throw conflict("技能节点不属于所选课程或不是可练习的知识节点");
    explicit.set(mapping.skillId, mapping.nodeId);
  }
  if (!input.createKnowledgeNodes && skillIds.some(skillId => !explicit.has(skillId))) {
    throw conflict("请映射全部技能，或明确允许为缺少的技能建立知识节点");
  }
  const materials = await mapMaterials(tx, scope, pack, input, now);
  const { sourceId, lessonChunks } = await createPublicPackSource(tx, scope, pack, input.courseId, now, writePublicSource);
  const added: KnowledgeSnapshot["nodes"] = [];
  const skills: ExamSkillBinding[] = skillIds.map(skillId => {
    let nodeId = explicit.get(skillId);
    if (!nodeId) {
      nodeId = randomUUID();
      const lessonIds = [...new Set(pack.questions.filter(question => question.skillId === skillId).map(question => question.lessonId))];
      const evidenceChunkIds = lessonIds.map(id => lessonChunks.get(id)).filter((id): id is string => id !== undefined);
      const lesson = pack.lessons.find(item => item.id === lessonIds[0]);
      added.push({ id: nodeId, courseId: input.courseId, label: (lesson?.title ?? skillId).slice(0, 240),
        kind: "problem_type", evidenceChunkIds, status: evidenceChunkIds.length ? "supported" : "suggested" });
    }
    return { skillId, nodeId, requirementKey: `exam-skill:${nodeId}` };
  });
  if (added.length) {
    const next = validateKnowledgeSnapshot({ ...graph, version: graph.version + 1, nodes: [...graph.nodes, ...added] });
    if (added.some(node => node.evidenceChunkIds.length)) sourceVersions[sourceId] = 0;
    await tx`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions,updated_at)
      VALUES(${scope.workspaceId},${scope.ownerUserId},${input.courseId},${next.version},${tx.json(next as never)},${tx.json(sourceVersions)},${now})
      ON CONFLICT(workspace_id,course_id) DO UPDATE SET version=EXCLUDED.version,snapshot=EXCLUDED.snapshot,
        source_versions=EXCLUDED.source_versions,updated_at=EXCLUDED.updated_at`;
  }
  return { courseId: input.courseId, milestoneId: input.milestoneId, packSourceId: sourceId, boundAt: now, skills, materials };
}
