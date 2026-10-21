import { redirect } from "next/navigation";
import { assistantRedirect } from "@/features/opening/assistant/assistant-entry";

export default async function OpeningAssistantPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  redirect(assistantRedirect(await searchParams));
}
