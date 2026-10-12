import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ itemId: string }>;
  searchParams: Promise<{ date?: string | string[]; taskId?: string | string[] }>;
};

function firstQueryValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function PracticePage({ params, searchParams }: Props) {
  if (process.env.NODE_ENV === "production") {
    notFound();
  } else {
    const { itemId } = await params;
    const query = await searchParams;
    const { PracticePlayer } = await import("../../../../../features/practice/practice-player");
    return (
      <PracticePlayer
        itemId={itemId}
        context={{ date: firstQueryValue(query.date), taskId: firstQueryValue(query.taskId) }}
      />
    );
  }
}
