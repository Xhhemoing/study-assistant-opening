import Link from "next/link";
import type { ReactNode } from "react";
import type { TeachingResumeMaterialsGate } from "@aistudy/contracts";
import { ui } from "../opening/design/ui";
import { materialsGateBannerCopy } from "../opening/teaching/resume-card";

/** A direct resume must keep the same source warnings as the resume card. */
export function CourseStudyMaterials({ gate, materialsHref, onRetry, children }: {
  gate: TeachingResumeMaterialsGate;
  materialsHref: string;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (gate === "available") return <>{children}</>;
  return <>
    <div className="mx-5 mt-4 space-y-2 border-y border-amber-200 py-3 text-xs leading-6 text-amber-900" role="status">
      <p>{materialsGateBannerCopy(gate)}</p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={ui.secondary} onClick={onRetry}>重新核查材料</button>
        <Link className={ui.quiet} href={materialsHref}>查看课程材料</Link>
      </div>
    </div>
    {gate === "partial" ? children : null}
  </>;
}
