import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createOpeningProvider, runBudgetedCall, actualCentsForOutput, type OpeningProviderOptions } from "@aistudy/ai";
import { fetchOpeningProvider } from "../../packages/ai/src/opening/provider-network";
import { parseModelJson } from "../../packages/ai/src/opening/latex-json";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createSqlClient, createOpeningConversationRepository, createOpeningTutorJobsRepository, createOpeningSourceChunksRepository, createOpeningBudgetRepository } from "@aistudy/database";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { createTutorTurnHandler } from "../../apps/worker/src/jobs/tutor-turn";
import { evaluateDialogueOutput, type DialogueCase } from "../../packages/domain/src/opening/tutor-dialogue-evaluation";

export type DialogueRequest = {
  ordinal: number; caseId: string; actor: "tutor" | "synthetic_student"; input: ProviderInput;
  status: number | null; raw: string | null; requestBody?: unknown; output?: ProviderOutput; error?: string;
};
export type DialogueReport = {
  synthetic: true; transport: "real_provider" | "controlled_fetch"; version: { git: string; fixture: string; model: string };
  maxRequests: number; requests: DialogueRequest[]; cases: Array<Record<string, unknown>>; errors: string[];
  unknown: Record<string, string>; fixturePricing: Record<string, unknown>; passed: boolean;
};
export function assertDialogueDatabase(fetchImpl?: OpeningProviderOptions["fetchImpl"]): URL {
  if (process.env.NODE_ENV === "production") throw new Error("Dialogue collection is non-production only");
  const url = assertOpeningTestDatabase(process.env.OPENING_TEST_DATABASE_URL ?? "", process.env.OPENING_TEST_DB);
  if (!fetchImpl && (!url.port || url.port === "5432")) throw new Error("An explicit isolated non-default database port is required");
  return url;
}
const pricing = { inputCentsPerMillion: 100, outputCentsPerMillion: 200 };
const errorName = (error: unknown) => error instanceof Error ? `${error.name}:${"code" in error ? String(error.code) : error.message}` : "unknown_error";
function rawContent(request: DialogueRequest | undefined): string | undefined {
  if (!request?.raw) return undefined;
  try { return (JSON.parse(request.raw) as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content; }
  catch { return undefined; }
}
function parsedRawContent(request: DialogueRequest | undefined): unknown {
  const content = rawContent(request);
  if (typeof content !== "string") return undefined;
  try { return parseModelJson(content); } catch {
    // The provider also accepts a JSON object surrounded by fences or prose.
    const start = content.indexOf("{"), end = content.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try { return parseModelJson(content.slice(start, end + 1)); } catch { return undefined; }
    }
    return undefined;
  }
}
export async function collectTutorDialogue(options: {
  cases: DialogueCase[]; fixtureVersion: string; git: string; model: string; baseUrl: string; apiKey: string; maxRequests: number;
  fetchImpl?: OpeningProviderOptions["fetchImpl"]; checkpoint?: (report: DialogueReport) => Promise<void>;
}): Promise<DialogueReport> {
  const url = assertDialogueDatabase(options.fetchImpl);
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 12) throw new Error("maxRequests must be 1..12");
  const report: DialogueReport = {
    synthetic: true, transport: options.fetchImpl ? "controlled_fetch" : "real_provider",
    version: { git: options.git, fixture: options.fixtureVersion, model: options.model }, maxRequests: options.maxRequests,
    requests: [], cases: [], errors: [], passed: false,
    fixturePricing: { ...pricing, reservedCents: 100, note: "Isolated fixture ledger only; configured test prices are not actual vendor settlement" },
    unknown: { semanticLeakage: "unknown; separate Claude review required", teachingQuality: "unknown", learningEffect: "unknown",
      queue: "not_run", http: "not_run; delivery exercised via real repository listTurns", browser: "not_run",
      toolsAuthorizationCancellation: "unknown; original D1 successor still required. Existing coverage: tests/integration/opening-system-query-chat.test.ts, opening-study-context-exposure.test.ts; not executed by this collector" },
  };
  const sql = createSqlClient(url.toString());
  const checkpoint = async () => { await options.checkpoint?.(report); };
  try {
    const conversations = createOpeningConversationRepository(sql), jobs = createOpeningTutorJobsRepository(sql);
    const chunks = createOpeningSourceChunksRepository(sql), budget = createOpeningBudgetRepository(sql, { envCapCents: 100_000 });
    for (const item of options.cases) {
      const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
      const record: Record<string, unknown> = { caseId: item.caseId, scope, sessionId: null, turns: [], plannedTutorTurns: item.studentFollowup ? 2 : 1,
        retention: "Synthetic scope retained in isolated DB for read-back; no global reset or real-user scope touched" };
      report.cases.push(record);
      const turns: Array<Record<string, unknown>> = [];
      record.turns = turns;
      let actor: DialogueRequest["actor"] = "tutor";
      let currentRequest: DialogueRequest | undefined;
      const adapter = createOpeningProvider({ baseUrl: options.baseUrl, apiKey: options.apiKey, model: options.model, timeoutMs: 90_000,
        fetchImpl: async (target, init) => {
          if (report.requests.length >= options.maxRequests) throw new Error("MAX_REQUESTS_REACHED");
          const request = currentRequest!;
          request.requestBody = JSON.parse(String(init?.body)) as unknown;
          request.ordinal = report.requests.length + 1;
          report.requests.push(request);
          await checkpoint();
          try {
            const response = await (options.fetchImpl ?? ((value, params) => fetchOpeningProvider(String(value), params ?? {})))(target, init);
            request.status = response.status;
            request.raw = await response.text();
            await checkpoint();
            return new Response(request.raw, { status: response.status, headers: { "content-type": "application/json" } });
          } catch (error) { request.error = errorName(error); await checkpoint(); throw error; }
        },
      });
      const provider = { complete: async (input: ProviderInput): Promise<ProviderOutput> => {
        if (report.requests.length >= options.maxRequests) {
          record.requestLimitReached = true;
          await checkpoint();
          throw new Error("MAX_REQUESTS_REACHED");
        }
        currentRequest = { ordinal: 0, caseId: item.caseId, actor, input, status: null, raw: null };
        try { const output = await adapter.complete(input); currentRequest.output = output; await checkpoint(); return output; }
        catch (error) { currentRequest.error = errorName(error); await checkpoint(); throw error; }
      } };
      const exposureRows = (turnId: string) => sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} AND turn_id=${turnId}`;
      const ledgerRows = () => sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`;
      try {
        await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${scope.ownerUserId},${`${scope.ownerUserId}@example.invalid`},'Synthetic dialogue','disabled-test-identity')`;
        await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${scope.workspaceId},${scope.ownerUserId})`;
        const sourceId = randomUUID();
        await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
          VALUES(${sourceId},${scope.workspaceId},'synthetic-dialogue.txt','text/plain',1,${"0".repeat(64)},0,'uploaded','ready')`;
        await chunks.replaceChunks(scope, { sourceId, sourceVersion: 0, chunks: [{ page: 1, slideLabel: null,
          startMs: null, endMs: null, text: item.sourceText, imageObjectKey: null }] });
        const chunkId = (await chunks.listChunks(scope, sourceId))[0]!.id;
        record.sourceId = sourceId; record.chunkId = chunkId;
        let sessionId: string | null = null;
        if (item.withSession) {
          const courseId = randomUUID(), activityId = randomUUID(); sessionId = randomUUID();
          await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Synthetic dialogue',${courseId})`;
          await sql`INSERT INTO opening_teaching_activities(id,workspace_id,owner_user_id,course_id,status,intent_kind,intent_summary,client_key,create_intent)
            VALUES(${activityId},${scope.workspaceId},${scope.ownerUserId},${courseId},'active','course_continue','Synthetic dialogue',${activityId},'{}'::jsonb)`;
          await sql`INSERT INTO opening_learning_sessions(id,workspace_id,owner_user_id,course_id,activity_id,skill_label,source_ids)
            VALUES(${sessionId},${scope.workspaceId},${scope.ownerUserId},${courseId},${activityId},'synthetic-equation',${[sourceId]}::uuid[])`;
          record.sessionId = sessionId;
        }
        const conversation = await conversations.create(scope, { title: `Synthetic ${item.caseId}`, courseId: null });
        record.conversationId = conversation.id;
        const handler = createTutorTurnHandler({ tutorJobs: jobs, chunks, budget, provider,
          config: { maxContextCharacters: 12000, reservedCents: 100, maxOutputTokens: 1200, ...pricing } });
        let question = item.firstUser;
        for (let round = 0; round < (item.studentFollowup ? 2 : 1); round++) {
          actor = "tutor";
          const input = { scope, conversationId: conversation.id, text: question, mode: item.mode, clientKey: randomUUID(),
            sourceIds: [sourceId], learningSessionId: sessionId, currentPage: null, chunkId };
          const saved = await conversations.appendSavedTurn(input);
          const turn: Record<string, unknown> = { round: round + 1, saved, question };
          turns.push(turn); await checkpoint();
          try {
            turn.handler = await handler(saved.jobId);
            turn.job = await jobs.get(scope, saved.jobId);
            const generated = await exposureRows(saved.assistantTurnId);
            turn.generatedOnly = sessionId ? Array.from(generated) : "not_applicable";
            const snapshotRows = await sql`SELECT id,role,help_input_snapshot FROM opening_turns WHERE workspace_id=${scope.workspaceId} AND id IN (${saved.turnId},${saved.assistantTurnId}) ORDER BY role`;
            turn.inputSnapshots = Array.from(snapshotRows);
            const expectedSnapshot = { userTurnId: saved.turnId, assistantTurnId: saved.assistantTurnId, tutorMode: item.mode };
            const snapshotsMatch = snapshotRows.length === 2 && snapshotRows.filter(row => row.role === "user").every(row => {
              const snap = row.help_input_snapshot as Record<string, unknown> | null;
              return snap && Object.entries(expectedSnapshot).every(([key, value]) => snap[key] === value);
            });
            const delivered = (await conversations.listTurns(scope, conversation.id)).find(row => row.id === saved.assistantTurnId);
            turn.delivered = delivered ?? null;
            const released = await exposureRows(saved.assistantTurnId);
            turn.released = sessionId ? Array.from(released) : "not_applicable";
            const request = report.requests.at(-1);
            turn.evaluation = evaluateDialogueOutput(item.mode, item.gold, delivered, undefined, parsedRawContent(request));
            const ledgerBefore = await ledgerRows(), requestsBefore = report.requests.length;
            const replaySaved = await conversations.appendSavedTurn(input);
            const replayHandler = await handler(saved.jobId);
            await conversations.listTurns(scope, conversation.id);
            const replayStable = isDeepStrictEqual(saved, replaySaved) && replayHandler.skipped && requestsBefore === report.requests.length
              && isDeepStrictEqual(Array.from(ledgerBefore), Array.from(await ledgerRows())) && isDeepStrictEqual(Array.from(released), Array.from(await exposureRows(saved.assistantTurnId)));
            const exposureMatch = sessionId ? generated.length === 1 && generated[0]!.delivered === false && generated[0]!.released_at === null
              && released.length === 1 && released[0]!.delivered === true && released[0]!.released_at != null
              && released[0]!.level === (item.mode === "explain" ? "revealed" : "hinted")
              && isDeepStrictEqual(released[0]!.help_input_snapshot, snapshotRows.find(row => row.role === "user")!.help_input_snapshot) : generated.length === 0 && released.length === 0;
            const previous = turns[round - 1]?.delivered as { text?: string } | undefined;
            const historyMatch = round === 0 || request?.input.history?.some(row => row.role === "assistant" && row.text === previous?.text) === true;
            turn.checks = { snapshotsMatch, exposureMatch, replayStable, historyMatch };
            if (!snapshotsMatch || !exposureMatch || !replayStable || !historyMatch || !delivered?.text) throw new Error("DURABLE_CHECK_FAILED");
            await checkpoint();
            if (round === 0 && item.studentFollowup) {
              actor = "synthetic_student";
              const studentInput: ProviderInput = { instruction: "你扮演合成学生，只输出一条自己的下一步尝试；只使用所给题目、有限知识和已经交付的导师回答。不评价学习效果。",
                text: JSON.stringify({ problem: item.problem, limitedKnowledge: item.studentKnowledge, deliveredTutor: delivered.text }),
                mode: "hint", chunks: [], maxOutputTokens: 400, mediaCapability: "text_only", imageParts: [] };
              const student = await runBudgetedCall({ provider, input: studentInput,
                budget: { reserve: value => budget.reserve(scope, value), release: (...args) => budget.release(scope, ...args),
                  claimExecution: id => budget.claimExecution(scope, id), settle: (...args) => budget.settle(scope, ...args), markUnknown: id => budget.markUnknown(scope, id) },
                requestId: `synthetic-student:${conversation.id}`, operationId: `synthetic-student:${conversation.id}`, reservedCents: 100,
                actualCents: output => actualCentsForOutput(output, pricing) });
              record.student = student; question = student.text;
            }
          } catch (error) { turn.error = errorName(error); if (!turn.evaluation) turn.evaluation = evaluateDialogueOutput(item.mode, item.gold, null, errorName(error), parsedRawContent(currentRequest)); throw error; }
        }
      } catch (error) {
        record.error = errorName(error); report.errors.push(`${item.caseId}:${errorName(error)}`);
        while (turns.length < Number(record.plannedTutorTurns)) turns.push({ round: turns.length + 1, evaluation: evaluateDialogueOutput(item.mode, item.gold, null), reason: "not_run_after_failure" });
      } finally {
        record.ledger = Array.from(await ledgerRows());
        await sql`UPDATE users SET disabled_at=now() WHERE id=${scope.ownerUserId}`;
        await checkpoint();
      }
    }
    report.passed = report.errors.length === 0 && report.cases.every(item => (item.turns as Array<Record<string, unknown>>).every(turn =>
      (turn.evaluation as ReturnType<typeof evaluateDialogueOutput>)?.status === "no_known_plaintext_found"));
    await checkpoint(); return report;
  } finally { await sql.end({ timeout: 5 }); }
}
