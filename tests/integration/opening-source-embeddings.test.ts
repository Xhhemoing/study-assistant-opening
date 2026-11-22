import { createHash, randomUUID } from "node:crypto";
import os from "node:os";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createOpeningBudgetRepository, createOpeningJobRepository, createOpeningPdfSegmentsRepository,
  createOpeningSourceChunksRepository, createOpeningSourceEmbeddingsRepository, createOpeningSourceRepository, openingJobScope,
  readOpeningSourceContent, type PdfSegmentPage } from "@aistudy/database";
import { segmentMaterialChunks } from "@aistudy/ai";
import * as network from "../../packages/ai/src/opening/provider-network";
import { createOpeningMaterialRetriever, retrievalBudgetId } from "../../apps/worker/src/runtime/material-retrieval";
import { createParseSourceHandler } from "../../apps/worker/src/jobs/parse-source";
import { createSourceVisualRecognition } from "../../apps/worker/src/runtime/source-visual-recognition";
import { preserveOpeningKnowledgeDefinitions } from "../../packages/database/src/repositories/opening-knowledge-definitions";
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
  failedStarts: number[] = []) {
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
  const handler = createParseSourceHandler({
    ...recognition, sources, chunks, tempDir: os.tmpdir(),
    segments: createOpeningPdfSegmentsRepository(f.sql),
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
  await f.sql`INSERT INTO opening_source_versions(source_id,version,workspace_id,bytes,sha256,availability)
    SELECT id,version,workspace_id,bytes,sha256,'available' FROM opening_sources WHERE id=${pdf.sourceId} ON CONFLICT DO NOTHING`;
  await f.sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${f.scope.workspaceId},'PDF evidence',${courseId})`;
  await f.sql`INSERT INTO course_asset_memberships(id,workspace_id,course_id,asset_type,asset_id,role,sort_order,visibility)
    VALUES(${randomUUID()},${f.scope.workspaceId},${courseId},'source',${pdf.sourceId},'core',0,'course')`;
  await f.sql`INSERT INTO opening_course_knowledge(workspace_id,owner_user_id,course_id,version,snapshot,source_versions)
    VALUES(${f.scope.workspaceId},${f.scope.ownerUserId},${courseId},1,${f.sql.json({ courseId, version: 1, nodes, edges: [] })},
      ${f.sql.json({ [pdf.sourceId]: 1 })})`;
  await f.sql.begin(tx => preserveOpeningKnowledgeDefinitions(tx, f.scope, pdf.sourceId, 1));
  const [graph] = await f.sql`SELECT node_definitions FROM opening_course_knowledge WHERE course_id=${courseId}`;
  return nodes.flatMap(({ id }, index) => graph?.node_definitions?.[id] ? [index + 1] : []);
}

async function expectArchivedPdfPages(texts: string[], pages: number[], blockedPage: number) {
  const pdf = await seed(texts);
  await f.sql`UPDATE opening_sources SET mime='application/pdf' WHERE id=${pdf.sourceId}`;
  const chunks = createOpeningSourceChunksRepository(f.sql);
  const query = { ...model, sourceIds: [pdf.sourceId], vector: [1, 0, 0] };
  const publicChunks = pdf.snapshot.chunks.filter(chunk => pages.includes(chunk.page!));
  const blockedChunk = pdf.snapshot.chunks[blockedPage - 1]!;
  expect(await chunks.listForSources(f.scope, [pdf.sourceId])).toEqual(publicChunks);
  expect(await chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1, [blockedPage, ...pages])).toEqual(publicChunks);
  await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: blockedPage }))
    .rejects.toMatchObject({ code: "NOT_FOUND" });
  for (const page of pages) {
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
}

describe("pgvector material repository", () => {
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

  it("seals the continuation after a bracketed qualified heading with same-line content", async () => {
    await expectArchivedPdfPages(["【参考答案】x = 3.", "5 units.", "Chapter 2: Rings"], [3], 2);
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
        expect((await retry.chunks.listChunksAtVersion(f.scope, pdf.sourceId, 1)).map(chunk => chunk.text)).toEqual(expected);
        await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: markerPage }))
          .rejects.toMatchObject({ code: "NOT_FOUND" });
        await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 3 }))
          .rejects.toMatchObject({ code: "NOT_FOUND" });
        if (!confirmed) await expect(readOpeningSourceContent(f.sql, f.scope, pdf.sourceId, { page: 1 }))
          .resolves.toMatchObject({ text: publicText, pages: [1] });
      }
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
    expect((await chunks.listForSources(f.scope, [pdf.sourceId])).map(chunk => chunk.text)).toEqual(archived);
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

  it("honors an archived Vision seal after a failed page despite a fresh native recovery heading", async () => {
    const texts = ["Unavailable.", "Chapter 2: Rings", "5 units.", "Chapter 3: Fields"];
    const pdf = await seed([texts[0]!, "[视觉转写与描述]\nAnswer Key", ...texts.slice(2)]);
    await f.sql`DELETE FROM opening_source_chunks WHERE source_id=${pdf.sourceId} AND page=1`;
    await f.sql`UPDATE opening_source_chunks SET image_object_key='vision/key' WHERE source_id=${pdf.sourceId} AND page=2`;
    const pages: PdfSegmentPage[] = texts.map((text, index) => ({
      page: index + 1, text, imagePath: null, visualKinds: [],
    }));
    const retry = await startPdfRetry(pdf.sourceId, pages, {}, [1]);
    await expect(retry.run()).resolves.toEqual({ pages: 3 });
    await retry.finish(3);
    expect(await retry.sources.get(f.scope, pdf.sourceId)).toMatchObject({ error: { code: "PARSE_PARTIAL" } });
    const [marker] = await f.sql`SELECT pages FROM opening_pdf_parse_segments
      WHERE source_id=${pdf.sourceId} AND parser_profile='pdf-publication-page-seal-v1' AND page_start=2`;
    expect(marker?.pages).toMatchObject([{ sectionSealedAtEnd: true, publicationSealCommitted: true, visualKinds: [] }]);
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
});
