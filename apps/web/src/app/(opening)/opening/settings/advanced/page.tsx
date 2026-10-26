import { permanentRedirect } from "next/navigation";
import { settingsRedirectQuery } from "../../../../../features/opening/settings/settings-route-target";

export default async function OpeningAdvancedSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  permanentRedirect(`/opening/settings/ai${settingsRedirectQuery(await searchParams)}`);
}
