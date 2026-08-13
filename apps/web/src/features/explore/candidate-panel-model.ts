import type { PromotionCandidate } from "@aistudy/contracts";
import { normalizeCourseSlug } from "../courses/course-model";

const KIND_LABELS: Record<PromotionCandidate["kind"], string> = {
  note: "笔记候选",
  card: "卡片候选",
  question: "题目候选",
  task: "任务候选",
};

export function pendingCandidates(candidates: PromotionCandidate[]): PromotionCandidate[] {
  return candidates.filter((candidate) => candidate.status === "pending");
}

export function candidateKindLabel(kind: PromotionCandidate["kind"]): string {
  return KIND_LABELS[kind];
}

export function buildCandidateNoteBlocks(candidate: PromotionCandidate, explorationTitle: string) {
  const source = `来源：探索「${explorationTitle}」`;
  return [{
    id: candidate.id,
    type: "paragraph",
    content: {
      blockNoteContent: [{ type: "text", text: `${candidate.body.trim()}\n\n${source}` }],
      props: null,
      children: [],
    },
  }];
}

export interface CandidateCourseDraft {
  title: string;
  slug: string;
  description: string;
}

/**
 * 从候选内容派生一门新课程的创建草稿。
 * 标题无法生成 slug（如纯中文）时回退到带时间戳的 `promoted-*`。
 */
export function candidateCourseDraft(
  candidate: PromotionCandidate,
  now: number = Date.now(),
): CandidateCourseDraft {
  const title = candidate.title.trim() || "未命名课程";
  const slug = normalizeCourseSlug(candidate.title) || `promoted-${now.toString(36)}`;
  const description = candidate.body.trim().slice(0, 500);
  return { title, slug, description };
}
