import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningPdfSegmentsRepository,
  createOpeningSourceChunksRepository, createOpeningSourceEmbeddingsRepository, createOpeningSourceRepository, openingJobScope,
  readOpeningSourceContent, type PdfSegmentPage } from "@aistudy/database";
import { segmentMaterialChunks } from "@aistudy/ai";
import * as network from "../../packages/ai/src/opening/provider-network";
import { createOpeningMaterialRetriever, retrievalBudgetId } from "../../apps/worker/src/runtime/material-retrieval";
import { createParseSourceHandler } from "../../apps/worker/src/jobs/parse-source";
import { createSourceVisualRecognition } from "../../apps/worker/src/runtime/source-visual-recognition";
import { preserveOpeningKnowledgeDefinitions, publicPdfSealBoundaries } from "../../packages/database/src/repositories/opening-knowledge-definitions";
import { createOpeningFixture, type OpeningFixture } from "./opening-fixture";

let f: OpeningFixture;
beforeAll(async () => { f = await createOpeningFixture(); });
afterAll(async () => { await f?.close(); });
const model = { modelKey: "https://embedding.example.test|model|3", dimensions: 3 };

async function seed(text: string | string[], scope = f.scope) {
  const pages = typeof text === "string" ? [text] : text;
  const sourceId = randomUUID();
  await f.sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
    VALUES(${sourceId},${scope.workspaceId},'material.txt','text/plain',${Buffer.byteLength(pages.join(""))},${"ab".repeat(32)},1,'uploaded','running')`;
  await createOpeningSourceChunksRepository(f.sql).replaceChunks(scope, { sourceId, sourceVersion: 1,
    chunks: pages.map((text, i) => ({ text, page: i + 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null })) });
  const repository = createOpeningSourceEmbeddingsRepository(f.sql);
  const snapshot = (await repository.snapshot(scope, sourceId))!;
  await repository.store(scope, snapshot, model, segmentMaterialChunks(snapshot.chunks).map(segment => ({ ...segment, vector: [1, 0, 0] })));
  return { sourceId, snapshot, repository };
}

async function startPdfRetry(sourceId: string, pages: PdfSegmentPage[],
  recognition: Pick<Parameters<typeof createParseSourceHandler>[0], "recognizePage" | "recognizePages"> = {},
  failedStarts: number[] = [], afterPageSeal?: (page: PdfSegmentPage) => Promise<void>) {
  const bytes = Buffer.from("%PDF synthetic retry");
  await f.sql`UPDATE opening_sources SET mime='application/pdf',parse_state='running',bytes=${bytes.length},
    sha256=${createHash("sha256").update(bytes).digest("hex")} WHERE id=${sourceId}`;
  const jobs = createOpeningJobRepository(f.sql);
  const payload = { sourceId, sourceVersion: 1 };
  const job = await jobs.createOnce(f.scope, { kind: "parse", key: randomUUID(), payload,
    privacyEpoch: await jobs.workspacePrivacyEpoch(f.scope.workspaceId) });
  const claimed = await jobs.claim(job.id);
  expect(claimed?.claimToken).toBeTruthy();
  const chunks = createOpeningSourceChunksRepository(f.sql);
  const sources = createOpeningSourceRepository(f.sql);
  const segments = createOpeningPdfSegmentsRepository(f.sql);
  const handler = createParseSourceHandler({
    ...recognition, sources, chunks, tempDir: os.tmpdir(),
    segments: afterPageSeal ? { ...segments, async save(...args) {
      await segments.save(...args);
      const [, identity, segment] = args;
      if (identity.parserProfile === "pdf-publication-page-seal-v1" && segment.state === "ready") {
        await afterPageSeal(segment.pages[0]!);
      }
    } } : segments,
    ...(failedStarts.length ? { segmentPages: 1 } : {}),
    storage: { finalKey: () => "synthetic-original", presignGet: async () => `data:application/pdf;base64,${bytes.toString("base64")}` },
    runner: async argv => {
      if (argv.includes("--inspect-pdf")) return { exitCode: 0, stdout: JSON.stringify({ pageCount: pages.length }) };
      const start = Number(argv[argv.indexOf("--page-start") + 1]);
      const end = Number(argv[argv.indexOf("--page-end") + 1]);
      if (failedStarts.includes(start)) return { exitCode: 4, stdout: "" };
      return { exitCode: 0, stdout: JSON.stringify({ pages: pages.slice(start - 1, end) }) };
    },
  });
  return { chunks, sources, run: () => handler(claimed!, payload),
    finish: (pages: number) => jobs.finish(claimed!.id, "succeeded", { pages }, claimed!.claimToken) };
}

async function backfilledPages(pdf: Awaited<ReturnType<typeof seed>>) {
  const courseId = randomUUID();
  const nodes = pdf.snapshot.chunks.map(chunk => ({
    id: randomUUID(), courseId, label: `Page ${chunk.page}`, kind: "concept",
    evidenceChunkIds: [chunk.id], status: "supported",
  }));
  return f.sql.begin(async tx => {
    await tx`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
      SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${pdf.sourceId} ON CONFLICT DO NOTHING`;
    await tx`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'PDF evidence',${courseId})`;
    await tx`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
      VALUES(${randomUUID()},${f.scope.workspaceId},${courseId},'source',${pdf.sourceId},'core',0,'course')`;
    await tx`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
      VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},1,${tx.json({ courseId, version: 1, nodes, edges: [] })},
        ${tx.json({ [pdf.sourceId]: 1 })})`;
    await preserveOpeningKnowledgeDefinitions(tx, f.scope, pdf.sourceId, 1);
    const [graph] = await tx`SELECT node_definitions FROM opening_course_knowledge WHERE course_id=${courseId}`;
    await tx`DELETE FROM opening_course_knowledge WHERE course_id=${courseId}`;
    await tx`DELETE FROM course_asset_memberships WHERE course_id=${courseId}`;
    await tx`DELETE FROM courses WHERE id=${courseId}`;
    return nodes.flatMap(({ id }, index) => graph?.node_definitions?.[id] ? [index + 1] : []);
  });
}

async function expectArchivedPdfPages(texts: string[], pages: number[], blockedPage: number, blockedImage = false) {
  const pdf = await seed(texts);
  if (blockedImage) {
    await f.sql`UPDATE opening_source_chunks SET text='',image_object_key='archive/image' WHERE id=${pdf.snapshot.chunks[blockedPage - 1]!.id}`;
  }
  await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
  const chunks = createOpeningSourceChunksRepository(f.sql);
  const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
  const publicChunks = pdf.snapshot.chunks.filter(chunk => pages.includes(chunk.page!));
  const blockedChunk = pdf.snapshot.chunks[blockedPage - 1]!;
  expect(await chunks.listChunks(f.scope, pdf.sourceId)).toEqual(publicChunks);
  expect(await chunks.listForSources(f.scope, [pdf.sourceId])).toEqual(publicChunks);
  expect(await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, [blockedPage, ...pages])).toEqual(publicChunks);
  await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: blockedPage }))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
  // The list and citation assertions cover every page. Sample the reader's first and last public pages.
  for (const page of new Set([pages[0], pages.at(-1)])) {
    if (page === undefined) continue;
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page }))
      .resolves.toMatchObject({ pages, text: texts[page - 1] });
  }
  expect(await backfilledPages(pdf)).toEqual(pages);
  expect((await pdf.repository.snapshot(f.scope, pdf.sourceId))?.chunks).toEqual(publicChunks);
  expect((await pdf.repository.search(f.scope, query)).map(({ chunk }) => chunk.page).sort((a, b) => a! - b!)).toEqual(pages);
  expect(await pdf.repository.search(f.scope, { ...query, chunkIds: [blockedChunk.id] })).toEqual([]);
  expect((await pdf.repository.authorizeChunks(f.scope, pdf.snapshot.chunks)).chunks).toEqual(publicChunks);
  expect(await pdf.repository.hasIndex(f.scope, { ...query, chunkIds: [blockedChunk.id] })).toBe(false);
  expect(await pdf.repository.hasIndex(f.scope, query)).toBe(pages.length > 0);
  return pdf;
}

describe("pgvector material repository", { timeout: 30_000 }, () => {
  it("stores a failed boundary on the conversion row and hides the archived continuation from direct reads", async () => {
    const pdf = await seed(["", "Public introduction.", "5 units.", "Answers to Review Questions\nx = 3."]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf',parse_state='running' WHERE id=${pdf.sourceId}`;
    const jobs = createOpeningJobRepository(f.sql);
    const job = await jobs.createOnce(f.scope, { kind: "parse", key: randomUUID(),
      payload: { sourceId: pdf.sourceId, sourceVersion: 1 }, privacyEpoch: await jobs.workspacePrivacyEpoch(f.scope.workspaceId) });
    const claimed = await jobs.claim(job.id);
    expect(claimed?.claimToken).toBeTruthy();
    const scope = openingJobScope(claimed!);
    const segments = createOpeningPdfSegmentsRepository(f.sql);
    const range = { sourceId: pdf.sourceId, sourceVersion: 1, parserProfile: "pdf-test-native", pageStart: 3, pageEnd: 3 };
    const failure = { state: "failed", errorCode: "conversion_failed" } as const;
    const boundary = { page: 3, text: "", imagePath: null, publicationSealUnknown: true };
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 1 })).resolves.toMatchObject({
      pages: [1, 2, 3], text: "",
    });
    await expect(segments.save(scope, range, failure, undefined, [{ ...boundary, page: 4 }]))
      .rejects.toThrow("invalid failed PDF segment publication markers");
    expect(await segments.read(scope, range)).toBeNull();
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 })).resolves.toMatchObject({ text: "5 units." });

    await segments.save(scope, range, failure, undefined, [boundary]);
    expect(await segments.read(scope, range)).toEqual(failure);
    expect(await f.sql`SELECT parser_profile,state FROM opening_pdf_parse_segments WHERE source_id=${pdf.sourceId}`).toEqual([
      { parser_profile: "pdf-test-native/publication-failure-pending-3", state: "failed" },
    ]);
    for (const state of ["running", "failed"]) {
      await f.sql`UPDATE opening_sources SET parse_state=${state},updated_at=now() WHERE id=${pdf.sourceId}`;
      expect(await readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 1 })).toMatchObject({
        pages: [1, 2], readablePages: 1, text: "",
      });
      expect(await readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).toMatchObject({ text: "Public introduction." });
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }

    const recovered = { page: 3, text: "Recovered third page", imagePath: null };
    const interrupted = { ...recovered, text: "Extraction cached before interruption" };
    await segments.save(scope, range, { state: "ready", pages: [interrupted] });
    expect(await segments.read(scope, range)).toEqual({ state: "ready", pages: [interrupted], requiresRevalidation: true });
    await segments.save(scope, range, { state: "ready", pages: [recovered] }, undefined, [], true);
    expect(await segments.read(scope, range)).toEqual({ state: "ready", pages: [recovered], requiresRevalidation: true });
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 })).rejects.toMatchObject({ code: "NOT_FOUND" });

    const chunks = createOpeningSourceChunksRepository(f.sql);
    await chunks.replacePdfChunks(scope, { sourceId: pdf.sourceId, sourceVersion: 1, preservePages: [1, 2],
      chunks: (async function* () {
        yield { page: 3, text: recovered.text, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null };
      })(),
      publicationSeals: [recovered],
    });
    expect(await f.sql`SELECT parser_profile,state FROM opening_pdf_parse_segments WHERE source_id=${pdf.sourceId}`).toEqual([
      { parser_profile: range.parserProfile, state: "ready" },
    ]);
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 })).resolves.toMatchObject({
      pages: [1, 2, 3], text: recovered.text,
    });
  });

  it("filters PDF answer labels and unsettled seals from all embedding entry points", async () => {
    const texts = ["Public notes.", "Answers to Review Questions\nx = 3.", "5 units."];
    const pdf = await seed(texts);
    const markdown = await seed(texts[1]!);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    await f.sql`UPDATE opening_sources SET mime='text/markdown' WHERE id=${markdown.sourceId}`;
    const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
    const [notes, answer, continuation] = pdf.snapshot.chunks;
    const repo = pdf.repository;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    const before = await repo.snapshot(f.scope, pdf.sourceId);
    expect(before?.chunks).toEqual([notes]);
    await expect(repo.assertCurrent(f.scope, pdf.snapshot)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await repo.hasIndex(f.scope, { ...query, chunkIds: [answer!.id] })).toBe(false);
    expect((await repo.search(f.scope, { ...query, sourceIds: [markdown.sourceId] })).map(row => row.chunk.text)).toEqual([texts[1]]);

    await f.sql`INSERT INTO opening_pdf_parse_segments(workspace_id,source_id,source_version,parser_profile,page_start,page_end,state,pages)
      VALUES(${f.scope.workspaceId},${pdf.sourceId},1,'pdf-publication-page-seal-v1',2,2,'ready',
        ${f.sql.json([{ page: 2, text: "", imagePath: null, publicationSealUnknown: true, publicationSealCommitted: false }])})`;
    // A later status write cannot settle an uncommitted withdrawal.
    await f.sql`UPDATE opening_sources SET updated_at=clock_timestamp() WHERE id=${pdf.sourceId}`;
    expect((await repo.snapshot(f.scope, pdf.sourceId))?.chunks).toEqual([notes]);
    expect((await repo.authorizeChunks(f.scope, pdf.snapshot.chunks)).chunks).toEqual([notes]);
    expect((await repo.search(f.scope, query)).map(row => row.chunk.id)).toEqual([notes!.id]);
    expect(await repo.hasIndex(f.scope, { ...query, chunkIds: [continuation!.id] })).toBe(false);
    expect(await chunks.listForSources(f.scope, [pdf.sourceId])).toEqual([notes]);
    expect((await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, undefined, { unpublishedPdfForRecovery: true })))
      .toEqual(pdf.snapshot.chunks);

    const recovered = "Chapter 2: Vectors";
    await chunks.replacePdfChunks(f.scope, { sourceId: pdf.sourceId, sourceVersion: 1, preservePages: [1],
      chunks: (async function* () {
        yield { page: 2, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null, text: recovered };
      })(),
      publicationSeals: [{ page: 2, text: "", imagePath: null, hadSealedContent: false, reopenedSection: true }],
    });
    expect((await repo.snapshot(f.scope, pdf.sourceId))?.chunks.map(chunk => chunk.text)).toEqual([notes!.text, recovered]);
    const [marker] = await f.sql`SELECT pages FROM opening_pdf_parse_segments
      WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1'`;
    expect(marker).toBeUndefined();
  });

  it("withdraws the same labelled PDF text across direct reads, retrieval, and embedding snapshots", async () => {
    const publicText = [
      "Answers to common questions are discussed in Chapter 2.",
      "Solutions to linear equations exist when the matrix is invertible.",
    ];
    const answers = [
      "Answers to Exercises 1–5", "Solutions to Problems 1-10", "Answers to Exercises #1—5",
      "Answers to Questions 1.1–1.8", "Solutions to Practice Problems 1 to 10",
      "Answers to Selected Exercises 1 through 10", "Answers\u00a0to\u202fReview\u3000Questions",
      "**Ans**wers to Review Questions", "__Solu__tions to Problems 1-10",
    ].map(heading => heading + "\n5 units.");
    const pdf = await seed([...publicText, ...answers]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    expect((await pdf.repository.snapshot(f.scope, pdf.sourceId))?.chunks.map(chunk => chunk.text)).toEqual(publicText);
    await expect(pdf.repository.assertCurrent(f.scope, pdf.snapshot)).rejects.toMatchObject({ code: "CONFLICT" });

    const chunks = createOpeningSourceChunksRepository(f.sql);
    for (const state of ["ready", "running", "failed"]) {
      await f.sql`UPDATE opening_sources SET parse_state=${state} WHERE id=${pdf.sourceId}`;
      expect((await chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.text)).toEqual(publicText);
      const content = await readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 1 });
      expect(content).toMatchObject({ pages: [1, 2], text: publicText[0] });
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 10 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
  });

  it.each([
    "Answers to exercises 1–5", "Solutions to problems 1–10", "Answers to selected review questions",
    "Key to the exercises", "Chapter 3: answers to exercises", "Selected answers", "Model answers",
    "Official solutions", "Answer key", "Solutions to problems (CoNt.)", "**Ans**wers to Review Questions",
    "Answers\u00a0to\u202fReview\u3000Questions", "复习题答案", "【课后习题答案】",
  ])("blocks archived continuations after %s until a public chapter", async heading => {
    const reopening = "Chapter 2: Geometry\nThis section introduces triangles.";
    const pdf = await seed([heading, "5 units.", reopening]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    const [answer, continuation, chapter] = pdf.snapshot.chunks;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
    expect(await chunks.listForSources(f.scope, [pdf.sourceId])).toEqual([chapter]);
    expect(await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, [2])).toEqual([]);
    expect(await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).toEqual([chapter]);
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 }))
      .resolves.toMatchObject({ pages: [3], text: reopening });
    expect(await backfilledPages(pdf)).toEqual([3]);
    expect((await pdf.repository.snapshot(f.scope, pdf.sourceId))?.chunks).toEqual([chapter]);
    expect((await pdf.repository.search(f.scope, query)).map(({ chunk }) => chunk.id)).toEqual([chapter!.id]);
    expect(await pdf.repository.search(f.scope, { ...query, chunkIds: [continuation!.id] })).toEqual([]);
    expect((await pdf.repository.authorizeChunks(f.scope, [answer!, continuation!])).chunks).toEqual([]);
    expect(await pdf.repository.hasIndex(f.scope, { ...query, chunkIds: [continuation!.id] })).toBe(false);
  });

  it("ignores inline labels as cross-page boundaries and requires a clean heading to reopen", async () => {
    const pdf = await seed([
      "Answers to exercises are omitted in this edition.", "Public notes.", "Solution 1: x = 3.",
      "Public continuation.", "Answer Key", "# Page 6 of 10", "# Cached transcription for page 7",
      "# Chapter 1 (continued)", "# Chapter 1 (page 9 of 10)", "5 units.",
      "# Geometry\nThe next topic is triangles.", "The chapter continues.",
    ]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    expect((await chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.page)).toEqual([1, 2, 4, 11, 12]);
    expect(await backfilledPages(pdf)).toEqual([1, 2, 4, 11, 12]);
  });

  it.each(["Solutions\nChapter 1 Exercises", "## Solutions (cont.):\n\n[原生提取]\nPage 304\nChapter 1",
    "Solutions\nSection 1.1 Sets", "Solutions:\n1. The first hidden answer.",
    "Solutions\n(1) The first hidden answer.", "Solutions\n(a) The first hidden answer.",
    "Solutions\n1) The first hidden answer.", "Solutions\n1.\nThe first hidden answer.", "Solutions\na. The first hidden answer."])(
    "withholds a textbook solutions appendix from every archived reader after %j",
    async heading => {
      const texts = ["## Solutions\nA homogeneous mixture.", "## Solutions\nProblems arise when dissolved ions precipitate.",
        heading + "\n3. A hidden derivation.",
        "Chapter 2 Exercises\n1. Another hidden derivation.", "Works Cited\nPublic references."];
      await expectArchivedPdfPages(texts, [1, 2, 5], 3);
    },
  );

  it("withholds period-delimited assessment answers and retains examples and lowercase prose", async () => {
    const labels = ["Solution.", "SOLUTION.", "Answer.", "ANSWER.", "Worked solution.", "Model answer."];
    const texts = [
      ...labels.map((label, index) => `Problem ${index + 1}. Find x.\n${label} The answer is private.`),
      "Theorem 2.1: Ax = b has a unique\nsolution. Moreover, x = A^{-1}b.",
      "Example 1: Factor x.\nSolution. The worked example is public.",
      "Solution. The example continues on the next physical page.",
      "Chapter 3: Fields",
    ];
    await expectArchivedPdfPages(texts, [7, 8, 9, 10], 1);
  });

  it.each([false, true].flatMap(blank => ["", "∎", "Q.E.D.", "\\Box", "证毕"].map(end => ({ blank, end }))))(
    "withholds nested assessment proofs from archive readers (paragraph breaks: $blank, terminator: $end)",
    async ({ blank, end }) => {
      const join = blank ? "\n\n" : "\n";
      const label = blank ? "Solution." : "Answer:";
      const next = end ? "Public prose after the proof." : "Problem 2. Find the roots.";
      await expectArchivedPdfPages([
        ["Problem 1. Prove the formula.", `${label} We use strong induction.`, "Proof. Base Cases: private."].join(join),
        ["Inductive Step: private computation.", "The equality follows."].join(join),
        ...(end ? [`The private conclusion. ${end}`] : []),
        next, "Theorem 2.1: The identity.\n\nProof. The public justification.",
        "Example 1: Factor x.\nSolution. The derivation.\n\nProof. The worked proof.",
        "Solution. Continuing the worked example on the next physical page.",
      ], end ? [4, 5, 6, 7] : [3, 4, 5, 6], 2);
    },
  );

  it.each(["Solution.", "Answer:", "Solution:", "【答案】"])(
    "withholds an archived proof starting on the same line as %s", async label => {
      await expectArchivedPdfPages([
        label + " Proof. Private derivation.",
        "A private intermediate step.\n\nThe equality now follows.",
        "The proof concludes. ∎",
        "Public prose after the proof.",
      ], [4], 2);
    },
  );

  it.each(["Solution. The answer is 3.", "Answer: Yes. □"])(
    "extends an archived answer ending in %j into an adjacent proof behind furniture", async answer => {
      await expectArchivedPdfPages([
        answer,
        "[原生提取]\n\n# Cached transcription for page 2\nChapter 1 | Page 2\nProof. Private continuation.",
        "Another private paragraph.\n\nThe proof concludes. ∎",
        "Public prose after the proof.",
      ], [4], 2);
    },
  );

  it("keeps archived prose public when a later proof does not open the next page", async () => {
    await expectArchivedPdfPages([
      "Problem 1. Find x.\nSolution. The answer is 3.",
      "[原生提取]\nChapter 1 | Page 2\nThis page explains an unrelated lemma.\nProof. Public proof.",
      "The public argument continues.",
    ], [2, 3], 1);
  });

  it.each(["Chapter 1 (continued)", "第 1 章（续）", "Chapter 1: Rings (cont’d)"])(
    "finds an adjacent archived proof below the running heading %j", async heading => {
      await expectArchivedPdfPages([
        "Answer: Yes.",
        heading + "\nProof. Private continuation.",
        "The conclusion is private. ∎",
        "The next argument is public.",
      ], [4], 2);
    },
  );

  it.each(["Answer:", "Solution:"])(
    "carries a standalone %s label on a numbered question into an adjacent archived proof",
    async label => {
      await expectArchivedPdfPages([
        `1. Decide whether every cyclic group is abelian.\n${label}\nYes.`,
        "Proof. Private continuation.",
        "The conclusion is private. ∎",
        "This separate paragraph is public.",
      ], [4], 2);
    },
  );

  it("carries a standalone 解答 label in a numbered exercise into an adjacent archived proof", async () => {
    await expectArchivedPdfPages([
      "Exercises\n1. Decide whether every cyclic group is abelian.\n解答：\nYes.",
      "Proof. Private continuation.",
      "The conclusion is private. ∎",
      "This separate paragraph is public.",
    ], [4], 2);
  });

  it("keeps numbered worked-example solutions public and withholds numbered exercise solutions", async () => {
    await expectArchivedPdfPages([
      "Example 1: Quadratic Equations\nSolution 1: Factor the polynomial.\nSolution 2: Complete the square.",
      "Solution 3: Use the quadratic formula.",
      "Exercises\n1. Find x.\nSolution 1: A private derivation.",
      "Proof. Private continuation. ∎",
      "## Solutions\nA homogeneous mixture.",
      "Solutions\nSolutes dissolve in solvents.",
    ], [1, 2, 5, 6], 3);
  });

  it.each(["Official Solution 1. Yes.", "Reference Solution 1:", "Model Solution: Yes.",
    "Selected Solutions.", "Correct Solution. Yes.", "Odd-Numbered Solutions 1:", "EVEN-NUMBERED SOLUTION: Yes."])(
    "withholds %s and its adjacent archived proof after a worked example", async label => {
      await expectArchivedPdfPages([
        "Example 1: Quadratic Equations\nSolution 1: Factor the polynomial.\n" + label,
        "Proof. Private continuation. ∎",
        "Public prose after the proof.",
      ], [3], 2);
    },
  );

  it.each(["Official Solutions", "Reference Solutions:", "Model Solutions"])(
    "withholds numbered pages after the archived %s section that follows a worked example", async label => {
      await expectArchivedPdfPages([
        "Example 1: Quadratic Equations\nSolution: Factor the polynomial.\n" + label + "\n1. x = 3.",
        "2. y = 4.",
        "Proof. Private continuation. ∎",
        "Chapter 2: Geometry",
      ], [4], 2);
    },
  );

  it("still withholds a numbered official solution with a chapter prefix", async () => {
    await expectArchivedPdfPages(["Chapter 1: Official Solution 1: Yes.", "Public prose."], [2], 1);
  });

  it.each(["Official Solution 1.", "Reference Solution:"])(
    "allows prose after an archived %s whose inline answer has ended", async label => {
      await expectArchivedPdfPages([
        "Example 1: Quadratic Equations\n" + label + "\nx = 3.", "Public prose after the answer.",
      ], [2], 1);
    },
  );

  it.each([
    ["[图片描述]", "\n"], ["[图片描述]", "："],
    ["【图表观察描述，非原文或解答】", "\n"], ["【识别不确定，不能据此判定正确】", "\n"],
  ])(
    "withholds an answer section introduced inside archived Vision block %s with separator %j", async (header, separator) => {
      await expectArchivedPdfPages([
        header + separator + "Answer Key\n1. x = 3.",
        "2. y = 4.",
        "Chapter 2: Geometry",
      ], [3], 2);
    },
  );

  it("keeps a proof sealed when the final transcription answer has no body", async () => {
    const pdf = await seed([
      "[原生提取]\nAnswer: No.\n[视觉转写与描述]\n[转写]\nAnswer: No.\n2. Find y.\nAnswer:\nChapter 2: Geometry\nSome public prose."
        + "\n[图片描述]\nProof. Private derivation begins.",
      "The private derivation continues.",
      "The private derivation ends. ∎",
      "Public prose after the proof.",
    ]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    const [answer] = await f.sql`
      ${publicPdfSealBoundaries(f.sql, f.scope.workspaceId, { sourceIds: [pdf.sourceId], sourceVersion: 1 })}
      SELECT last_answer_body, transcription_reopens_answer FROM pdf_archive_inline_starts WHERE position=last_transcription_answer`;
    expect(answer).toEqual({ last_answer_body: "", transcription_reopens_answer: false });
    const chunks = createOpeningSourceChunksRepository(f.sql);
    expect((await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).map(({ page }) => page)).toEqual([4]);
  });

  it.each([
    "[原生提取]\nAnswer: x =\n\nAn ordinary observation.\n[图片描述]\nProof. An independent derivation.",
    "[原生提取]\nAnswer:\n\n[图片描述]\nProof. An independent derivation.",
    "[原生提取]\nAnswer:\n\n[视觉转写与描述]\n[图片描述]\nProof. An independent derivation.",
  ])(
    "does not start an archived auxiliary proof from %j",
    async pageOne => {
      const pdf = await seed([
        pageOne,
        "Public prose after the answer.",
      ]);
      await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
      const [proof] = await f.sql`
        ${publicPdfSealBoundaries(f.sql, f.scope.workspaceId, { sourceIds: [pdf.sourceId], sourceVersion: 1 })}
        SELECT native_answer_boundary, follows_completed_answer, upgrades_inline
        FROM pdf_archive_inline_groups WHERE first_auxiliary_proof`;
      expect(proof).toEqual({ native_answer_boundary: false, follows_completed_answer: false, upgrades_inline: false });
      const chunks = createOpeningSourceChunksRepository(f.sql);
      expect((await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, [2])).map(({ page }) => page)).toEqual([2]);
    },
  );

  it.each([
    "Proof. Starts.\nQ.E.D.",
    "**Proof. Done. ∎**",
    "Proof. Starts.\n**Q.E.D.**",
    "Proof. Starts.\n## Q.E.D. ###",
    "Proof. Starts.\n__Q.E.D.__",
    "*Proof. Done. ∎*",
    "_Proof. Done. ∎_",
    "Proof. Starts.\n*Q.E.D.*",
    "Proof. Starts.\n_Q.E.D._",
    "Proof. Done. *∎*",
    "Proof. Done. *Q.E.D.*",
    "Proof. Done. _Q.E.D._",
    "*Proof. Since 2 * 3 = 6, done. ∎*",
    "*Proof. Since 2 * 3 = 6. Q.E.D.*",
    "_Proof. Since a_1 + a_2 = 3. Q.E.D._",
  ])(
    "publishes the next archived page after the Markdown proof %j",
    async proof => {
      await expectArchivedPdfPages(["Answer: No.\n" + proof, "Public prose after the proof."], [2], 1);
    },
  );

  it("withholds multi-page italic proofs with interior * or _ and rejects unmatched proof terminators in Archive SQL", async () => {
    for (const heading of ["*Proof. Since 2 * 3 = 6, continue.*", "_Proof. Since a_1 + a_2 = 3, continue._"]) {
      await expectArchivedPdfPages([
        "Answer: No.",
        heading,
        "Still private continuation.",
        "The proof finishes. ∎",
        "Public prose.",
      ], [5], 3);
    }
    for (const unmatched of [
      "*Q.E.D.", "Q.E.D.*", "_Q.E.D.", "Q.E.D._", "*∎", "∎*",
      "Proof. Done. *Q.E.D.", "Proof. Done. Q.E.D.*", "**Q.E.D.*", "*Q.E.D.**",
    ]) {
      await expectArchivedPdfPages([
        "Answer: No.\nProof. Starts.\n" + unmatched,
        "Still private continuation.",
        "Chapter 2: Geometry\nPublic prose.",
      ], [3], 2);
    }
  });

  it.each([
    "*End of Answers.*",
    "_End of Solutions._",
    "Calculation complete. End of Answers.",
    "Calculation complete. *End of Answers.*",
    "Calculation complete. _End of Answers._",
    "Calculation complete. **End of Answers.**",
  ])(
    "closes an archived answer section at terminator %j while rejecting unmatched wrappers and arithmetic *",
    async terminator => {
      await expectArchivedPdfPages(["Answer Key\nPrivate calculation\n" + terminator, "Public prose."], [2], 1);
    },
  );

  it("keeps archived sections and inline answers sealed on unmatched section terminators and arithmetic *", async () => {
    await expectArchivedPdfPages(["Answer: 2 * 3 * 4", "Still sealed calculation.", "Public prose."], [3], 2);
    for (const unmatched of ["Calculation complete. *End of Answers.", "Calculation complete. End of Answers.*"]) {
      await expectArchivedPdfPages([
        "Answer Key\n" + unmatched,
        "Still private calculation.",
        "Chapter 2: Geometry\nPublic prose.",
      ], [3], 2);
    }
  });

  it("withholds a continuing inline answer introduced inside archived auxiliary Vision", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nSolution: x =",
      "3 units.",
      "Public prose after the answer.",
    ], [3], 2);
  });

  it("allows later prose after an inline answer completes inside the same archived Vision block", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nSolution:\nYes.",
      "Public prose after the answer.",
    ], [2], 1);
  });

  it("seals a proof immediately after a complete auxiliary Vision answer", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nSolution:\nYes.",
      "[不确定处]\nAuxiliary note.\n[转写]\nProof. Private continuation. ∎",
      "Public prose after the proof.",
    ], [3], 2);
  });

  it.each(["Answer: Yes.", "[图片描述]\nSolution:\nYes.", "Answer: x ="])(
    "seals an auxiliary Vision proof after %j through its terminator", async answer => {
      await expectArchivedPdfPages([
        answer,
        "[图片描述]\nProof.\nThe private proof begins.",
        "The private derivation continues.",
        "The private proof ends. ∎",
        "Public prose after the proof.",
      ], [5], 3);
    },
  );

  it("seals an auxiliary Vision proof after a cross-page inline answer", async () => {
    await expectArchivedPdfPages([
      "Answer: x =",
      "3 units.",
      "[图片描述]\nProof.\nThe private derivation follows.",
      "The private derivation continues.",
      "The private proof ends. Q.E.D.",
      "Public prose after the proof.",
    ], [6], 4);
  });

  it("closes an auxiliary Vision proof at a terminator in its opening block", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nSolution:\nYes.",
      "[图片描述]\nProof.\nThe private derivation concludes. Q.E.D.",
      "Public prose after the proof.",
    ], [3], 2);
  });

  it("keeps a same-chunk auxiliary note from closing a primary inline answer", async () => {
    await expectArchivedPdfPages([
      "Answer: x =\n[图片描述]\nAuxiliary observation.",
      "3 units.",
      "Public prose after the answer.",
    ], [3], 2);
  });

  it.each(["Answer: Yes.", "[图片描述]\nAnswer: Yes."])(
    "archives a mixed native and auxiliary proof after %j through its terminator", async (answer) => {
      await expectArchivedPdfPages([
        answer,
        "[原生提取]\nThe private derivation begins.\n[视觉转写与描述]\n[图片描述]\nProof.",
        "The private derivation continues.",
        "The private proof ends. ∎",
        "Chapter 2: Geometry",
      ], [5], 3);
    },
  );

  it("keeps a mixed page public when a chapter heading precedes an auxiliary proof", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nAnswer: Yes.",
      "[原生提取]\nChapter 2: Geometry\n[视觉转写与描述]\n[图片描述]\nProof. The public derivation begins.",
      "The public derivation continues.",
    ], [2, 3], 1);
  });

  it("archives a proof below the first auxiliary line of an active inline answer", async () => {
    await expectArchivedPdfPages([
      "Answer: x =",
      "[图片描述]\nAn ordinary observation.\nProof. The private derivation begins.",
      "The equality follows.",
      "The private proof ends. ∎",
      "Public prose after the proof.",
    ], [5], 4);
  });

  it.each([
    "1. Find x.\n[图片描述]\nAnswer: Yes.",
    "[图片描述]\nAnswer: Yes.\n[不确定处]\nProof. The first derivation ends. ∎\n[图片描述]\nAnswer: No.",
  ])("archives an open proof following a completed answer in an earlier block on the same page (%j)", async prefix => {
    await expectArchivedPdfPages([
      prefix + "\n[不确定处]\nProof. The private derivation begins.",
      "The private derivation continues.",
      "The private derivation ends. ∎",
      "Public prose after the proof.",
    ], [4], 3);
  });

  it.each([
    "[不确定处]\nFigure 1.",
    "[不确定处]\nFigure 1.\n[图片描述]\nProof. An independent public derivation.",
    " ∎\nAn ordinary observation after the answer.",
  ])("consumes a completed auxiliary answer boundary before any later block or page (%j)", async intervening => {
    await expectArchivedPdfPages([
      "[图片描述]\nAnswer: Yes." + (intervening.startsWith("[") ? "\n" : "") + intervening,
      "Proof. An independent public derivation.",
      "The public derivation continues.",
    ], [2, 3], 1);
  });

  it("keeps a nested auxiliary proof sealed across pages after its sibling closes in the same block", async () => {
    const auxiliary = "[图片描述]\nProof. First calculation ends. ∎\nProof. Second calculation begins.";
    const texts = ["Answer: x =", auxiliary, "3 units.", "The private derivation continues.",
      "The private derivation ends. ∎", "The next topic is public."];
    const pdf = await expectArchivedPdfPages(texts, [6], 4);
    const retry = await startPdfRetry(pdf.sourceId, texts.map((text, index) => ({
      page: index + 1, text: index === 1 ? "" : text, imagePath: null, visualKinds: index === 1 ? ["scan"] : [],
    })), { recognizePage: async () => ({ text: auxiliary, imageObjectKey: "vision/two-proofs" }) });
    const result = await retry.run();
    await retry.finish(result.pages);
    expect((await retry.chunks.listChunks(f.scope, pdf.sourceId)).map(chunk => chunk.page)).toEqual([6]);
  });

  it("keeps the auxiliary answer's open proof sealed after an earlier proof terminator in its own block", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nAnswer: x =\nProof. First calculation ends. ∎\nProof. Second calculation begins.",
      "The private derivation continues.",
      "The private derivation ends. ∎",
      "Public prose after the proof.",
    ], [4], 2);
  });

  it.each([
    { answer: "Answer: x =\nProof. First. ∎", pages: [2, 3, 4] },
    { answer: "Answer: x =\nProof. First. ∎\nTherefore x = 2.", pages: [2, 3, 4] },
    { answer: "Answer: x =\nProof. First. ∎\nStill computing y =", pages: [4] },
    { answer: "Answer: Proof. Unclosed", pages: [4] },
  ])("archives the auxiliary answer $answer according to its final line", async ({ answer, pages }) => {
    await expectArchivedPdfPages([
      "[图片描述]\n" + answer,
      "The derivation continues",
      "The derivation ends. ∎",
      "Public prose after the derivation.",
    ], pages, pages.includes(2) ? 1 : 2);
  });

  it.each([
    { native: "1. Find x.\nAnswer: No.", primary: "1. Find x.", sealed: true },
    { native: "", primary: "1. Find x.", sealed: false },
    { native: "7", primary: "1. Find x.", sealed: false },
    { native: "1. Find x.\nAnswer: No.", primary: "1. Find x.\nAnswer: No.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: No.", primary: "1. Find x.\nAnswer: No.\n2. Find y.", sealed: false },
    { native: "1. Find x.\nAnswer: No.", primary: "1. Find x.\nAnswer: No.\n2. Find y.\nAnswer: Yes.", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: Yes.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: Yes.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\nProof. A different derivation. ∎\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: x =\n\nAn ordinary observation.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n\nAn ordinary observation.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n\nPage 12\n2. Find y.", sealed: false },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n\nAn ordinary observation.\n2. Find y.", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n\nProof. A different derivation. ∎\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: No. ∎", primary: "Answer: No. ∎\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: No. ∎", primary: "Answer: No. ∎\nAn ordinary observation.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer:\nNo.", primary: "Answer:\nYes.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer:\nx = 1\nDone.", primary: "Answer:\ny = 2\nDone.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer:\nx = 1\nDone.", primary: "Answer:\nx =  1\nDone.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer:\n1\nDone.", primary: "Answer:\n2\nDone.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer:\n1\nDone.", primary: "Answer:\n1\nDone.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer:\n(1)\nDone.", primary: "Answer:\n(2)\nDone.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer:\n1/2\nDone.", primary: "Answer:\n3/4\nDone.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer:\nDone.\n- 3 -", primary: "Answer:\nDone.\n- 4 -\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: x =\n3. Find z.", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: Yes.\n3. Find z.", sealed: false },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: Proof. Unclosed.\n3. Find z.", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: Proof. Closed. ∎\n3. Find z.", sealed: false },
    { native: "1. Find x.\nAnswer:\n1\nPage 12\nDone.", primary: "Answer:\n1\nDone.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer:\nNo.", primary: "Answer:\n[unreadable]\nNo.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer:\nVIII\nDone.", primary: "Answer:\nVII\nDone.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: x =\n3. Find z.", primary: "Answer: x =\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\n## Answer:  No. ###", primary: "Answer: No.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer:\n#1\nDone.", primary: "Answer:\n1\nDone.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: x =\n1.\n3. Find z.", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: x =\n\n3. Find z.", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: x =\n[unreadable]\n3. Find z.", sealed: true },
    { native: "1. Find x.\nAnswer: No.", primary: "Answer: No.\n2. Find y.\nAnswer: x =\nChapter 2: Geometry", sealed: true },
    { native: "Answer:\nMMMDCCCLXXXVIII\nDone.", primary: "Answer:\nMMMDCCCLXXXVII\nDone.\nChapter 2: Geometry", sealed: true },
    { native: "Answer:\nMMMDCCCLXXXVIII\nDone.", primary: "Answer:\nMMMDCCCLXXXVIII\nDone.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: 2**3.", primary: "Answer: 23.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: 2**3.", primary: "**Answer:** 2**3.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: 2**3.", primary: "**Answer**: 2**3.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: 2**3.", primary: "**Answer: 2**3.**\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: 2**3 + 4**5.", primary: "Answer: 23 + 45.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: (x)**(y) + (z)**(w).", primary: "Answer: (x)(y) + (z)(w).\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: 2 ** 3 + 4 ** 5.", primary: "Answer: 2 3 + 4 5.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: 2 ** 3 + 4 ** 5.", primary: "Answer: 2 ** 3 + 4 ** 5.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\nAnswer: x__1 + y__2.", primary: "Answer: x1 + y2.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\nAnswer: x__1 + y__2.", primary: "__Answer:__ x__1 + y__2.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\n## **Answer:** No. ##", primary: "Answer: **No.**\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\n__Answer:__ No.", primary: "Answer: No.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\n**Model** **Answer**: No.", primary: "Model Answer: Yes.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\n**Model** **Answer**: No.", primary: "Model Answer: No.\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\n**Answer:** **No.**", primary: "__Answer:__ __No.__\nChapter 2: Geometry", sealed: false },
    { native: "1. Find x.\n**Answer:** **2**3.**", primary: "Answer: 23.\nChapter 2: Geometry", sealed: true },
    { native: "1. Find x.\n**Answer:** **2**3.**", primary: "Answer: 2**3.\nChapter 2: Geometry", sealed: false },
  ])("archives a mixed proof after native $native and transcription $primary", async ({ native, primary, sealed }) => {
    const pdf = await seed([
      "Answer: Yes.",
      (native ? "[原生提取]\n" + native + "\n\n" : "") + "[视觉转写与描述]\n[转写]\n" + primary
        + "\n[图片描述]\nProof. The derivation begins.",
      "The derivation continues",
      "The derivation ends. ∎",
      "Public prose after the derivation.",
    ]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    await f.sql`UPDATE opening_source_chunks SET image_object_key='vision/proof' WHERE id=${pdf.snapshot.chunks[1]!.id}`;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    const tail = sealed ? [5] : [3, 4, 5];
    const proofContinuationPages = [3, 4, 5];
    const verifyArchive = async (snapshot: typeof pdf.snapshot) => {
      const continuation = snapshot.chunks.filter(chunk => proofContinuationPages.includes(chunk.page!));
      const chunkIds = continuation.map(chunk => chunk.id);
      expect((await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, proofContinuationPages))
        .map(chunk => chunk.page)).toEqual(tail);
      expect((await pdf.repository.search(f.scope, { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0], chunkIds }))
        .map(({ chunk }) => chunk.page).sort((a, b) => a! - b!)).toEqual(tail);
      expect((await pdf.repository.authorizeChunks(f.scope, continuation)).chunks.map(chunk => chunk.page)).toEqual(tail);
      for (const page of proofContinuationPages) {
        const content = readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page });
        if (tail.includes(page)) {
          await expect(content).resolves.toMatchObject({ pages: expect.arrayContaining(tail) });
        } else {
          await expect(content).rejects.toMatchObject({ code: "NOT_FOUND" });
        }
      }
    };
    await verifyArchive(pdf.snapshot);

    const retry = await startPdfRetry(pdf.sourceId, [
      "Answer: Yes.", native, "The derivation continues", "The derivation ends. ∎", "Public prose after the derivation.",
    ].map((text, index) => ({ page: index + 1, text, imagePath: null, visualKinds: index === 1 ? ["picture"] : [] })));
    const result = await retry.run();
    await retry.finish(result.pages);
    const snapshot = (await pdf.repository.snapshot(f.scope, pdf.sourceId))!;
    await pdf.repository.store(f.scope, snapshot, model,
      segmentMaterialChunks(snapshot.chunks).map(segment => ({ ...segment, vector: [1, 0, 0] })));
    await verifyArchive(snapshot);
  });

  it.each([
    ["Answer Key", "Public prose after the key.", "Chapter 2: Geometry"],
    ["Answer Key", "The answer key continues.", "More of the answer key."],
    ["Answer: x =", "The answer ends. ∎", "Public prose after the answer."],
    ["Answer: Proof. Unclosed", "The proof ends. ∎", "Public prose after the proof."],
  ])("blocks a pure image inside the archive range from %j", async (opener, third, fourth) => {
    const pdf = await seed([opener, "Text previously indexed for the image.", third, fourth]);
    const image = pdf.snapshot.chunks[1]!;
    await f.sql`UPDATE opening_source_chunks SET text='',image_object_key='archive/image' WHERE id=${image.id}`;
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
    expect(await backfilledPages(pdf)).not.toContain(2);
    expect(await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, [2])).toEqual([]);
    expect(await pdf.repository.search(f.scope, { ...query, chunkIds: [image.id] })).toEqual([]);
  });

  it.each(["1.", "- 3 -"])("keeps an archived unfinished answer open past a non-exercise counter (%s)", async counter => {
    await expectArchivedPdfPages([
      "Answer: x =\n" + counter,
      "The private calculation continues.",
      "Public prose after the answer.",
    ], [3], 2);
  });

  it.each(["1.", "## 1.", "- 3 -"])("keeps an archived auxiliary answer open past a non-exercise counter (%s)", async counter => {
    await expectArchivedPdfPages([
      "[图片描述]\nAnswer: x =\n" + counter,
      "The private calculation continues.",
      "Public prose after the answer.",
    ], [3], 2);
  });

  it("allows an unmarked decimal number to close an auxiliary answer in an exercise", async () => {
    await expectArchivedPdfPages([
      "Exercise 1: Find x.\n[图片描述]\nAnswer: x =\n1.",
      "Public prose after the answer.",
    ], [2], 1);
  });

  it("completes an archived inline answer at a standalone decimal number in an exercise", async () => {
    await expectArchivedPdfPages([
      "Exercise 1: Find x.\nAnswer: x =\n1.",
      "Public prose after the answer.",
    ], [2], 1);
  });

  it.each(["Answer: x =", "Answer: Proof. Unclosed"])("blocks a final image-only page after %j", async opener => {
    await expectArchivedPdfPages([opener, "Previously indexed image text."], [], 2, true);
  });

  it.each(["Answer: x =", "Answer: Proof. Unclosed"])("bounds %j before the next public group and its final image", async opener => {
    const pdf = await expectArchivedPdfPages([
      opener, "Previously indexed private image.", "Chapter 2: Geometry", "Previously indexed public image.",
    ], [3, 4], 2, true);
    await f.sql`UPDATE opening_source_chunks SET text='',image_object_key='archive/public' WHERE id=${pdf.snapshot.chunks[3]!.id}`;
    expect(await createOpeningSourceChunksRepository(f.sql).listChunksAtVersion(f.scope, pdf.sourceId, 1, [2, 4]))
      .toMatchObject([{ page: 4, text: "", imageObjectKey: "archive/public" }]);
  });

  it.each(["∎", "Q.E.D."])("keeps the outer answer sealed after an auxiliary proof closes with %s", async (end) => {
    await expectArchivedPdfPages([
      "Answer: x =",
      "[图片描述]\nProof. The private derivation ends. " + end,
      "3 units.",
      "Public prose after the answer.",
    ], [4], 3);
  });

  it.each(["", "[图片描述]\n"])("seals 解答 after a completed primary or auxiliary answer on the numbered page (%j)", async (header) => {
    await expectArchivedPdfPages([
      "1. Find x.\n" + header + "Answer: Yes.",
      "解答：\nYes.",
      "The private answer section continues.",
      "Chapter 2: Geometry",
    ], [4], 3);
  });

  it("seals 解答 after a numbered line inside the preceding auxiliary proof", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nAnswer: Yes.",
      "[图片描述]\nProof. The private derivation begins.",
      "1. First result.",
      "解答：\nYes.",
      "The private proof ends. ∎",
      "The private answer section continues.",
      "Chapter 2: Geometry",
    ], [7], 6);
  });

  it("closes subsequent auxiliary proofs independently after an earlier public proof", async () => {
    await expectArchivedPdfPages([
      "Theorem 2.1: The public identity.\nProof. A public justification.",
      "[图片描述]\nAnswer: Yes.",
      "[图片描述]\nProof. The first private proof ends. Q.E.D.",
      "Public prose after the first proof.",
      "[图片描述]\nAnswer: Yes.",
      "[图片描述]\nProof. The second private proof ends. ∎",
      "Public prose after the second proof.",
    ], [1, 4, 7], 6);
  });

  it("keeps numbered answer and proof boundaries across a 128-page archive", async () => {
    const leading = Array.from({ length: 120 }, () => "Public practice prose about rings and fields.");
    const pdf = await seed([
      ...leading,
      "[图片描述]\nAnswer: Yes.",
      "[图片描述]\nProof. The private derivation begins.",
      "1. First result.",
      "解答：\nYes.",
      "The private proof ends. ∎",
      "The private answer section continues.",
      "Chapter 2: Geometry",
      "Public chapter prose.",
    ]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    const pages = [...leading.map((_, index) => index + 1), 127, 128];
    expect((await chunks.listChunks(f.scope, pdf.sourceId)).map(chunk => chunk.page)).toEqual(pages);
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 128 })).resolves.toMatchObject({ pages });
  });

  it.each([false, true])("carries a public numbered question after a proof terminator (cross-page: %s)", async crossPage => {
    await expectArchivedPdfPages([
      "Answer: x =",
      ...(crossPage ? ["Proof. The private proof begins.", "The private proof ends. ∎\n1. Find y."]
        : ["Proof. The private proof ends. ∎\n1. Find y."]),
      "解答：\nYes.",
      "Public prose after the answer.",
    ], [crossPage ? 5 : 4], crossPage ? 3 : 2);
  });

  it.each([128, 256, 512])("materializes the sealed pages and chunks of a %i-page archive once", async pageCount => {
    const pattern = ["[图片描述]\nAnswer: Yes.", "[不确定处]\nProof. Private derivation ends. ∎",
      "Public discussion of rings.", "Public discussion of fields.", "[图片描述]\nAnswer: No.",
      "Public examples of groups.", "Public examples of rings.", "Public examples of fields."];
    const pdf = await seed(Array.from({ length: pageCount }, (_, index) => pattern[index % pattern.length]!));
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    const expected = Array.from({ length: pageCount }, (_, index) => index + 1)
      .filter(page => ![1, 2, 5].includes((page - 1) % pattern.length + 1));
    let statement: { query: string; parameters: postgres.ParameterOrJSON<never>[] } | undefined;
    const sql = postgres(process.env.OPENING_TEST_DATABASE_URL!, {
      max: 1,
      debug: (_, query, parameters) => {
        if (query.trimStart().startsWith("WITH pdf_read_sources")) statement = { query, parameters: [...parameters] };
      },
    });
    try {
      const chunks = createOpeningSourceChunksRepository(sql);
      expect((await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).map(chunk => chunk.page)).toEqual(expected);
      if (!statement) throw new Error("Missing archive read statement");
      const { query, parameters } = statement;
      expect(query.match(/\bJOIN\b/giu)).toHaveLength(2);

      type Plan = { "Subplan Name"?: string; "Actual Loops": number; "Actual Rows": number; Plans?: Plan[] };
      const [row] = await sql.unsafe<{ "QUERY PLAN": { Plan: Plan }[] }[]>(
        `EXPLAIN (ANALYZE, FORMAT JSON) ${query}`, parameters,
      );
      const producers = new Map<string, Plan>();
      const visit = (plan: Plan) => {
        const name = plan["Subplan Name"];
        if (name?.startsWith("CTE pdf_archive_sealed_")) producers.set(name, plan);
        plan.Plans?.forEach(visit);
      };
      visit(row!["QUERY PLAN"][0]!.Plan);
      // A nested-loop consumer can scan the same materialized rows more than once.
      for (const suffix of ["spans", "pages", "chunks"]) {
        expect(producers.get("CTE pdf_archive_sealed_" + suffix)?.["Actual Loops"]).toBe(1);
      }
      expect(producers.get("CTE pdf_archive_sealed_pages")?.["Actual Rows"]).toBe(pageCount / pattern.length);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it("tracks completion per auxiliary answer opener", async () => {
    await expectArchivedPdfPages([
      "[图片描述]\nOfficial Solution 1: Yes.\nOfficial Solution 2:",
      "Another private answer.",
      "Public prose after the answer.",
    ], [3], 2);
  });

  it("keeps an archived proof sealed through a weaker auxiliary answer opener", async () => {
    await expectArchivedPdfPages([
      "Answer: Yes.\nProof. Begin the private derivation.",
      "[图片描述]\nSolution: y =",
      "The private proof continues.",
      "The private proof ends. ∎",
      "Public prose after the proof.",
    ], [5], 4);
  });

  it("keeps an incoming inline seal when a different answer completes inside archived Vision", async () => {
    await expectArchivedPdfPages([
      "Answer: x =",
      "[图片描述]\nSolution:\nYes.",
      "3 units.",
      "Public prose after the answer.",
    ], [4], 3);
  });

  it.each(["【图表观察描述，非原文或解答】", "【识别不确定，不能据此判定正确】",
    "[图片描述]", "[图像描述]", "[图示与版面描述]", "[不确定处]"])(
    "keeps an archived example heading inside %s from making a numbered answer public", async header => {
      await expectArchivedPdfPages([
        header + "\nExample 1: Quadratic Equations",
        "1. Decide whether every cyclic group is abelian.\nSolution:\nYes.",
        "Proof. Private continuation. ∎",
        "Public prose after the proof.",
      ], [1, 4], 3);
    },
  );

  it("ignores archived auxiliary chapter headings and terminators until primary transcription resumes", async () => {
    await expectArchivedPdfPages([
      "Answer Key",
      "【图表观察描述，非原文或解答】\nChapter 2: Geometry\nEnd of Answers.",
      "More private text.",
      "【识别不确定，不能据此判定正确】\nUncertain description.\n[转写]\nChapter 2: Geometry",
      "Public prose after the chapter begins.",
    ], [4, 5], 2);
  });

  it("ignores archived auxiliary body lines and blank lines at an inline proof boundary", async () => {
    await expectArchivedPdfPages([
      "Answer: Yes.\n【图表观察描述，非原文或解答】\nAuxiliary note.\n\nAnother auxiliary note.",
      "[图像描述]\nAn auxiliary note.\n【原图忠实转写，尚需核对】\nProof. Private continuation. ∎",
      "Public prose after the proof.",
    ], [3], 2);
  });

  it.each(["解答：", "Solution:"])(
    "withholds %s and proof after a numbered question even with a preceding archived worked example", async label => {
      await expectArchivedPdfPages([
        "Example 1: Cyclic groups\nSolution: This group is abelian.",
        "1. Decide whether every cyclic group is abelian.\n" + label + "\nYes.",
        "Proof. Private continuation. ∎",
        "Public prose after the proof.",
      ], [1, 4], 2);
    },
  );

  it.each(["解答：", "Solution:", "sOlUtIoN:"])(
    "withholds %s on the page after a numbered question and the immediately following proof", async label => {
      const example = "Example 1: Cyclic groups\nSolution: This group is abelian.";
      await expectArchivedPdfPages([
        example + "\n1. Decide whether every cyclic group is abelian.",
        "Page 2 of 4\n" + label + "\nYes.",
        "Proof. Private continuation. ∎",
        "Public prose after the proof.",
      ], [1, 4], 2);
    },
  );

  it("withholds the answer and proof of a heading-free numbered question with standalone 解答：", async () => {
    await expectArchivedPdfPages([
      "Introduction to cyclic groups.",
      "1. Decide whether every cyclic group is abelian.\n解答：\nYes.",
      "证明。\nThe proof concludes. ∎",
      "Public prose after the proof.",
      "## Solutions\nA homogeneous mixture.",
      "Solutions\nSolutes dissolve in solvents.",
    ], [1, 4, 5, 6], 3);
  });

  it.each(["Answer: x =", "Answer Key"])("keeps a standalone 解答： sealed after a numbered line under %s", async opener => {
    await expectArchivedPdfPages([
      opener + "\n1. First result.",
      "解答：\nYes.",
      "The private answer section continues.",
      "Chapter 2: Geometry",
    ], [4], 3);
  });

  it("allows a numbered question after an inline seal ends on the same page", async () => {
    await expectArchivedPdfPages([
      "Answer: x =\n3. ∎\n1. Decide whether every group is cyclic.",
      "解答：\nYes.",
      "Public prose after the inline solution.",
    ], [3], 2);
  });

  it.each(["End of Answers.", "End of Solutions.", "答案完", "解答完"])(
    "reopens archived prose on the page after %s", async terminator => {
      await expectArchivedPdfPages([
        "Answer Key", terminator, "Public prose after the answers.", "Chapter 2: Geometry",
      ], [3, 4], 2);
    },
  );

  it("honors the order of answer-section reopeners and terminators on an archived page", async () => {
    await expectArchivedPdfPages([
      "Answer Key\nEnd of Answers.",
      "First public passage.",
      "Answer Key\nEnd of Answers.\nAnswer Key",
      "Private text under the reopened key.",
      "End of Solutions.",
      "Second public passage.",
    ], [2, 6], 4);
  });

  it("keeps a proof public across a missing archived page", async () => {
    const publicText = "This separate paragraph is public.";
    const publicProof = "Proof. A separate public proof.";
    const pdf = await seed(["Solution. The answer is 3.", "Omitted page.", publicProof, publicText]);
    await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
    await f.sql`DELETE FROM opening_source_chunks WHERE source_id=${pdf.sourceId} AND page=2`;
    const chunks = createOpeningSourceChunksRepository(f.sql);
    expect(await chunks.listForSources(f.scope, [pdf.sourceId])).toMatchObject([{ page: 3, text: publicProof }, { page: 4, text: publicText }]);
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 })).resolves.toMatchObject({ pages: [3, 4], text: publicProof });
  });

  it("keeps proof headings inside an archived answer section until a public theorem", async () => {
    await expectArchivedPdfPages(["Answer Key", "## Proof. Base Cases: private.",
      "Proof (by induction). Private.", "Proof of Lemma 1.1. Private.", "证明：私有推导。",
      "Theorem 2.1: Public theorem.\n\nProof. Public proof."], [6], 2);
  });

  it("keeps an archived answer section sealed through exercise subheadings", async () => {
    const subheadings = [
      "# Drills", "# Self-Check", "# Self Check", "# Problem Set 1", "# Recitation", "# 思考题",
      "# 作业", "# 课后题", "# 单元测试", "# 第十二小题", "# A. Algebra", "# 2. Algebra", "# (a)", "# b", "# （三）",
    ];
    const texts = ["Answer Key", ...subheadings.flatMap(heading => [heading, "5 units."]),
      "Chapter 2: Geometry", "Public continuation."];
    await expectArchivedPdfPages(texts, [texts.length - 1, texts.length], 3);
  });

  it.each([
    "[原生提取]\nChapter 2: Geometry\n\n[视觉转写与描述]\n【原图忠实转写，尚需核对】\nThis section introduces triangles.",
    "[本地提取（可能含OCR）]\nChapter 2: Geometry",
    "\n[视觉转写与描述]\n \n【原图忠实转写，尚需核对】\nChapter 2: Geometry",
  ])("reopens an archived answer section at a wrapped public chapter (%j)", async chapter => {
    await expectArchivedPdfPages(["Answer Key", "5 units.", chapter, "Public continuation."], [3, 4], 2);
  });

  it.each([
    "[原生提取]\nChapter 2: Geometry\nAnswer Key",
    "[原生提取]\nChapter 2: Geometry\n\n[视觉转写与描述]\n【原图忠实转写，尚需核对】\nAnswer 1: x = 3.",
    "[视觉转写与描述]\n【图表观察描述，非原文或解答】\nChapter 2: Geometry",
    "[视觉转写与描述]\n【识别不确定，不能据此判定正确】\nChapter 2: Geometry",
    "[视觉转写与描述]\n# Cached transcription for page 3\n# 图表观察描述\nChapter 2: Geometry",
    "[原生提取]\n5 units.\nChapter 2: Geometry",
  ])("keeps a wrapped page sealed when it lacks a clean first heading (%j)", async page => {
    await expectArchivedPdfPages(["Answer Key", "5 units.", page, "5 more units."], [], 4);
  });

  it.each([
    "Works Cited", "Subject Index", "Author Index: Mathematicians", "Acknowledgements",
    "About the Authors", "Notation Index", "符号表", "致谢", "名词索引", "主题索引", "词汇表", "后记",
    "Acknowledgments", "# Acknowledgments", "Afterword", "# Afterword", "Colophon", "# Colophon",
    "Appendix: Proofs", "Appendix", "Appendix B Geometry", "附录：符号表", "附录符号表",
  ])("reopens archived back matter at %s", async heading => {
    await expectArchivedPdfPages(["Answer Key", "5 units.", heading, "Public continuation."], [3, 4], 2);
  });

  it.each(["# 1.2 Algebra", "# 1.2 True Values in Logic"])(
    "keeps numbered answer headings sealed until %s", async reopening => {
      const answers = ["# 1.2 True", "# 1.2 False.", "# 2.1 Yes", "# 2.1 No", "# 2.1 None",
        "# 1.2 B", "# 1.2 A, C", "# 1 True"];
      const texts = ["Answer Key", ...answers.flatMap(answer => [answer, "5 units."]), reopening, "Public continuation."];
      await expectArchivedPdfPages(texts, [texts.length - 1, texts.length], 3);
    },
  );

  it.each([
    "Appendix: Solutions", "Appendix: Answers", "Appendix Solutions", "Appendix — Answer Key",
    "Appendix: Selected Answers", "附录：参考答案", "附录：习题解答", "附录 答案", "附录答案",
  ])("opens a second archived answer section at %s", async heading => {
    await expectArchivedPdfPages(["Answer Key", "Works Cited", heading, "5 units."], [2], 4);
  });

  it.each(["# A, C #", "# B, D.", "# A, C", "# 1.2 True #", "# ###"])(
    "keeps archived answer continuations sealed through %s", async choice => {
      await expectArchivedPdfPages([
        "# Answer Key #", choice, "5 units.", "## Works Cited ##", "## Appendix: Solutions ##", "5 units.",
        "# Algebra, Calculus #", "Public continuation.",
      ], [4, 7, 8], 3);
    },
  );

  it.each([
    "正确答案", "课后练习解答", "章节答案", "练习题答案", "练习题解答",
    "复习题答案", "复习题解答", "自测题答案", "自测题解答",
  ])("keeps an archived Chinese appendix sealed at %s", async title => {
    await expectArchivedPdfPages(["Works Cited", `## 附录：${title} ##`, "5 units."], [1], 3);
  });

  it.each([
    "参考答案与解析", "参考答案", "标准答案", "正确答案", "课后习题答案",
    "课后练习答案", "课后练习解答", "课后答案", "课后解答", "章节答案",
    "习题答案", "习题解答", "练习题答案", "练习题解答", "练习答案",
    "练习解答", "复习题答案", "复习题解答", "自测题答案", "自测题解答",
    "思考题答案", "部分习题答案", "答案与解析", "参考解答", "详细解答",
  ])("seals archived continuations after same-line content on %s", async title => {
    await expectArchivedPdfPages([`${title}：x = 3.`, "5 units.", "Chapter 2: Rings"], [3], 2);
  });

  it.each(["【参考答案】", "【参考答案（续）】", "【 参考答案 (接上页) 】"])(
    "seals the archived continuation after %s with same-line content", async heading => {
      await expectArchivedPdfPages([heading + "x = 3.", "5 units.", "Chapter 2: Rings"], [3], 2);
    },
  );

  it.each(["【答案】", "【正确答案】", "【解答】", "Solution:"])(
    "withholds an archived exercise's pending %s through its answer page", async label => {
      const stem = "Exercise 1. Solve x - 3 = 0.";
      const publicText = "Public prose continues here.";
      await expectArchivedPdfPages([stem + "\n" + label, "x = 3.", publicText], [3], 2);
      await expectArchivedPdfPages([stem, label + "\nx = 3.", publicText], [1, 3], 2);
    },
  );

  it("ends an archived inline answer after a paragraph break or a public heading", async () => {
    const stem = "Exercise 1. Solve x - 3 = 0.\n【答案】";
    await expectArchivedPdfPages([stem, "x = 3\n\nFollowing explanation", "Public prose continues here."], [3], 2);
    await expectArchivedPdfPages([stem, "x =", "3.", "Public prose continues here."], [4], 3);
    await expectArchivedPdfPages([stem, "x =", "Chapter 2: Rings", "Public prose continues here."], [3, 4], 2);
  });

  it.each(["IV.", "(iv).", "[iv].", "（iv）。", "- iv -.", "pp. 12.", "Page 12 of 300.",
    "12 / 300.", "- 12 -.", "第 十二页。", "第十二 / 三百頁。", "第十二页（共三百页）",
    "第 12 页 / 共 300 页", "第 12 页，共 300 页", "共三百页 第十二页", "Page 12",
    "Chapter 2 — Page 12", "第 2 章 | 第 12 页", "Chapter 2 Algebra — Page 12", "Chapter 2: Algebra | Page 12",
    "Section 2.1 Rings - Page 12", "第 2 章 线性代数 — 第 12 页", "2.1 Finite Groups — Page 12", "Algebra — Page 12"])(
    "ignores the running footer %j after a pending archived exercise answer", async footer => {
      const stem = "Exercise 1. Solve x - 3 = 0.\n【答案】";
      await expectArchivedPdfPages([stem + "\n" + footer, "x = 3.", "Public prose continues here."], [3], 2);
    },
  );

  it.each(["Figure out the roots by factoring.", "Figure:", "# Figure:", "Table 1 gives the factorization.",
    "Claim I can factor the polynomial.", "Note how the factors cancel.", "Definition of the notation is given below.",
    "Theorem 2.1 states this fact.", "Lemma 1.2 implies x = 3.", "Definition 3.1 requires a field.", "Figure 2 illustrates the construction.",
    "**Theorem 2.1** states this fact.", "**Theorem 2.1 states this fact.**", "__Table 1__ gives the factorization.",
    "Chapter 2 explains why this equation holds.", "Section 2.1 shows the derivation.", "Appendix A gives the factorization.",
    "表 1 给出了分解结果。", "图 2 显示了图像", "插图 1 列出了各项", "附表 1 描述了计算", "算法 1 说明了计算",
    "第 2 章解释了原因。", "第 1 节给出了推导", "定理 2.1 说明了该事实。", "引理 1 给出了条件",
    "定义 3 描述了对象", "命题 1 说明了该事实", "推论 1 可由上式得到",
    "图 2（a）显示了函数图像。", "图 2(a) 显示了函数图像。", "表 3（1）列出了数据。",
    "Figure 2(a) shows the graph.", "Table 3 (b) lists the values.", "Theorem 2.1 (Lagrange) states that G is finite.",
    "Figure 2 a: shows the graph.", "Example 1 (Lagrange) gives the construction.",
    "Figure 2(a), which shows the graph, is useful here.", "Theorem 2.1 (Lagrange), applied to G, gives the result.",
    "定理 2.1（拉格朗日），应用于 G，可得结果。", "Figure 2(a):, which shows the graph.", "Theorem 2.1: This gives the result.",
    "3.14 is the desired approximation.", "3.14 Euler's constant is irrational.", "2.718 = e", "3.14 是所需近似值。",
    "3.14 V", "3.14 厘米", "3.14 kPa", "3.14 kg/m^3", "3.14 Mmol", "3.14 平方公里/秒", "3.14 有三个解"])(
    "keeps ordinary %j inside an archived inline answer", async line => {
      const stem = "Exercise 1. Solve x - 3 = 0.\n【解答】";
      await expectArchivedPdfPages([stem, line + "\nx = 3.", "Public prose continues here."], [3], 2);
    },
  );

  it.each(["Figure 1 The rings", "Table A.2: Ring operations", "Fig. IV: Ring diagram", "Tab. 2.1 Data",
    "Table 1 Summary", "Diagram I", "# Section 2.2: Ring operations", "Theorem 2.1", "Theorem 2.1.",
    "Theorem 2.1 (Lagrange)", "# Theorem 2.1: finite rings", "**Theorem 2.1.** finite rings",
    "**Theorem 2.1**", "**Table 1: Roots**", "Chapter 2", "Lesson 2 Finite Fields", "# Section 2.2: finite rings",
    "第一章 环与域", "第 2 章：群", "表 1：分解结果", "表 1 分解结果", "定理 2.1：拉格朗日定理",
    "图 2（a）：函数图像", "Figure 2(a): Function graph", "定理 2.1（拉格朗日定理）",
    "2.1 Ring Homomorphisms", "2.1.3 Kernel of a Homomorphism", "2.3 线性变换的矩阵",
    "2.1 有限群", "2.2 有理数域", "2.3 有界算子", "2.4 在线算法"])(
    "reopens an archived inline answer at the structural heading %j", async heading => {
      const stem = "Exercise 1. Solve x - 3 = 0.\n【解答】";
      await expectArchivedPdfPages([stem, "x =", heading, "Public prose continues here."], [3, 4], 2);
    },
  );

  it.each(["Chapter 2 explains why this equation holds.", "第 2 章解释了原因。", "Appendix A gives the factorization."])(
    "does not reopen an archived answer section at the reference %j", async line => {
      await expectArchivedPdfPages(["Answer Key", line + "\nx = 3.", "5 units.", "Chapter 3: Fields"], [4], 3);
    },
  );

  it.each(["Theorem 2.1 (Lagrange)", "定理 2.1（拉格朗日定理）", "Definition 1.2", "定义 1.2",
    "Worked Example 2.1", "例题 2.1", "2.1 有限群", "2.1 AI", "2.1 ML", "2.1 OS", "2.1 LP",
    "Preface", "Introduction: Rings", "序言", "前言", "引言：环"])("reopens an archived answer section at %j after proofs and furniture", async heading => {
    await expectArchivedPdfPages([
      "Answer Key", "Proof:\n证明：\n5 units.", "Chapter 2 Algebra — Page 12\nx = 3.",
      "Chapter 2: What Is Algebra? — Page 12\n" + heading + "\nPublic explanation.", "Public continuation.",
    ], [4, 5], 3);
  });

  it("keeps measurements, result clauses, ATX prose references and titled furniture sealed across archive readers", async () => {
    const answerLines = [
      "3.14 千瓦时", "3.14 毫安时", "3.14 千瓦·时", "3.14 千伏安", "3.14 牛·米", "3.14 米每秒",
      "3.14 千米每小时", "3.14 公顷", "3.14 亩", "3.14 有实数解", "3.14 有唯一解", "3.14 在区间内", "3.14 在实数域上",
      "3.14 V", "3.14 Hz", "3.14 cm", "3.14 dB", "3.14 mL", "3.14 MB",
      "## Theorem 2.1 (Lagrange), applied to G, gives the result.", "## Figure 2(a), which shows the graph, is useful here.",
      "## Chapter 2 explains why this is true.", "## 图 2（a）显示了函数图像。", "## Example 2 gives the result.",
      "## The construction is shown below.", "## Introduction to Answers",
      "Chapter 2: What Is Algebra? — Page 12", "Section 1: What is a Ring? | Page 12",
      "第 2 章：什么是代数？｜第 12 页", "What Is Algebra? — Page 12",
    ];
    const chapter = "What Is Algebra? — Page 12\nTheorem 2.1 (Lagrange)\nPublic explanation.";
    await expectArchivedPdfPages(["Answer Key", ...answerLines.map(line => line + "\nx = 3."), chapter],
      [answerLines.length + 2], 2);
    await expectArchivedPdfPages(["Exercise 1. Solve for x.\n【解答】", answerLines.slice(0, 24).join("\n") + "\nx = 3.",
      "Chapter 3: Fields"], [3], 2);
  });

  it.each(["【解析】", "【详解（续）】", "解析（接上页）", "解析：", "详解", "详解：", "【解答(续)】"])(
    "seals an archived exercise explanation opened by %s across the page break", async label => {
      const stem = "Exercise 1. Solve x - 3 = 0.";
      await expectArchivedPdfPages([stem + "\n" + label, "x = 3.", "Public prose continues here."], [3], 2);
    },
  );

  it.each(["【解析】", "【详解（续）】", "解析：", "详解：", "解：", "【解答】", "解答（续）：", "解答（接上页）"])(
    "keeps worked-example explanations with %s public on the same and following pages", async label => {
      const example = "例题 1：解方程。";
      const explanation = label + "\nx = 3.";
      await expectArchivedPdfPages([example + "\n" + explanation, explanation, "【解析】\nPublic derivation.",
        "Chapter 2: Rings", explanation, "Chapter 3: Fields"], [1, 2, 3, 4, 6], 5);
    },
  );

  it("authorizes a worked-example excerpt found in its vetted chunk", async () => {
    const example = "例题 1：解方程。\n【解析】\nx = 3.";
    const pdf = await expectArchivedPdfPages([example, "Definition 2.1: A ring.", "【解析】\ny = 4."], [1, 2], 3);
    const chunk = pdf.snapshot.chunks[0]!;
    const excerpt = { ...chunk, text: "【解析】\nx = 3." };
    const modified = { ...chunk, text: "【解析】\ny = 4." };
    expect((await pdf.repository.authorizeChunks(f.scope, [excerpt, modified])).chunks).toEqual([excerpt]);
  });

  it("counts a sentence beginning with Page as inline answer body", async () => {
    await expectArchivedPdfPages(["Exercise 1. Solve x - 3 = 0.\n【答案】\nPage 2 gives the result.",
      "Public prose continues here."], [2], 1);
  });

  it("treats a label-only Chinese answer as a section after a structural heading ends the exercise", async () => {
    await expectArchivedPdfPages([
      "Exercise 1. Solve x - 3 = 0.", "Chapter 2: Rings", "【正确答案】", "5 units.", "Chapter 3: Fields",
    ], [1, 2, 5], 4);
  });

  it.each(["答案：x = 3.", "解答：x = 3."])("keeps the following page public after the inline label %s", async label => {
    await expectArchivedPdfPages([label, "Public continuation."], [2], 1);
  });

  it("keeps historical legacy seals settled while the current PDF version is retried", async () => {
    const pdf = await seed(["Public exercise prompt.", "Chapter 2: Vectors"]);
    const marker = { page: 1, text: "", imagePath: null, sectionSealedAtEnd: true, hadSealedContent: true };
    await f.sql`UPDATE opening_sources SET version=2,mime='application/pdf' WHERE id=${pdf.sourceId}`;
    await f.sql`INSERT INTO opening_pdf_parse_segments(workspace_id,source_id,source_version,parser_profile,page_start,page_end,state,pages)
      VALUES(${f.scope.workspaceId},${pdf.sourceId},1,'pdf-publication-page-seal-v1',1,1,'ready',${f.sql.json([marker])})`;
    for (const state of ["ready", "running", "failed"]) {
      await f.sql`UPDATE opening_sources SET parse_state=${state} WHERE id=${pdf.sourceId}`;
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { version: 1, page: 2 }))
        .resolves.toMatchObject({ version: 1, currentVersion: 2, pages: [1, 2], text: "Chapter 2: Vectors" });
    }

    await f.sql`UPDATE opening_pdf_parse_segments SET pages=${f.sql.json([{ ...marker, publicationSealCommitted: false }])}
      WHERE source_id=${pdf.sourceId} AND source_version=1`;
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { version: 1, page: 2 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("withholds an archived proof after the Vision proof boundary is staged and before chunks are replaced", async () => {
    const question = "Problem 1. Decide whether the claim holds.";
    const texts = ["Public notes before the question.", question, "Proof. The archived private argument.",
      "The rest of the private argument. ∎", "Chapter 2: Geometry\nThe next topic is public."];
    const pdf = await seed(texts);
    let checkedPendingSeal = false;
    const retry = await startPdfRetry(pdf.sourceId, texts.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: index === 1 ? ["picture"] : [],
    })), {
      recognizePage: async page => {
        expect(page.physicalPage).toBe(2);
        return { text: question + "\nAnswer:\nYes.", imageObjectKey: "vision/question" };
      },
    }, [], async marker => {
      if (marker.page !== 2) return;
      expect(marker).toMatchObject({ inlineProofBoundaryPendingAtEnd: true, publicationSealCommitted: false });
      expect(marker.inlineSealedAtEnd).toBe(false);
      const [archived] = await f.sql`SELECT text FROM opening_source_chunks WHERE source_id=${pdf.sourceId} AND page=3`;
      expect(archived?.text).toBe(texts[2]);
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      const chunks = createOpeningSourceChunksRepository(f.sql);
      expect((await chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.page)).toEqual([1]);
      checkedPendingSeal = true;
    });
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 }))
      .resolves.toMatchObject({ text: texts[2] });
    await retry.run();
    expect(checkedPendingSeal).toBe(true);
    expect((await retry.chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.page)).toEqual([1, 2, 5]);
  });

  it("uses the native scan's trailing answer boundary when only Vision sees the same-page proof", async () => {
    const pdf = await seed("Previously published source.");
    const texts = ["1. Find x.", "The private derivation continues.", "The private derivation ends. ∎", "Public prose follows."];
    const retry = await startPdfRetry(pdf.sourceId, texts.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: index === 0 ? ["picture"] : [],
      ...(index === 0 ? { hadSealedContent: true, inlineSealedAtEnd: false,
        inlineProofBoundaryPendingAtEnd: true, previousNumberedQuestionAtEnd: false } : {}),
    })), { recognizePage: async () => ({ text: "[图片描述]\nProof. The private derivation begins.", imageObjectKey: "vision/proof" }) });
    const result = await retry.run();
    await retry.finish(result.pages);
    const published = await retry.chunks.listChunks(f.scope, pdf.sourceId);
    expect(published.filter(chunk => chunk.page !== 1).map(chunk => chunk.page)).toEqual([4]);
  });

  it("does not restore a stale committed proof boundary when saved Vision closes it and live Vision returns null", async () => {
    const texts = ["Problem 1. Decide whether the identity holds.\nAnswer: Yes.",
      "[视觉转写与描述]\n[图片描述]\nProof. The private argument ends. Q.E.D.",
      "Proof. This separate proof is public.", "The public proof ends. ∎"];
    const pdf = await seed(texts);
    const marker = { page: 2, text: "", imagePath: null, hadSealedContent: true, visualKinds: ["scan"],
      inlineProofBoundaryPendingAtEnd: true, publicationSealCommitted: true };
    await f.sql`INSERT INTO opening_pdf_parse_segments(workspace_id,source_id,source_version,parser_profile,page_start,page_end,state,pages)
      VALUES(${f.scope.workspaceId},${pdf.sourceId},1,'pdf-publication-page-seal-v1',2,2,'ready',${f.sql.json([marker])})`;
    const recognizePage = vi.fn(async () => null);
    const retry = await startPdfRetry(pdf.sourceId, texts.map((text, index) => ({
      page: index + 1, text: index === 1 ? "" : text, imagePath: null, visualKinds: index === 1 ? ["scan"] : [],
    })), { recognizePage });
    const result = await retry.run();
    await retry.finish(result.pages);
    expect(recognizePage).toHaveBeenCalledOnce();
    const published = await retry.chunks.listChunks(f.scope, pdf.sourceId);
    expect(published.filter(chunk => chunk.page && chunk.page > 2).map(chunk => chunk.text)).toEqual(texts.slice(2));
    const [row] = await f.sql`SELECT pages->0 AS marker FROM opening_pdf_parse_segments
      WHERE source_id=${pdf.sourceId} AND page_start=2 AND parser_profile='pdf-publication-page-seal-v1'`;
    expect(row?.marker?.publicationSealCommitted).toBe(true);
    expect(row?.marker?.inlineProofBoundaryPendingAtEnd).toBeUndefined();
  });

  it.each(["empty response", "confirmed native seal", "native seal with unverified picture", "batch setup failure"])(
    "withdraws archived images and continuations after %s", async failure => {
      const publicText = "Chapter 2: Geometry";
      const confirmed = failure === "confirmed native seal" || failure === "native seal with unverified picture";
      const nativeText = failure === "native seal with unverified picture" ? "123" : publicText;
      const markerPage = confirmed ? 1 : 2;
      const archived = [publicText, confirmed ? "5 units." : "123", "5 more units."];
      const pdf = await seed(archived);
      await f.sql`UPDATE opening_source_chunks SET image_object_key='archived/image'
        WHERE source_id=${pdf.sourceId} AND page=${markerPage}`;
      const reads: number[] = [];
      const visual = createSourceVisualRecognition({
        repository: { read: async (_scope, { physicalPage }) => {
          reads.push(physicalPage);
          if (physicalPage === 2) throw new Error("Scan cache unavailable");
          return null;
        }, save: vi.fn(), assertCurrent: vi.fn(), ledger: vi.fn(), releasedReservation: vi.fn() },
        gateway: { call: vi.fn() }, budget: vi.fn(), storage: { finalKey: () => "final" }, renderPdf: vi.fn(),
      });
      const retry = await startPdfRetry(pdf.sourceId, [
        { page: 1, text: nativeText, imagePath: null, visualKinds: confirmed || failure === "batch setup failure" ? ["picture"] : [],
          ...(confirmed ? { hadSealedContent: true, sectionSealedAtEnd: true } : {}) },
        { page: 2, text: confirmed ? "" : "123", imagePath: null, visualKinds: confirmed ? [] : ["scan"] },
        { page: 3, text: "5 more units.", imagePath: null, visualKinds: [] },
      ], failure === "batch setup failure" ? { recognizePages: visual.recognizePages } : {
        recognizePage: async () => {
          if (confirmed) throw new Error("Vision unavailable");
          return { text: "", imageObjectKey: "recognized/2" };
        },
      });
      expect((await retry.chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.text)).toEqual(archived);
      await expect(retry.run()).rejects.toThrow(confirmed ? "Vision unavailable"
        : failure === "batch setup failure" ? "Scan cache unavailable" : "no readable content");
      if (failure === "batch setup failure") expect(reads).toEqual([1, 2]);
      const markers = await f.sql`SELECT pages FROM opening_pdf_parse_segments
        WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1'`;
      expect(markers).toEqual([{ pages: [expect.objectContaining({ page: markerPage, publicationSealCommitted: false,
        hadSealedContent: confirmed, sectionSealedAtEnd: confirmed,
        publicationSealUnknown: !confirmed || failure === "native seal with unverified picture",
      })] }]);
      const expected = confirmed ? [] : [publicText];
      for (const state of ["running", "failed", "ready"]) {
        await f.sql`UPDATE opening_sources SET parse_state=${state} WHERE id=${pdf.sourceId}`;
        expect((await retry.chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.text)).toEqual(expected);
      }
      // Exercise the other readers after a status-only write claims the PDF is ready.
      expect((await retry.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).map(chunk => chunk.text)).toEqual(expected);
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: markerPage }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 }))
        .rejects.toMatchObject({ code: "NOT_FOUND" });
      if (!confirmed) await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 1 }))
        .resolves.toMatchObject({ text: publicText, pages: [1] });
      expect((await pdf.repository.snapshot(f.scope, pdf.sourceId))?.chunks.map(chunk => chunk.text)).toEqual(expected);
      const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
      expect((await pdf.repository.search(f.scope, query)).map(({ chunk }) => chunk.text)).toEqual(expected);
      expect(await backfilledPages(pdf)).toEqual(confirmed ? [] : [1]);
    },
  );

  it.each([
    { scenario: "later native seal", boundary: 2, section: true, inline: false, unknown: false },
    { scenario: "archived Vision seal", boundary: 1, section: false, inline: true, unknown: false },
    { scenario: "batch with a reusable scan", boundary: 3, section: false, inline: false, unknown: true },
  ])("keeps publication fenced after Vision fails with $scenario", async ({ boundary, section, inline, unknown }) => {
    const native = "Chapter 2: Geometry";
    const savedVision = "[视觉转写与描述]\n[原图忠实转写]\n";
    const savedScan = savedVision + "Public scan notes.";
    const archived = [
      inline ? "[原生提取]\n" + native + "\n\n" + savedVision + native + "\nSolution:" : native,
      unknown ? savedScan : "Archived page text.",
      unknown ? "123" : "5 units.",
      "5 more units.",
    ];
    const pdf = await seed(archived);
    await f.sql`UPDATE opening_source_chunks SET image_object_key='archived/image'
      WHERE source_id=${pdf.sourceId} AND (page=${boundary} OR (${unknown} AND page=2))`;
    const visual = createSourceVisualRecognition({
      repository: {
        read: async (_scope, { physicalPage }) => {
          if (physicalPage === 3) throw new Error("Vision unavailable");
          expect(physicalPage).toBe(1);
          return null;
        },
        save: vi.fn(), assertCurrent: vi.fn(), ledger: vi.fn(), releasedReservation: vi.fn(),
      },
      gateway: { call: vi.fn() }, budget: vi.fn(), storage: { finalKey: () => "final" }, renderPdf: vi.fn(),
    });
    const retry = await startPdfRetry(pdf.sourceId, [
      { page: 1, text: native, imagePath: null, visualKinds: ["picture"] },
      { page: 2, text: unknown || section ? "" : "5 units.", imagePath: null, visualKinds: unknown ? ["scan"] : [],
        ...(section ? { hadSealedContent: true, sectionSealedAtEnd: true } : {}) },
      { page: 3, text: unknown ? "123" : "5 units.", imagePath: null, visualKinds: unknown ? ["scan"] : [] },
      { page: 4, text: "5 more units.", imagePath: null, visualKinds: [] },
    ], unknown ? { recognizePages: visual.recognizePages } : {
      recognizePage: async () => { throw new Error("Vision unavailable"); },
    });
    const { chunks } = retry;
    // The archived inline answer and its first continuation are already hidden on read.
    expect((await chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.text))
      .toEqual(inline ? archived.slice(2) : archived);
    await expect(retry.run()).rejects.toThrow("Vision unavailable");
    expect(await f.sql`SELECT pages FROM opening_pdf_parse_segments
      WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1'`).toEqual([
      { pages: [expect.objectContaining({ page: boundary, hadSealedContent: section || inline,
        sectionSealedAtEnd: section, inlineSealedAtEnd: inline, publicationSealUnknown: unknown,
        publicationSealCommitted: false, ...(inline ? { publicationSealHadPublicPrefix: true } : {}),
      })] },
    ]);
    const expectedPages = unknown ? [1, 2] : section ? [1] : [];
    const publicChunks = await chunks.listForSources(f.scope, [pdf.sourceId]);
    expect(publicChunks.map(({ page }) => page)).toEqual(expectedPages);
    if (unknown) expect(publicChunks[1]).toMatchObject({ text: savedScan, imageObjectKey: "archived/image" });
    expect((await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).map(({ page }) => page)).toEqual(expectedPages);
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: boundary }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 4 }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
    if (unknown) await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 }))
      .resolves.toMatchObject({ pages: expectedPages, text: savedScan });
    expect(await backfilledPages(pdf)).toEqual(expectedPages);

    // A status write cannot settle the marker or re-admit the stale embeddings.
    await f.sql`UPDATE opening_sources SET parse_state='ready' WHERE id=${pdf.sourceId}`;
    const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
    expect((await pdf.repository.snapshot(f.scope, pdf.sourceId))?.chunks.map(({ page }) => page)).toEqual(expectedPages);
    expect((await pdf.repository.search(f.scope, query)).map(({ chunk }) => chunk.page).sort()).toEqual(expectedPages);
  });

  it.each([
    { archive: "[视觉转写与描述]\nChapter 1: Intro\nAnswer Key", fullySealed: false },
    { archive: "[视觉转写与描述]\nAnswer Key", fullySealed: true },
    { archive: "Answer Key", fullySealed: false },
    { archive: "Answer Key", fullySealed: true },
  ])("keeps archived Vision provenance on retry (archive: $archive, fully sealed: $fullySealed)", async ({ archive, fullySealed }) => {
    const texts = ["Chapter 1: Intro", "5 units.", "Chapter 2: Rings"];
    const pdf = await seed([archive, ...texts.slice(1)]);
    await f.sql`UPDATE opening_source_chunks SET image_object_key='vision/p1' WHERE source_id=${pdf.sourceId} AND page=1`;
    const pages: PdfSegmentPage[] = texts.map((text, index) => ({ page: index + 1, text, imagePath: null, visualKinds: [] }));
    const initialPages = fullySealed
      ? [{ ...pages[0]!, text: "", hadSealedContent: true, sectionSealedAtEnd: true }, ...pages.slice(1)]
      : pages;
    for (const extracted of [initialPages, pages]) {
      const retry = await startPdfRetry(pdf.sourceId, extracted);
      await expect(retry.run()).resolves.toEqual({ pages: 3 });
      await retry.finish(3);
      const published = await retry.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1);
      expect(published.map(({ page, text }) => [page, text])).toEqual([[3, texts[2]]]);
      const [marker] = await f.sql`SELECT pages FROM opening_pdf_parse_segments
        WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1' AND page_start=1`;
      expect(marker?.pages).toMatchObject([{ hadSealedContent: true, publicationSealCommitted: true,
        sectionSealedAtEnd: true, publicationSealHadPublicPrefix: false, visualKinds: [] }]);
    }
  });

  it.each([false, true].flatMap(failed => [
    { failed, form: "new prose", archivedAnswer: "The answer is deter-\nmined by factoring.",
      freshAnswer: "Voltage is a potential difference.", reflowed: false },
    { failed, form: "ordinary hyphen", archivedAnswer: "The polynomial has three roots.\nThe answer is deter-\nmined by factoring.",
      freshAnswer: "The polynomial has three roots. The answer is determined by factoring.", reflowed: true },
    { failed, form: "soft hyphen", archivedAnswer: "The answer is deter\u00ad\nmined by factoring.",
      freshAnswer: "The answer is determined by factoring.", reflowed: true },
    { failed, form: "CJK wrap", archivedAnswer: "此式由因式分\n解得到。", freshAnswer: "此式由因式分解得到。", reflowed: true },
  ]))("retries an archived native answer ($form, failed retry: $failed)", async ({ failed, archivedAnswer, freshAnswer, reflowed }) => {
    const archived = ["Answer Key", archivedAnswer,
      "Chapter 3: Fields\nThis chapter introduces fields."];
    const pdf = await expectArchivedPdfPages(archived, [3], 2);
    const fresh = ["This introduction explains polynomial rings.", freshAnswer, archived[2]!];
    const pages = fresh.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: [],
    }));
    const readMarker = async () => {
      const [row] = await f.sql`SELECT pages->0 AS marker FROM opening_pdf_parse_segments
        WHERE source_id=${pdf.sourceId} AND page_start=2 AND parser_profile='pdf-publication-page-seal-v1'`;
      return row?.marker;
    };
    if (failed) {
      const first = await startPdfRetry(pdf.sourceId, pages, {}, [2]);
      await expect(first.run()).resolves.toMatchObject({ pages: 2 });
      await first.finish(2);
      expect((await first.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, undefined,
        { unpublishedPdfForRecovery: true })).map(chunk => chunk.page)).toEqual([1, 3]);
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await first.sources.get(f.scope, pdf.sourceId)).toMatchObject({ error: { code: "PARSE_PARTIAL" } });
      const marker = await readMarker();
      expect(marker).toMatchObject({ publicationSealUnknown: true, failedRangeBoundary: true, publicationSealCommitted: true,
        text: "", withheldNativeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) });
      expect(marker).not.toHaveProperty("hadSealedContent", true);
      expect(marker).not.toHaveProperty("sectionSealedAtEnd", true);
    }
    const retry = await startPdfRetry(pdf.sourceId, pages);
    await expect(retry.run()).resolves.toEqual({ pages: 3 });
    await retry.finish(3);
    expect(await retry.sources.get(f.scope, pdf.sourceId)).toMatchObject({ parseState: "ready", error: null });
    if (reflowed) {
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await readMarker()).toMatchObject({ hadSealedContent: true, sectionSealedAtEnd: true, publicationSealCommitted: true });
    } else {
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).resolves.toMatchObject({ text: fresh[1] });
    }
  });

  it.each(["The complete construction is shown on page 12.", "完整推导见第 12 页。"])(
    "recovers native prose containing a page reference after a conversion failure (%j)", async text => {
      const first = "This introduction explains polynomial rings.";
      const pdf = await seed([first]);
      const pages: PdfSegmentPage[] = [first, text].map((body, index) => ({
        page: index + 1, text: body, imagePath: null, visualKinds: [],
      }));
      const failed = await startPdfRetry(pdf.sourceId, pages, {}, [2]);
      await expect(failed.run()).resolves.toMatchObject({ pages: 1 });
      await failed.finish(1);
      expect(await failed.sources.get(f.scope, pdf.sourceId)).toMatchObject({ error: { code: "PARSE_PARTIAL" } });
      const retry = await startPdfRetry(pdf.sourceId, pages);
      await expect(retry.run()).resolves.toEqual({ pages: 2 });
      await retry.finish(2);
      expect(await retry.sources.get(f.scope, pdf.sourceId)).toMatchObject({ parseState: "ready", error: null });
      await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).resolves.toMatchObject({ text });
    },
  );

  it("persists a same-mode Vision seal across a subsequent native-only retry", async () => {
    const texts = ["Answer Key", "5 units.", "Chapter 3: Fields"];
    const pdf = await seed(texts);
    const pages: PdfSegmentPage[] = texts.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: [],
    }));
    const first = await startPdfRetry(pdf.sourceId, pages);
    await expect(first.run()).resolves.toEqual({ pages: 3 });
    await first.finish(3);
    const readMarker = async () => {
      const [marker] = await f.sql`SELECT pages FROM opening_pdf_parse_segments
        WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1' AND page_start=1`;
      return marker?.pages?.[0];
    };
    expect(await readMarker()).toMatchObject({ sectionSealedAtEnd: true, publicationSealCommitted: true });
    expect(await readMarker()).not.toHaveProperty("visualKinds");

    const nativeRecovery = { ...pages[0]!, text: "Chapter 2: Rings" };
    const recognizePage = vi.fn(async () => ({ text: "Answer Key", imageObjectKey: "vision/key" }));
    const vision = await startPdfRetry(pdf.sourceId,
      [{ ...nativeRecovery, visualKinds: ["picture"] }, ...pages.slice(1)], { recognizePage });
    await expect(vision.run()).resolves.toEqual({ pages: 3 });
    await vision.finish(3);
    expect(recognizePage).toHaveBeenCalledOnce();
    expect(await readMarker()).toMatchObject({ sectionSealedAtEnd: true, publicationSealCommitted: true, visualKinds: ["picture"] });

    const retry = await startPdfRetry(pdf.sourceId, [nativeRecovery, ...pages.slice(1)]);
    await expect(retry.run()).resolves.toEqual({ pages: 3 });
    await retry.finish(3);
    expect((await retry.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).map(({ page, text }) => [page, text]))
      .toEqual([[3, texts[2]]]);
  });

  it.each([false, true])("honors an archived Vision seal after a failed page (fresh description: %s)", async freshDescription => {
    const texts = ["Unavailable.", "Chapter 2: Rings", "5 units.", "Chapter 3: Fields"];
    const pdf = await seed([texts[0]!, "[视觉转写与描述]\nAnswer Key", ...texts.slice(2)]);
    await f.sql`DELETE FROM opening_source_chunks WHERE source_id=${pdf.sourceId} AND page=1`;
    await f.sql`UPDATE opening_source_chunks SET image_object_key='vision/key' WHERE source_id=${pdf.sourceId} AND page=2`;
    const pages: PdfSegmentPage[] = texts.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: freshDescription && index === 1 ? ["picture"] : [],
    }));
    const recognizePage = freshDescription ? vi.fn(async () => ({
      text: "【图表观察描述，非原文或解答】\nA ring diagram.", imageObjectKey: "vision/page-two",
    })) : undefined;
    const retry = await startPdfRetry(pdf.sourceId, pages, { recognizePage }, [1]);
    await expect(retry.run()).resolves.toEqual({ pages: 3 });
    if (recognizePage) expect(recognizePage).toHaveBeenCalledOnce();
    await retry.finish(3);
    expect(await retry.sources.get(f.scope, pdf.sourceId)).toMatchObject({ error: { code: "PARSE_PARTIAL" } });
    const [marker] = await f.sql`SELECT pages FROM opening_pdf_parse_segments
      WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1' AND page_start=2`;
    expect(marker?.pages).toMatchObject([{ sectionSealedAtEnd: true, publicationSealCommitted: true,
      visualKinds: freshDescription ? ["picture"] : [] }]);
    expect((await retry.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).map(({ page, text }) => [page, text]))
      .toEqual([[4, texts[3]]]);
  });

  it("retains a bracketed qualified section seal after publication drops its heading", async () => {
    const texts = ["【参考答案】x = 3.", "5 units.", "Chapter 2: Rings"];
    const pdf = await seed(texts);
    const retry = await startPdfRetry(pdf.sourceId, texts.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: [],
    })));
    await expect(retry.run()).resolves.toEqual({ pages: 3 });
    await retry.finish(3);
    expect((await retry.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, undefined, { unpublishedPdfForRecovery: true }))
      .map(({ page, text }) => [page, text])).toEqual([[3, texts[2]]]);
    expect((await pdf.repository.snapshot(f.scope, pdf.sourceId))?.chunks.map(({ page }) => page)).toEqual([3]);
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it.each([
    ["x = 3.", false], ["x = 3.", true], ["Chapter 2: Rings\nx = 3.", true],
  ] as const)(
    "keeps a Vision reopening and filters native %j on repeated retries after predecessor failure=%s", async (nativeText, failed) => {
      const predecessor = failed ? "Unavailable." : "This introduction explains sets and operations.";
      const pdf = await seed([predecessor, "[视觉转写与描述]\nAnswer Key\nx = 3.", "Rings have two operations."]);
      if (failed) await f.sql`DELETE FROM opening_source_chunks WHERE source_id=${pdf.sourceId} AND page=1`;
      await f.sql`UPDATE opening_source_chunks SET image_object_key='vision/key' WHERE source_id=${pdf.sourceId} AND page=2`;
      expect(await f.sql`SELECT 1 FROM opening_pdf_parse_segments
        WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1'`).toHaveLength(0);
      const recognizePage = vi.fn(async () => ({
        text: "【原图忠实转写，尚需核对】\nChapter 2: Rings\nThis chapter studies polynomial rings.",
        imageObjectKey: "vision/page-two",
      }));
      const pages: PdfSegmentPage[] = [
        { page: 1, text: predecessor, imagePath: null, visualKinds: [] },
        { page: 2, text: nativeText, imagePath: null, visualKinds: ["picture"] },
        { page: 3, text: "Rings have two operations.", imagePath: null, visualKinds: [] },
      ];
      let firstText: string | undefined;
      for (const live of [true, true, false]) {
        const retry = await startPdfRetry(pdf.sourceId, pages, live ? { recognizePage } : {}, failed ? [1] : []);
        await expect(retry.run()).resolves.toEqual({ pages: failed ? 2 : 3 });
        await retry.finish(failed ? 2 : 3);
        if (failed) expect(await retry.sources.get(f.scope, pdf.sourceId)).toMatchObject({ error: { code: "PARSE_PARTIAL" } });
        const published = await retry.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, undefined, { unpublishedPdfForRecovery: true });
        expect(published.map(({ page }) => page)).toEqual(failed ? [2, 3] : [1, 2, 3]);
        const recovered = published.find(({ page }) => page === 2);
        expect(recovered?.text).toContain("Chapter 2: Rings\nThis chapter studies polynomial rings.");
        expect(recovered?.text).not.toContain("x = 3.");
        expect(recovered?.imageObjectKey).toBeNull();
        firstText ??= recovered?.text;
        expect(recovered?.text).toBe(firstText);
        expect(await f.sql`SELECT pages->0 AS marker FROM opening_pdf_parse_segments
          WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1' AND page_start=2`)
          .toMatchObject([{ marker: { hadSealedContent: true, reopenedSection: true, publicationSealCommitted: true,
            publicationSealHadPublicPrefix: true } }]);
        expect(await readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).toMatchObject({ text: firstText });
      }
      expect(recognizePage).toHaveBeenCalledTimes(2);
    },
  );

  it("seals sentence-case assessment sections before publication and index admission", async () => {
    const texts = ["Answers to exercises 1–5", "5 units.", "Chapter 2: Geometry"];
    const pdf = await seed(texts);
    const retry = await startPdfRetry(pdf.sourceId, texts.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: [],
    })));
    await expect(retry.run()).resolves.toMatchObject({ pages: 3 });
    expect((await retry.chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.text)).toEqual([texts[2]]);
    expect((await pdf.repository.snapshot(f.scope, pdf.sourceId))?.chunks.map(chunk => chunk.text)).toEqual([texts[2]]);
    await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 2 })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("publishes fresh native prose and the continuation on the first retry after unreadable Vision", async () => {
    const texts = ["Public introduction.", "Chapter 2: Geometry\nThis section introduces triangles.", "Public continuation."];
    const pdf = await seed([texts[0]!, "123", texts[2]!]);
    const pages: PdfSegmentPage[] = texts.map((text, index) => ({ page: index + 1, text, imagePath: null, visualKinds: [] }));
    const failed = await startPdfRetry(pdf.sourceId, [pages[0]!,
      { ...pages[1]!, text: "123", visualKinds: ["picture"] }, pages[2]!],
    { recognizePage: async () => ({ text: "[unreadable]", imageObjectKey: "archived/image" }) });
    await expect(failed.run()).resolves.toMatchObject({ pages: 3, degraded: true });
    await failed.finish(3);
    expect((await failed.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, [2], { unpublishedPdfForRecovery: true }))[0]?.text)
      .toContain("[unreadable]");

    const retry = await startPdfRetry(pdf.sourceId, pages);
    await expect(retry.run()).resolves.toEqual({ pages: 3 });
    expect((await retry.chunks.listForSources(f.scope, [pdf.sourceId])).map(({ text, imageObjectKey }) => [text, imageObjectKey]))
      .toEqual(texts.map(text => [text, null]));
    expect(await retry.sources.get(f.scope, pdf.sourceId)).toMatchObject({ parseState: "ready", error: null });
  });

  it("ranks the three admitted pages even with 55 closer pages in the same book", async () => {
    const book = await seed(Array.from({ length: 58 }, (_, i) => `page ${i + 1}`));
    const other = await seed("another book");
    const targets = book.snapshot.chunks.filter(chunk => chunk.page! > 55);
    await book.repository.store(f.scope, book.snapshot, model,
      segmentMaterialChunks(targets).map(segment => ({ ...segment, vector: [0, 1, 0] })));
    const chunkIds = targets.map(chunk => chunk.id);
    const query = { ...model, vector: [1, 0, 0], sourceIds: [book.sourceId], privacyEpoch: book.snapshot.privacyEpoch,
      chunkIds: [...chunkIds, other.snapshot.chunks[0]!.id] };
    const search = (scope: typeof query) => book.repository.search(f.scope, scope);
    expect((await search(query)).map(row => row.chunk.id).sort()).toEqual(chunkIds.sort());
    expect(await search({ ...query, sourceIds: [] })).toEqual([]);
    expect(await search({ ...query, chunkIds: [] })).toEqual([]);
    expect(await search({ ...query, privacyEpoch: query.privacyEpoch + 1 })).toEqual([]);
    expect(await book.repository.hasIndex(f.scope, { ...query, chunkIds: [other.snapshot.chunks[0]!.id] })).toBe(false);
  });

  it("holds a timed-out embedding once, then admits the tutor within the remaining workspace cap", async () => {
    const { sourceId, snapshot, repository } = await seed("matrix kernel");
    const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 10 });
    const retrieve = createOpeningMaterialRetriever(f.sql, budget, { ...model, modelName: "embedding",
      baseUrl: "https://embedding.example.test/v1", apiKey: "fixture", billing: "metered",
      inputCentsPerMillion: 1, requestDimensions: true, dailyRequestCap: null });
    const parentBudget = { id: `study-turn:${randomUUID()}` };
    const input = { courseContext: { courseId: null, materialUse: "citation" as const }, chunks: snapshot.chunks,
      sourceIds: [sourceId], query: "kernel", maxCharacters: 2000, operationId: randomUUID(), parentBudget };
    const send = vi.spyOn(network, "fetchOpeningProvider").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(await retrieve(f.scope, input)).toMatchObject({ mode: "lexical", chunks: snapshot.chunks });
      }
      expect(send).toHaveBeenCalledTimes(1);
      const rows = await f.sql`SELECT state, amount_cents, outcome_unknown_at FROM opening_budget_reservations
        WHERE workspace_id=${f.scope.workspaceId} AND request_id=${`material-query:${input.operationId}`}`;
      expect(rows).toMatchObject([{ state: "reserved", amount_cents: 1, outcome_unknown_at: expect.any(Date) }]);
      const tutor = { purpose: "tutor", parentBudget, requestId: randomUUID() };
      await expect(budget.reserve(f.scope, { ...tutor, amountCents: 10 })).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
      await expect(budget.reserve(f.scope, { ...tutor, amountCents: 9 })).resolves.toMatchObject({ state: "reserved" });
      await budget.release(f.scope, tutor.requestId, "not_sent");
      expect(await budget.isParentNotSent(f.scope, parentBudget.id)).toBe(false);
      expect(await repository.isTurnWithRetrievalNotSent(f.scope, parentBudget.id, retrievalBudgetId(parentBudget.id))).toBe(false);
    } finally {
      send.mockRestore();
    }
  });

  it("enforces aggregate spend and call limits across retrieval and tutor under unlimited daily mode while isolating unknown blocking", async () => {
    const { sourceId, snapshot } = await seed("matrix kernel");
    const unlimitedBudget = createOpeningBudgetRepository(f.sql, { envCapCents: 0, dailyQuotaMode: "unlimited", parentCapCents: 10 });
    const retrieve = createOpeningMaterialRetriever(f.sql, unlimitedBudget, { ...model, modelName: "embedding",
      baseUrl: "https://embedding.example.test/v1", apiKey: "fixture", billing: "metered",
      inputCentsPerMillion: 1, requestDimensions: true, dailyRequestCap: null });
    const turnId = `study-turn:${randomUUID()}`;
    const parentBudget = { id: turnId, maxProviderCalls: 2 };
    const opId = randomUUID();
    const input = { courseContext: { courseId: null, materialUse: "citation" as const }, chunks: snapshot.chunks,
      sourceIds: [sourceId], query: "kernel", maxCharacters: 2000, operationId: opId, parentBudget };
    const send = vi.spyOn(network, "fetchOpeningProvider").mockImplementation((_url, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    try {
      expect(await retrieve(f.scope, input)).toMatchObject({ mode: "lexical", chunks: snapshot.chunks });
      expect(await retrieve(f.scope, input)).toMatchObject({ mode: "lexical", chunks: snapshot.chunks });
      expect(send).toHaveBeenCalledTimes(1);

      // Unknown embedding (1c, 1 call) still counts toward the turn family cap (10c, 2 calls).
      await expect(unlimitedBudget.reserve(f.scope, { purpose: "tutor", parentBudget, requestId: randomUUID(), amountCents: 10 }))
        .rejects.toMatchObject({ code: "PARENT_BUDGET_EXCEEDED" });
      // Lexical fallback tutor (9c) is NOT blocked by retrieval's unknown outcome and fits within 10c & 2 calls.
      const tutor = await unlimitedBudget.reserve(f.scope, { purpose: "tutor", parentBudget, requestId: randomUUID(), amountCents: 9 });
      expect(tutor).toMatchObject({ state: "reserved", amountCents: 9, parentInteractionId: turnId });
      await unlimitedBudget.settle(f.scope, tutor.id, 5);
      // 1c embedding + 5c tutor = 6c <= 10c, but 2 family calls already reached maxProviderCalls: 2.
      await expect(unlimitedBudget.reserve(f.scope, { purpose: "tutor", parentBudget, requestId: randomUUID(), amountCents: 1 }))
        .rejects.toMatchObject({ code: "PARENT_BUDGET_CALL_LIMIT" });
    } finally {
      send.mockRestore();
    }
  });

  it("requires a tutor reservation and admits a fresh attempt only when every recorded call was unsent", async () => {
    const repository = createOpeningSourceEmbeddingsRepository(f.sql);
    const budget = createOpeningBudgetRepository(f.sql, { envCapCents: 50 });
    const tutorId = randomUUID(), retrievalId = retrievalBudgetId(tutorId);
    const proof = () => repository.isTurnWithRetrievalNotSent(f.scope, tutorId, retrievalId);
    expect(await proof()).toBe(false);
    const tutor = { requestId: randomUUID(), purpose: "tutor", parentBudget: { id: tutorId }, amountCents: 1 };
    await budget.reserve(f.scope, tutor);
    await budget.release(f.scope, tutor.requestId, "not_sent");
    expect(await proof()).toBe(true);
    const embedding = { ...tutor, purpose: "material-embedding", requestId: randomUUID(), parentBudget: { id: retrievalId } };
    await budget.reserve(f.scope, embedding);
    expect(await proof()).toBe(false);
    await budget.release(f.scope, embedding.requestId, "cancelled");
    expect(await proof()).toBe(true);
    const nestedEmbedding = { ...tutor, purpose: "material-embedding", requestId: randomUUID(), parentBudget: { id: `retrieval:${retrievalId}` } };
    await budget.reserve(f.scope, nestedEmbedding);
    expect(await proof()).toBe(false);
    expect(await budget.isParentNotSent(f.scope, tutorId)).toBe(false);
    await budget.release(f.scope, nestedEmbedding.requestId, "not_sent");
    expect(await proof()).toBe(true);
    expect(await budget.isParentNotSent(f.scope, tutorId)).toBe(true);
    expect(await repository.isTurnWithRetrievalNotSent(f.otherScope, tutorId, retrievalId)).toBe(false);
  });

  it("commits parsing readiness and index outbox together, and supports old-source reindex", async () => {
    const s = await seed("矩阵的零空间");
    const jobs = await f.sql`SELECT j.id,j.payload,o.payload AS dispatch FROM opening_jobs j JOIN opening_outbox o ON o.job_id=j.id
      WHERE j.kind='index-source' AND j.workspace_id=${f.scope.workspaceId} AND j.payload->>'sourceId'=${s.sourceId}`;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({ sourceId: s.sourceId, sourceVersion: 1 });
    expect(jobs[0]?.dispatch).toMatchObject({ kind: "index-source", sourceId: s.sourceId });
    const rebuilt = await s.repository.reindex(f.scope, s.sourceId);
    expect(rebuilt.jobId).not.toBe(jobs[0]?.id);
    await expect(s.repository.reindex(f.otherScope, s.sourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("filters owner, privacy, source version, model and dimensions before cosine distance", async () => {
    const a = await seed("核空间 kernel"), b = await seed("foreign secret", f.otherScope);
    const query = { ...model, sourceIds: [a.sourceId, b.sourceId], vector: [1, 0, 0] };
    expect((await a.repository.search(f.scope, query)).map(row => row.chunk.sourceId)).toEqual([a.sourceId]);
    expect(await a.repository.search({ ...f.scope, ownerUserId: f.otherScope.ownerUserId }, query)).toEqual([]);
    expect(await a.repository.search(f.scope, { ...query, modelKey: "different-model" })).toEqual([]);
    await a.repository.store(f.scope, a.snapshot, { modelKey: "2d-model", dimensions: 2 },
      segmentMaterialChunks(a.snapshot.chunks).map(segment => ({ ...segment, vector: [1, 0] })));
    expect(await a.repository.search(f.scope, query)).toHaveLength(1);
    await f.sql`UPDATE opening_sources SET version=2,parse_state='running' WHERE id=${a.sourceId}`;
    expect(await a.repository.search(f.scope, query)).toEqual([]);
    expect(await a.repository.hasIndex(f.scope, { ...model, sourceIds: [a.sourceId] })).toBe(false);
    // Explicit historical pages remain readable while the replacement is parsing; dense recall uses current versions only.
    expect((await a.repository.authorizeChunks(f.scope, a.snapshot.chunks)).chunks).toEqual(a.snapshot.chunks);
    await expect(a.repository.store(f.scope, a.snapshot, model, [])).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("rechecks exclusion/epoch at send and write boundaries and removes excluded lexical chunks", async () => {
    const s = await seed("private mathematics");
    await f.sql`INSERT INTO opening_privacy_exclusions(workspace_id,source_id,deleted_at) VALUES(${f.scope.workspaceId},${s.sourceId},now())`;
    await f.sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${f.scope.workspaceId}`;
    await expect(s.repository.assertCurrent(f.scope, s.snapshot)).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(s.repository.store(f.scope, s.snapshot, model, [])).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await s.repository.search(f.scope, { ...model, sourceIds: [s.sourceId], vector: [1, 0, 0] })).toEqual([]);
    expect((await s.repository.authorizeChunks(f.scope, s.snapshot.chunks)).chunks).toEqual([]);
    await expect(s.repository.reindex(f.scope, s.sourceId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps long-page tail vectors and cascades them when physical chunks or sources are deleted", async () => {
    const s = await seed("汉".repeat(5000) + "last theorem");
    const found = await s.repository.search(f.scope, { ...model, sourceIds: [s.sourceId], vector: [1, 0, 0] });
    expect(found).toHaveLength(3);
    expect(found.sort((a, b) => a.segmentIndex - b.segmentIndex).map(row => row.chunk.text).join("")).toBe(s.snapshot.chunks[0]!.text);
    await createOpeningSourceChunksRepository(f.sql).replaceChunks(f.scope, { sourceId: s.sourceId, sourceVersion: 1,
      chunks: [{ text: "replacement", page: 1, slideLabel: null, startMs: null, endMs: null, imageObjectKey: null }] });
    expect(await f.sql`SELECT 1 FROM opening_source_embeddings WHERE source_id=${s.sourceId}`).toHaveLength(0);
    const second = await seed("delete cascade");
    await f.sql`DELETE FROM opening_sources WHERE id=${second.sourceId}`;
    expect(await f.sql`SELECT 1 FROM opening_source_embeddings WHERE source_id=${second.sourceId}`).toHaveLength(0);
  });

  it("stores and retrieves adjacent numeric-leading formulas without splitting their math", async () => {
    const prefix = "a".repeat(5998);
    const formulas = "$2x$$y$";
    const pdf = await seed(prefix + formulas);
    const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
    const results = await pdf.repository.search(f.scope, query);
    expect(results.sort((a, b) => a.segmentIndex - b.segmentIndex).map(({ chunk }) => chunk.text))
      .toEqual([prefix, formulas]);
  });

  it("produces byte-for-byte identical Archive SQL answer_lines for adjacent emphasis and interior operators", async () => {
    const cases = [
      ["**Model** **Answer**: No.", "Model Answer: No."],
      ["**Answer:** **No.**", "Answer: No."],
      ["__Answer:__ __No.__", "Answer: No."],
      ["**Answer:** **2**3.**", "Answer: 2**3."],
      ["**Answer: 2**3.**", "Answer: 2**3."],
      ["**Answer: 2 ** 3.**", "Answer: 2 ** 3."],
      ["Answer: 2**3 + 4**5.", "Answer: 2**3 + 4**5."],
      ["Answer: x__1 + y__2.", "Answer: x__1 + y__2."],
    ] as const;
    for (const [rawLine, expectedNormalized] of cases) {
      const pdf = await seed([`1. Find x.\n${rawLine}`, "Public prose after the answer."]);
      await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
      const [row] = await f.sql<{ answer_lines: string }[]>`
        ${publicPdfSealBoundaries(f.sql, f.scope.workspaceId, { sourceIds: [pdf.sourceId], sourceVersion: 1 })}
        SELECT answer_lines FROM pdf_archive_inline_starts WHERE inline_opener`;
      expect(row?.answer_lines).toBe(expectedNormalized);
    }
  });

  it("stores a long display formula intact after a punctuated currency amount", async () => {
    const prefix = "a".repeat(5998) + "$2.50.";
    const formula = "$$" + "x".repeat(6400) + "$$";
    const pdf = await seed(prefix + formula);
    const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
    const results = await pdf.repository.search(f.scope, query);
    const texts = results.sort((a, b) => a.segmentIndex - b.segmentIndex).map(({ chunk }) => chunk.text);
    expect(texts.slice(0, -1).join("")).toBe(prefix);
    expect(texts.at(-1)).toBe(formula);
  });
});
