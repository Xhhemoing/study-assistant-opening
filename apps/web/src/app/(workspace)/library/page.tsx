import { redirect } from "next/navigation";
import { openingAliasHref, type LegacySearchParams } from "@/features/opening/shell/legacy-routes";

export default async function LegacyPage({ searchParams }: { searchParams: Promise<LegacySearchParams> }) {
  redirect(openingAliasHref("/opening/library", await searchParams));
}
