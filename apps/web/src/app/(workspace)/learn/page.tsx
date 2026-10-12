import { notFound } from "next/navigation";

export default async function LearnPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  } else {
    const { TodayPlanView } = await import("../../../features/learn/today-plan-view");
    return <TodayPlanView />;
  }
}
