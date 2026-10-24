import { isDeepStrictEqual } from "node:util";
import type { MaterialManifest, MaterialQuestionIdentity, Scope } from "@aistudy/contracts";
import { materialQuestionIdentitySchema } from "@aistudy/contracts";
import type { Sql, TransactionSql } from "postgres";
import { learningError } from "./opening-learning-facts";
import { readMaterialManifest } from "./opening-material-manifest";
import { materialQuestionSpec } from "./opening-material-questions";

type DB = Sql | TransactionSql;
type Question = MaterialManifest["questions"][number];
export type OpeningMaterialIdentityRecord = {
  problemId: string;
  courseId: string;
  sourceId: string | null;
  sourceVersion: number | null;
  page: number | null;
  stem: string;
  evaluationSpec?: unknown;
};
type Input = { courseId: string } & (
  | { identity: MaterialQuestionIdentity; existingRecord?: never }
  | { identity?: never; existingRecord: OpeningMaterialIdentityRecord }
);
type Snapshot = {
  problem_id: string;
  physical_page: number | null;
  stem_snapshot: string;
  evaluation_spec: unknown;
};
export type OpeningMaterialIdentity = {
  problemId: string | null;
  question: Question;
  spec: ReturnType<typeof materialQuestionSpec>;
};
const needsReview = () => learningError("CONFLICT", "资料原题与旧题身份无法唯一对应，历史答案或帮助曝光待核对；请先核对题目身份，不能另建未见题或继续评分。");
const key = (q: Pick<Question, "family" | "number" | "subquestion">) => JSON.stringify([q.family, q.number, q.subquestion]);
const sameBody = (row: Snapshot, q: Question) => row.physical_page === q.page && row.stem_snapshot === q.stem;

/** Resolve a classified question without rewriting refs, immutable items or grades.
 * Callers that write must hold the workspace/course history locks. All discovery
 * is limited to this owner/course/source/version, never a whole-bank text match.
 * A legacy item without a unique page+stem link is NOT proof of an unseen item.
 */
