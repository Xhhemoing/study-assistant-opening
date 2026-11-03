"use client";

import type { ActivitySpecClientInit } from "@aistudy/contracts";
import { CLOSED_CAPABILITIES } from "@aistudy/config/public";
import { OpeningCapabilitiesContext } from "../capabilities/capabilities-provider";
import { BlockRenderer } from "../teaching/block-renderer";
import { readSchemaVersion } from "../teaching/component-catalog";

export function CourseHandoutReader({ courseId, init, generateStatus }: {
  courseId: string;
  init: ActivitySpecClientInit;
  generateStatus: "ready" | "needs_check";
}) {
  const schemaVersion = readSchemaVersion(init);
  return <main className="mx-auto w-full max-w-3xl space-y-6 px-5 py-6">
    <a className="text-sm text-accent underline underline-offset-4" href={`/opening/courses/${courseId}?tab=units`}>返回课程</a>
    <header className="space-y-2">
      <h1 className="text-xl font-semibold text-text">只读讲义</h1>
      <p className="text-sm text-text-2">{generateStatus === "needs_check" || init.verificationStatus === "needs_check" ? "待核对" : "已保存"} · 此页仅供阅读，不保存作答。</p>
    </header>
    <OpeningCapabilitiesContext.Provider value={CLOSED_CAPABILITIES}>
      <section className="space-y-5" aria-label="讲义正文">
        {init.blocks.map(block => <BlockRenderer key={block.blockId} block={block} schemaVersion={schemaVersion} sourceRefs={init.sourceRefs} />)}
      </section>
    </OpeningCapabilitiesContext.Provider>
  </main>;
}
