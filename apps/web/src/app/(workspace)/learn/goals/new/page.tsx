import { notFound } from "next/navigation";

export default async function NewGoalPage({
  searchParams,
}: {
  searchParams: Promise<{ courseId?: string }>;
}) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  } else {
    const { courseId } = await searchParams;
    const { GoalWizard } = await import("../../../../../features/goals/goal-wizard");
    return <GoalWizard courseId={courseId ?? null} />;
  }
}
