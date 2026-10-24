import { loadWorkerStartupConfig } from "@aistudy/config";
import { loadParserConfig } from "./parser-config";
import { preflightParser } from "./parser-preflight";
import { probeParserOcr } from "./ocr-health";

async function warmup() {
  loadWorkerStartupConfig();
  const runner = await preflightParser(loadParserConfig(), true);
  const health = await probeParserOcr(runner);
  if (health.status === "missing_files" || health.status === "preflight_failed") throw new Error("Parser OCR warmup failed");
  console.log(`Parser preflight warmed; OCR=${health.status}. This is not consumer readiness.`);
}
void warmup().catch(error => {
  console.error(error instanceof Error ? error.message : "Parser warmup failed");
  process.exitCode = 1;
});
