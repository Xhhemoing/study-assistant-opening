import { redirect } from "next/navigation";

/** The old isolated demo now leads to the integrated workspace. */
export default function OpeningPreviewPage() {
  redirect("/opening/today");
}
