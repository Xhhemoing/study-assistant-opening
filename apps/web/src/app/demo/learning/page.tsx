import type { Metadata } from "next";
import { AuthGate } from "../../../features/auth/auth-gate";
import { DemoLesson } from "../../../features/opening/demo/demo-lesson";

export const metadata: Metadata = {
  title: "静态学习示例 · AIstudy",
  description: "无需模型和 AI 预算的隔离学习示例，不生成正式学习记录。",
};

export default function DemoLearningPage() {
  return <AuthGate><DemoLesson /></AuthGate>;
}
