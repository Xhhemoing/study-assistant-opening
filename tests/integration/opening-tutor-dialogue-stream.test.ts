import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { collectTutorStreamSafety } from "../../scripts/lib/tutor-dialogue";

it("collects real stream success and midway job cancellation without duplicate delivery or spend", async () => {
  const redisUrl = process.env.D1_STREAM_REDIS_URL;
  if (!redisUrl) throw new Error("Set D1_STREAM_REDIS_URL to an existing isolated loopback Redis; no service is started");
  const report = await collectTutorStreamSafety({ git: "synthetic-stream-integration", redisUrl });
  if (process.env.D1_STREAM_REPORT) await writeFile(process.env.D1_STREAM_REPORT, JSON.stringify(report, null, 2), { mode: 0o600 });
  expect(report.errors).toEqual([]);
  expect(report.passed).toBe(true);
  expect(report.transport).toBe("controlled_provider");
  expect(report.requests).toHaveLength(2);
  expect(report.cases.map(row => [row.caseId, row.status])).toEqual([["stream_success", "passed"], ["stream_cancel", "passed"]]);
  expect(report.unknown).toMatchObject({ browser: "not_run", learningEffect: "unknown", privacyRace: "not_run" });
}, 20000);
