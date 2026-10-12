import { notFound } from "next/navigation";

export default async function PracticeResultPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  } else {
    const { PracticeResult } = await import("../../../../../../features/practice/practice-result");
    return <PracticeResult />;
  }
}
