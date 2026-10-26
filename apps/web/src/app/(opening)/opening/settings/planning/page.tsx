import { permanentRedirect } from "next/navigation";
import { settingsRedirectQuery } from "../../../../../features/settings/settings-route-target";

export default async function PlanningPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  permanentRedirect(`/opening/settings/learning${settingsRedirectQuery(await searchParams, { planning: "1" })}`);
}
