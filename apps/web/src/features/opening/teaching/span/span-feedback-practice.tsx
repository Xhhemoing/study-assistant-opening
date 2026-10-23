import type { LearningObservation } from "@aistudy/contracts";
import { FeedbackPractice } from "../../learning/feedback-practice";

export function spanFeedbackPractice(record: LearningObservation) {
  const result = record.serverEvaluation;
  if (!result || result.evaluatorVersion !== "span-exact-v1" || result.decision === "abstain") return null;
  if (result.skills?.geometry === "incorrect") return {
    prompt: "v=(1,2)，w=(2,4)。所有 αv+βw 会铺满平面，还是只在一条直线上？",
    options: [{ id: "A", label: "平面" }, { id: "B", label: "直线" }], answerId: "B",
    explanation: "因为 w=2v，所以 αv+βw=(α+2β)v，始终沿着 v 的方向，只形成一条直线。",
  };
  const correct = result.decision === "correct";
  return correct ? {
    prompt: "换一个数：v=(1,0,1)，w=(0,1,1)。u=(3,−2,1) 在 span{v,w} 中吗？",
    options: [{ id: "A", label: "在，α=3，β=−2" }, { id: "B", label: "不在，因为有负数" }], answerId: "A",
    explanation: "线性组合允许负系数。3v−2w=(3,−2,3−2)=(3,−2,1)，三个坐标都一致。",
  } : {
    prompt: "先只查一个关键点：v=(1,0,1)，w=(0,1,1)，u=(2,3,6)。前两个坐标给出 α=2、β=3，第三个坐标能匹配吗？",
    options: [{ id: "A", label: "能，前两个坐标匹配就够了" }, { id: "B", label: "不能，2+3=5，并不等于6" }], answerId: "B",
    explanation: "判断属于 span 要同时满足每个坐标。前两式确定唯一候选 α=2、β=3，但第三式要求2+3=6，矛盾，因此 u 不在这个 span 中。",
  };
}

export function SpanFeedbackPractice({ record }: { record: LearningObservation }) {
  const question = spanFeedbackPractice(record);
  return question ? <FeedbackPractice key={record.id} question={question} /> : null;
}