export async function resolveOpeningMaterialIdentity(db: DB, scope: Scope, input: Input): Promise<OpeningMaterialIdentity | null> {
  const record = input.existingRecord;
  if (record && record.courseId !== input.courseId) throw needsReview();
  const sourceId = input.identity?.sourceId ?? record?.sourceId;
  const version = input.identity?.sourceVersion ?? record?.sourceVersion;
  // A mutable ref (or an incomplete restore) cannot detach a canonical problem
  // from its saved source and then reopen it as an unclassified/text-only item.
  const savedItems = record ? await db`SELECT v.source_id,v.source_version,v.evaluation_spec,sv.material_manifest
    FROM opening_learning_item_versions v LEFT JOIN opening_source_versions sv
      ON sv.source_id=v.source_id AND sv.version=v.source_version AND sv.workspace_id=v.workspace_id
    WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${input.courseId}
      AND v.problem_id=${record.problemId}` : [];
  const hasCanonicalIdentity = savedItems.some(item => item.evaluation_spec?.kind === "material_question")
    || (record?.evaluationSpec as { kind?: string } | null)?.kind === "material_question";
  for (const item of savedItems) {
    if ((item.evaluation_spec?.kind === "material_question" || readMaterialManifest(item.material_manifest)?.questions.length)
      && (item.source_id !== sourceId || item.source_version !== version)) throw needsReview();
  }
  if (!sourceId) {
    if (hasCanonicalIdentity) throw needsReview();
    return null;
  }
  const [source] = await db`SELECT s.version,v.material_manifest,current_version.material_manifest AS current_manifest FROM opening_sources s
    JOIN workspaces w ON w.id=s.workspace_id AND w.owner_user_id=${scope.ownerUserId}
    LEFT JOIN opening_source_versions v ON v.source_id=s.id AND v.workspace_id=s.workspace_id AND v.version=${version ?? null}::int
    LEFT JOIN opening_source_versions current_version ON current_version.source_id=s.id
      AND current_version.workspace_id=s.workspace_id AND current_version.version=s.version
    WHERE s.id=${sourceId} AND s.workspace_id=${scope.workspaceId} AND s.upload_state='uploaded'
      AND NOT EXISTS(SELECT 1 FROM opening_privacy_exclusions e WHERE e.workspace_id=s.workspace_id AND e.source_id=s.id)`;
  if (!source) throw learningError("CONFLICT", "题目资料不可读取，请先核对来源版本");
  const manifest = readMaterialManifest(source.material_manifest);
  if (!manifest) {
    if (input.identity || source.current_manifest != null || hasCanonicalIdentity) throw needsReview();
    return null;
  }
  if (version == null || Number(source.version) !== version) throw needsReview();
  if (!manifest.questions.length) {
    // Role-only classification does not manufacture a question identity. The
    // caller still enforces page readability for answer/solution/mixed pages.
    if (input.identity || hasCanonicalIdentity) throw needsReview();
    return null;
  }
  const questions = manifest.questions;
  const requested = input.identity ? questions.find(q => key(q) === key(input.identity!)) : undefined;
  if (input.identity && !requested) throw needsReview();

  // Include refs predating item versions AND immutable snapshots whose mutable
  // ref was later changed. Neither can silently disappear from exposure history.
  const snapshots = await db<Snapshot[]>`SELECT p.problem_id,p.physical_page,p.stem_snapshot,NULL::jsonb AS evaluation_spec
    FROM opening_problem_refs p JOIN opening_learning_sessions l ON l.id=p.session_id AND l.workspace_id=p.workspace_id
    WHERE p.workspace_id=${scope.workspaceId} AND l.owner_user_id=${scope.ownerUserId} AND l.course_id=${input.courseId}
      AND p.source_id=${sourceId} AND p.source_version=${version}
    UNION ALL
    SELECT v.problem_id,v.physical_page,v.stem_snapshot,v.evaluation_spec FROM opening_learning_item_versions v
    WHERE v.workspace_id=${scope.workspaceId} AND v.owner_user_id=${scope.ownerUserId} AND v.course_id=${input.courseId}
      AND v.source_id=${sourceId} AND v.source_version=${version}`;
  const byProblem = new Map<string, Snapshot[]>();
  for (const row of snapshots) {
    const rows = byProblem.get(row.problem_id) ?? [];
    rows.push(row); byProblem.set(row.problem_id, rows);
  }
  const mapped = new Map<string, Question>();
  for (const [problemId, rows] of byProblem) {
    let question: Question | undefined;
    for (const row of rows) {
      if (row.evaluation_spec == null) continue;
      const { kind, ...raw } = row.evaluation_spec as Record<string, unknown>;
      const parsed = materialQuestionIdentitySchema.safeParse(raw);
      if (kind !== "material_question" || !parsed.success || parsed.data.sourceId !== sourceId
        || parsed.data.sourceVersion !== version) throw needsReview();
      const canonical = questions.find(q => key(q) === key(parsed.data));
      if (!canonical || question && key(question) !== key(canonical)) throw needsReview();
      question = canonical;
    }
    if (question) {
      if (rows.some(row => !sameBody(row, question!))) throw needsReview();
    } else {
      // Repeated numbers are resolved only by the saved family/subquestion spec.
      // If legacy page+stem fits two such keys, choosing either erases uncertainty.
      const matches = questions.filter(q => rows.every(row => sameBody(row, q)));
      if (matches.length !== 1) throw needsReview();
      question = matches[0]!;
    }
    mapped.set(problemId, question);
  }
  const question = requested ?? (record ? mapped.get(record.problemId) : undefined);
  if (!question) throw needsReview();
  const matches = [...mapped].filter(([, q]) => key(q) === key(question)).map(([id]) => id);
  if (matches.length > 1 || record && (matches.length !== 1 || matches[0] !== record.problemId)) throw needsReview();
  const spec = materialQuestionSpec({ sourceId, sourceVersion: version, family: question.family,
    number: question.number, subquestion: question.subquestion });
  if (record && (record.page !== question.page || record.stem !== question.stem
    || record.evaluationSpec != null && !isDeepStrictEqual(record.evaluationSpec, spec))) throw needsReview();
  return { problemId: matches[0] ?? null, question, spec };
}
