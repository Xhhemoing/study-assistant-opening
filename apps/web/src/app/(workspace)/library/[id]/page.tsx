import { redirect } from "next/navigation";
import { openingAliasHref, type LegacySearchParams } from "@/features/opening/shell/legacy-routes";

export default async function LegacyDocumentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<LegacySearchParams> }) {
  redirect(openingAliasHref(`/opening/library/${encodeURIComponent((await params).id)}`, await searchParams));
}
