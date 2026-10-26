import { Suspense } from "react";
import { SearchWorkspace } from "@/features/opening/search/search-workspace";

export default function OpeningSearchPage() {
  return <Suspense fallback={null}><SearchWorkspace /></Suspense>;
}
