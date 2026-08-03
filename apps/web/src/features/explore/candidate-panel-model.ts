import type { PromotionCandidate } from "@aistudy/contracts";

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
