import { notFound } from "next/navigation";

export default async function GoalsPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  } else {
    const { GoalList } = await import("../../../../features/goals/goal-list");
    return <GoalList />;
  }
}
