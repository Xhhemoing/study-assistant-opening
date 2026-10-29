import { execFileSync } from "node:child_process";
import { open, readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { dialogueFixtureSchema } from "../packages/domain/src/opening/tutor-dialogue-evaluation";
import { assertDialogueDatabase, collectTutorDialogue } from "./lib/tutor-dialogue";

async function main() {
  const { values } = parseArgs({ options: {
    fixture: { type: "string" }, model: { type: "string" }, "base-url-env": { type: "string" }, "key-env": { type: "string" },
    "max-requests": { type: "string" }, output: { type: "string" }, case: { type: "string" },
  }, strict: true });
  for (const name of ["fixture", "model", "base-url-env", "key-env", "max-requests", "output"] as const) {
    if (!values[name]) throw new Error(`Missing --${name}`);
  }
  assertDialogueDatabase();
  const fixturePath = await realpath(values.fixture!), outputPath = resolve(values.output!);
  if (fixturePath === outputPath) throw new Error("Output cannot overwrite fixture");
  const fixture = dialogueFixtureSchema.parse(JSON.parse(await readFile(fixturePath, "utf8")));
  const cases = values.case ? fixture.cases.filter(item => item.caseId === values.case) : fixture.cases;
  if (!cases.length) throw new Error("Unknown --case");
  const baseUrl = process.env[values["base-url-env"]!], apiKey = process.env[values["key-env"]!];
  if (!baseUrl || !apiKey) throw new Error("Provider environment variables are missing");
  const maxRequests = Number(values["max-requests"]);
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 12) throw new Error("max-requests must be 1..12");
  const git = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const output = await open(outputPath, "wx", 0o600);
  const save = async (report: unknown) => {
    const data = Buffer.from(`${JSON.stringify(report, null, 2)}\n`);
    await output.write(data, 0, data.length, 0); await output.truncate(data.length); await output.sync();
  };
  try {
    const report = await collectTutorDialogue({ cases, fixtureVersion: fixture.version, git, model: values.model!, baseUrl, apiKey, maxRequests, checkpoint: save });
    console.log(JSON.stringify({ output: outputPath, passed: report.passed, requests: report.requests.length, cases: report.cases.length, errors: report.errors }));
    if (!report.passed) process.exitCode = 1;
  } finally { await output.close(); }
}
void main().catch(error => { console.error(error instanceof Error ? error.message : "Dialogue collection failed"); process.exitCode = 1; });
