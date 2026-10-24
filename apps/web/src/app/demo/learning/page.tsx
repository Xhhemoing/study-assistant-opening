import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { loadFeatureSwitches } from "@aistudy/config";
import { AuthGate } from "../../../features/auth/auth-gate";
import { DemoLesson } from "../../../features/opening/demo/demo-lesson";

export const metadata: Metadata = {
  title: "静态学习示例 · AIstudy",
  description: "无需模型和 AI 预算的隔离学习示例，不生成正式学习记录。",
};
export const dynamic = "force-dynamic";

export default function DemoLearningPage() {
  if (!loadFeatureSwitches().explorePreview) notFound();
  return <AuthGate><DemoLesson /></AuthGate>;
}
