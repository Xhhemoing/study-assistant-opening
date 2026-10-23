#!/usr/bin/env -S node --import tsx
import { open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gradingEvaluationDatasetSchema } from "@aistudy/contracts";
import { collectGradingRun } from "../packages/ai/src/opening/grading-collection";
import type { OpeningFetch } from "../packages/ai/src/opening/provider";
import { assertOpeningProviderEndpoint } from "../packages/ai/src/opening/provider-network";

const usage = "Usage: node --import tsx scripts/study-grading-collect.ts --dataset FILE --model MODEL --base-url-env ENV_NAME --api-key-env ENV_NAME --max-requests N --output NEW_FILE [--timeout-ms N]";

async function writePrivate(file: FileHandle, value: unknown) {
  const text = JSON.stringify(value, null, 2) + "\n";
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset, offset);
    if (!bytesWritten) throw new Error("Incomplete collection output write");
    offset += bytesWritten;
  }
  await file.truncate(bytes.length);
}

/** CLI has no default model, credential name or request budget. Output never goes to stdout. */
export async function runGradingCollectionCli(args: string[], environment: NodeJS.ProcessEnv = process.env, fixtureTransport?: OpeningFetch) {
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!, value = args[index + 1];
    if (!["--dataset", "--model", "--base-url-env", "--api-key-env", "--max-requests", "--output", "--timeout-ms"].includes(key)
      || !value || value.startsWith("--") || options.has(key)) throw new Error("Invalid collection options");
    options.set(key, value);
  }
  if (["--dataset", "--model", "--base-url-env", "--api-key-env", "--max-requests", "--output"].some(key => !options.has(key))) throw new Error("Missing required collection options");
  const readEnvironment = (key: string) => {
    const name = options.get(key)!;
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || !environment[name]?.trim()) throw new Error("Missing or invalid provider environment setting");
    return environment[name]!.trim();
  };
  const baseUrl = readEnvironment("--base-url-env"), apiKey = readEnvironment("--api-key-env");
  assertOpeningProviderEndpoint(baseUrl);
  const model = options.get("--model")!.trim();
  if (!model || model.length > 160) throw new Error("Invalid model name");
  const limit = options.get("--max-requests")!;
  if (!/^[1-9]\d{0,3}$/.test(limit) || Number(limit) > 1000) throw new Error("Invalid request limit");
  const timeout = options.get("--timeout-ms");
  if (timeout && (!/^\d+$/.test(timeout) || Number(timeout) < 1000 || Number(timeout) > 120_000)) throw new Error("Invalid timeout");
  const inputPath = resolve(options.get("--dataset")!), outputPath = resolve(options.get("--output")!);
  const collectionPath = `${outputPath}.collection.json`;
  if (inputPath === outputPath || inputPath === collectionPath) throw new Error("Output must not overwrite input");
  const dataset = gradingEvaluationDatasetSchema.parse(JSON.parse(await readFile(inputPath, "utf8")));
  let resultFile: FileHandle | undefined, collectionFile: FileHandle | undefined;
  try {
    resultFile = await open(outputPath, "wx", 0o600);
    try { collectionFile = await open(collectionPath, "wx", 0o600); }
    catch (error) { await resultFile.close(); resultFile = undefined; await unlink(outputPath); throw error; }
    const output = await collectGradingRun(dataset, { baseUrl, apiKey, model,
      maxRequests: Number(limit), ...(timeout ? { timeoutMs: Number(timeout) } : {}), fetchImpl: fixtureTransport,
      onProgress: async snapshot => { await writePrivate(resultFile!, snapshot.run); await writePrivate(collectionFile!, snapshot.collection); },
    });
    return { requestCount: output.collection.requestCount,
      validOutputs: output.collection.cases.filter(item => item.status === "valid_output").length,
      failed: output.collection.cases.filter(item => item.status === "provider_error" || item.status === "invalid_model_output").length,
      skipped: output.collection.cases.filter(item => item.status === "photo_not_supported" || item.status === "request_limit_reached").length };
  } finally { await resultFile?.close(); await collectionFile?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.slice(2).includes("--help")) console.log(usage);
  else runGradingCollectionCli(process.argv.slice(2)).then(summary => console.log(JSON.stringify(summary))).catch(() => {
    // Provider errors, JSON parser errors and filesystem errors can contain private data.
    console.error("Grading collection failed. Check options, input data and new output paths; no automatic retry was made.");
    process.exitCode = 1;
  });
}
