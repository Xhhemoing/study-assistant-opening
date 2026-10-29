import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { createOpeningProvider, runBudgetedCall, actualCentsForOutput, type OpeningProviderOptions } from "@aistudy/ai";
import { fetchOpeningProvider } from "../../packages/ai/src/opening/provider-network";
import { parseModelJson } from "../../packages/ai/src/opening/latex-json";
import { assertOpeningTestDatabase } from "@aistudy/config";
import { createSqlClient, createOpeningConversationRepository, createOpeningTutorJobsRepository, createOpeningSourceChunksRepository, createOpeningBudgetRepository } from "@aistudy/database";
import type { ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { createOpeningPrivacyRepository, createOpeningAdaptivePrefsRepository, createWorkspacePreferencesRepository,
  createOpeningSpanSessionRepository, createOpeningLearningAttemptRepository, createOpeningLearningRepository,
  createOpeningRetestActivityRepository, readOpeningSystemQueryAuthorization } from "../../packages/database/src/index";
import { DEFAULT_STUDY_SESSION_INTENT, SPAN_SKILL_LABEL, SPAN_REQUIREMENT_KEY } from "@aistudy/domain";
import { createDbSystemQueryService } from "../../apps/worker/src/runtime/system-query";
import { createSpanTutorNextAction } from "../../apps/worker/src/runtime/span-tutor-next-action";
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
export const RUNTIME_SAFETY_CASES = ["deterministic", "native", "unknown", "partial", "query_cancel", "permission_revision", "privacy_epoch", "grant_revision", "grant_closed", "next_success", "next_cancel", "retest_cancel", "retest_snooze", "provider_unknown"] as const;


/** Real Worker/repository slice. Only model transport and post-read race barriers are controlled. */
export async function collectTutorRuntimeSafety(options: {
  git: string; model: string; baseUrl: string; apiKey: string; maxRequests: number;
  fetchImpl?: OpeningProviderOptions["fetchImpl"]; checkpoint?: (report: DialogueReport) => Promise<void>;
}): Promise<DialogueReport> {
  const url = assertDialogueDatabase(options.fetchImpl);
  if (!Number.isInteger(options.maxRequests) || options.maxRequests < 1 || options.maxRequests > 12) throw new Error("maxRequests must be 1..12");
  if (process.env.OPENING_SYSTEM_QUERY !== "1") throw new Error("Set OPENING_SYSTEM_QUERY=1 for the isolated runtime slice");
  const report: DialogueReport = {
    synthetic: true, transport: options.fetchImpl ? "controlled_fetch" : "real_provider",
    version: { git: options.git, fixture: "m1-d1-r-1", model: options.model }, maxRequests: options.maxRequests,
    requests: [], cases: [], errors: [], passed: false, fixturePricing: { ...pricing, note: "Synthetic ledger pricing; not vendor settlement" },
    unknown: { queue: "not_run; real handler invoked directly", stream: "not_run; query/next-action return before teaching stream",
      http: "not_run; repository history read-back", browser: "not_run", learningEffect: "unknown", semanticLeakage: "unknown",
      modelGateway: "not_run; real provider via fixture budget adapter", dependencies: "PostgreSQL + real handler/jobs/conversations/systemQuery/nextAction/privacy/budget; no Redis" },
  };
  const checkpoint = async () => options.checkpoint?.(report);
  const sql = createSqlClient(url.toString());
  try {
    const conversations = createOpeningConversationRepository(sql), jobs = createOpeningTutorJobsRepository(sql);
    const chunks = createOpeningSourceChunksRepository(sql), privacy = createOpeningPrivacyRepository(sql);
    const budget = createOpeningBudgetRepository(sql, { envCapCents: 100_000 });
    for (const caseId of RUNTIME_SAFETY_CASES) {
      const scope = { workspaceId: randomUUID(), ownerUserId: randomUUID() };
      const courseId = randomUUID(), sourceId = randomUUID();
      const record: Record<string, unknown> = { caseId, scope, courseId, sourceId, status: "running", dependencies: ["createTutorTurnHandler", "PostgreSQL", "createDbSystemQueryService", "createSpanTutorNextAction", "privacy", "budget"] };
      report.cases.push(record); await checkpoint();
      const ledger = async () => Array.from(await sql`SELECT * FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId} ORDER BY id`);
      const state = async () => {
        const [counts] = await sql`SELECT
          (SELECT count(*)::int FROM opening_turns WHERE workspace_id=${scope.workspaceId} AND role='assistant' AND system_query IS NOT NULL) AS system_query,
          (SELECT count(*)::int FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId}) AS help,
          (SELECT count(*)::int FROM opening_learning_sessions WHERE workspace_id=${scope.workspaceId}) AS sessions,
          (SELECT count(*)::int FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId}) AS activities,
          (SELECT count(*)::int FROM opening_learning_attempts WHERE workspace_id=${scope.workspaceId}) AS attempts,
          (SELECT count(*)::int FROM opening_budget_reservations WHERE workspace_id=${scope.workspaceId}) AS budget,
          (SELECT count(*)::int FROM opening_teaching_activities WHERE workspace_id=${scope.workspaceId} AND goal_json ? 'tutorBudget') AS activity_budget`;
        return { counts, ledger: await ledger(), help: Array.from(await sql`SELECT * FROM opening_help_exposures WHERE workspace_id=${scope.workspaceId} ORDER BY id`),
          retests: Array.from(await sql`SELECT * FROM opening_retest_activities WHERE workspace_id=${scope.workspaceId} ORDER BY id`) };
      };
      const check = (condition: unknown, label: string) => { if (!condition) throw new Error(`RUNTIME_CHECK_FAILED:${caseId}:${label}`); };
      try {
        await sql`INSERT INTO users(id,email,display_name,password_hash) VALUES(${scope.ownerUserId},${`${scope.ownerUserId}@example.invalid`},'Synthetic runtime','disabled-test-identity')`;
        await sql`INSERT INTO workspaces(id,owner_user_id) VALUES(${scope.workspaceId},${scope.ownerUserId})`;
        await sql`INSERT INTO courses(id,workspace_id,title,slug) VALUES(${courseId},${scope.workspaceId},'Synthetic span',${courseId})`;
        await sql`INSERT INTO opening_sources(id,workspace_id,name,mime,bytes,sha256,version,upload_state,parse_state)
          VALUES(${sourceId},${scope.workspaceId},'synthetic-span.txt','text/plain',1,${"0".repeat(64)},1,'uploaded','ready')`;
        await chunks.replaceChunks(scope, { sourceId, sourceVersion: 1, chunks: [{ page: 1, slideLabel: null, startMs: null, endMs: null,
          text: 'Synthetic span material. PROTECTED_SOLUTION_MARKER', imageObjectKey: null }] });
        await sql`INSERT INTO course_asset_memberships(workspace_id,course_id,asset_type,asset_id,role,visibility) VALUES(${scope.workspaceId},${courseId},'source',${sourceId},'core','course')`;
        await createWorkspacePreferencesRepository(sql).setLearningPreferences(scope, { assessmentEnabled: true, retestSuggestionsEnabled: true, automaticRemindersEnabled: false });
        const prefs = createOpeningAdaptivePrefsRepository(sql);
        await prefs.patch(scope, { spanTutorGrant: { courseId, enabled: true, dailyMinutes: 180, expiresOn: null, expectedRevision: 0 } });
        const sessions = createOpeningSpanSessionRepository(sql);
        const origin = await sessions.create(scope, { courseId, sourceIds: [sourceId], intent: DEFAULT_STUDY_SESSION_INTENT, clientKey: randomUUID() });
        record.origin = origin;
        const learning = createOpeningLearningRepository(sql), attempts = createOpeningLearningAttemptRepository(sql);
        for (let index = 0; index < (caseId === "partial" ? 6 : 1); index++) {
          const attempt = await attempts.create(scope, { sessionId: origin.sessionId, clientKey: randomUUID(),
            spanExercise: { sourceId, problemId: "span-reserved-fraction", version: 1 } });
          await learning.insertObservation(scope, { sessionId: origin.sessionId, courseId, skillLabel: SPAN_SKILL_LABEL, sourceIds: [sourceId],
            attemptId: attempt.id, problemId: attempt.problemId, clientKey: randomUUID(), answer: JSON.stringify({ membership: "not_in_span" }),
            outcome: "unverified", assistance: "independent", verdictSource: "self_report" });
        }
        await sessions.save(scope, origin.activityId, { expectedRevision: origin.revision, intent: origin.intent, moveId: origin.moveId, status: "completed" });
        const retests = createOpeningRetestActivityRepository(sql);
        let retestId: string | undefined;
        if (caseId === "retest_cancel" || caseId === "retest_snooze") {
          const due = new Date(Date.now() - 60_000).toISOString(), taskId = randomUUID();
          await sql`INSERT INTO opening_tasks(id,workspace_id,owner_user_id,course_id,title,minutes,origin)
            VALUES(${taskId},${scope.workspaceId},${scope.ownerUserId},${courseId},'Synthetic due retest',20,'retest')`;
          const proposed = await retests.createProposed(scope, { cycleId: randomUUID(), taskId, courseId, skillLabel: SPAN_SKILL_LABEL, requirementKey: SPAN_REQUIREMENT_KEY,
            proposedAt: due, notBeforeAt: due, recommendedAt: due });
          retestId = proposed.activityId;
          await retests.transition(scope, retestId, { type: "accept", at: due });
        }
        const conversation = await conversations.create(scope, { title: `Synthetic runtime ${caseId}`, courseId });
        const isNext = ["grant_revision", "grant_closed", "next_success", "next_cancel", "retest_cancel", "retest_snooze"].includes(caseId);
        const input = { scope, conversationId: conversation.id, text: isNext ? "继续学习" : caseId === "unknown" ? "我有哪些任务？" : "我的作答核验了吗",
          mode: "listen" as const, purpose: isNext ? "teach" as const : caseId === "provider_unknown" ? "answer" as const : "query" as const, querySystem: !isNext && caseId !== "provider_unknown",
          clientKey: randomUUID(), sourceIds: [sourceId], learningSessionId: null, currentPage: null, chunkId: null };
        const saved = await conversations.appendSavedTurn(input); record.saved = saved; record.input = input;
        const before = await state(); record.before = before;
        const native = caseId === "native";
        const adapter = createOpeningProvider({ baseUrl: options.baseUrl, apiKey: options.apiKey, model: options.model, timeoutMs: 90_000,
          fetchImpl: async (target, init) => {
            if (report.requests.length >= options.maxRequests) throw new Error("MAX_REQUESTS_REACHED");
            const request: DialogueRequest = { ordinal: report.requests.length + 1, caseId, actor: "tutor", input: currentInput!, status: null, raw: null,
              requestBody: JSON.parse(String(init?.body)) as unknown };
            report.requests.push(request); await checkpoint();
            try {
              const response = await (options.fetchImpl ?? ((value, params) => fetchOpeningProvider(String(value), params ?? {})))(target, init);
              request.status = response.status; request.raw = await response.text(); await checkpoint();
              return new Response(request.raw, { status: response.status, headers: { "content-type": "application/json" } });
            } catch (error) { request.error = errorName(error); await checkpoint(); throw error; }
          } });
        let currentInput: ProviderInput | undefined;
        const provider = { complete: async (value: ProviderInput, signal?: AbortSignal) => {
          currentInput = value;
          const output = await adapter.complete(value, signal);
          report.requests.at(-1)!.output = output; await checkpoint(); return output;
        } };
        const scopedBudget = { reserve: (value: Parameters<typeof budget.reserve>[1]) => budget.reserve(scope, value),
          release: (...args: Parameters<typeof budget.release> extends [unknown, ...infer T] ? T : never) => budget.release(scope, ...args),
          claimExecution: (id: string) => budget.claimExecution(scope, id), settle: (id: string, cents: number) => budget.settle(scope, id, cents),
          markUnknown: (id: string) => budget.markUnknown(scope, id) };
        const query = createDbSystemQueryService(sql, "worker", { callModel: async (_scope, value, context) => {
          record.queryModelAdapterCalls = Number(record.queryModelAdapterCalls ?? 0) + 1;
          if (caseId === "permission_revision") {
            record.authorizationBefore = await readOpeningSystemQueryAuthorization(sql, scope);
            await sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
            record.authorizationAfter = await readOpeningSystemQueryAuthorization(sql, scope);
            await context.beforeSend?.();
          }
          if (!native) throw new Error("FIXTURE_MODEL_UNAVAILABLE; deterministic reads required");
          return runBudgetedCall({ provider, input: value, budget: scopedBudget, requestId: context.operationId, operationId: context.operationId,
            parentBudget: context.parentBudget, beforeSend: context.beforeSend, signal: context.signal, reservedCents: 100,
            actualCents: output => actualCentsForOutput(output, pricing) });
        } });
        const next = createSpanTutorNextAction(sql);
        const handler = createTutorTurnHandler({ tutorJobs: jobs, chunks, budget, privacy,
          provider: caseId === "provider_unknown" ? { complete: async () => { record.sentAttempts = Number(record.sentAttempts ?? 0) + 1; throw new Error("CONTROLLED_SENT_RESPONSE_LOST"); } } : provider,
          systemQuery: { ...query, async reply(...args) {
            const reply = await query.reply(...args); record.readReceipt = reply.receipt;
            if (caseId === "query_cancel") await jobs.cancel(scope, saved.jobId);
            if (caseId === "privacy_epoch") await sql`UPDATE workspaces SET privacy_epoch=privacy_epoch+1 WHERE id=${scope.workspaceId}`;
            return reply;
          } },
          nextAction: { ...next, async read(...args) {
            const context = await next.read(...args); record.readContext = context;
            check(context, "real_next_context");
            if (caseId === "grant_revision" || caseId === "grant_closed") await prefs.patch(scope, { spanTutorGrant: {
              courseId, enabled: caseId !== "grant_closed", dailyMinutes: 180, expiresOn: null, expectedRevision: 1 } });
            if (caseId === "next_cancel") await jobs.cancel(scope, saved.jobId);
            if (retestId) {
              check(context?.spanContext?.dueRetestId === retestId, "real_due_retest");
              await retests.transition(scope, retestId, caseId === "retest_cancel" ? { type: "cancel", at: new Date().toISOString() }
                : { type: "snooze", until: new Date(Date.now() + 86_400_000).toISOString() });
            }
            return context;
          } }, config: { maxContextCharacters: 12000, reservedCents: 100, maxOutputTokens: 1200, ...pricing } });

        let rejected = false;
        try { record.handler = await handler(saved.jobId); } catch (error) { rejected = true; record.handlerError = errorName(error); record.handlerMessage = error instanceof Error ? error.message : "unknown"; }
        record.job = await jobs.get(scope, saved.jobId);
        const history = await conversations.listTurns(scope, conversation.id), assistant = history.find(turn => turn.id === saved.assistantTurnId);
        record.assistant = assistant; record.after = await state();
        const after = await state(), requestsBefore = report.requests.length;
        const replaySaved = await conversations.appendSavedTurn(input);
        record.replay = await handler(saved.jobId);
        const replayState = await state(); record.replayState = replayState;
        check(isDeepStrictEqual(saved, replaySaved) && isDeepStrictEqual(after, replayState) && requestsBefore === report.requests.length, "same_key_replay_no_spend_or_writes");
        check(isDeepStrictEqual(before.help, after.help), "old_help_unchanged");
        const { system_query: _beforeQuery, budget: _beforeBudget, ...beforeCounts } = before.counts!;
        const { system_query: _afterQuery, budget: _afterBudget, ...afterCounts } = after.counts!;
        if (caseId === "next_success") {
          check(!rejected && assistant?.status === "complete" && assistant.text.includes("study/span"), "real_next_action_delivered");
          check(after.counts!.sessions === before.counts!.sessions + 1 && after.counts!.activities === before.counts!.activities + 1
            && after.counts!.activity_budget === before.counts!.activity_budget + 1, "real_successor_and_budget_created");
        } else check(isDeepStrictEqual(beforeCounts, afterCounts), "no_successor_or_help_or_activity_budget");
        if (caseId === "next_success") {
          check(isDeepStrictEqual(before.ledger, after.ledger), "no_model_charge_for_next");
        } else if (["deterministic", "native", "unknown", "partial"].includes(caseId)) {
          check(!rejected && assistant?.status === "complete" && assistant.systemQuery, "durable_receipt");
          check(isDeepStrictEqual(assistant!.systemQuery, record.readReceipt), "history_receipt_roundtrip");
          const receipt = assistant!.systemQuery!;
          if (native) check(receipt.mode === "native_tools" && receipt.results.some(row => row.name === "learning" && row.data.length), "real_native_learning_read");
          else check(receipt.mode === "deterministic", "deterministic_mode");
          if (caseId === "unknown") check(receipt.status === "unknown", "unknown_honesty");
          if (caseId === "partial") check(receipt.status === "partial" && receipt.results.some(row => row.nextOffset !== null), "partial_pagination");
          if (caseId === "deterministic") check(receipt.results.some(row => row.name === "learning" && row.data.length), "real_learning_record");
          check(!JSON.stringify(receipt).includes("PROTECTED_SOLUTION_MARKER"), "protected_body_withheld");
        } else {
          check((rejected || caseId === "query_cancel") && assistant?.status !== "complete" && !assistant?.systemQuery, "stale_answer_not_published");
          check(after.counts!.system_query === 0, "no_stale_receipt");
          const expectedFailure = {
            permission_revision: "system query context changed", privacy_epoch: "query receipt grant changed",
            grant_revision: "导师试用授权已变化", grant_closed: "导师试用授权已变化",
            next_cancel: "教学请求已结束或被取消", retest_cancel: "复测已推迟、取消或更新", retest_snooze: "复测已推迟、取消或更新",
            provider_unknown: "CONTROLLED_SENT_RESPONSE_LOST",
          };
          if (caseId !== "query_cancel") check(String(record.handlerMessage).includes(expectedFailure[caseId as keyof typeof expectedFailure]), "expected_safety_barrier");
          else check((await jobs.get(scope, saved.jobId))?.status === "cancelled", "job_cancel_preserved");
          if (caseId === "provider_unknown") {
            check(record.sentAttempts === 1 && after.ledger.length === 1 && after.ledger[0]!.outcome_unknown_at != null, "sent_unknown_not_resent");
          } else check(isDeepStrictEqual(before.ledger, after.ledger), "no_charge");
          if (caseId === "retest_cancel" || caseId === "retest_snooze") {
            check(isDeepStrictEqual(after.retests, replayState.retests), "retest_not_revived");
            check(after.retests[0]?.status === (caseId === "retest_cancel" ? "cancelled" : "accepted"), "retest_status_preserved");
            if (caseId === "retest_snooze") check(new Date(String(after.retests[0]?.snoozed_until)).getTime() > Date.now(), "future_snooze_preserved");
          }
        }
        record.status = "passed";
      } catch (error) { record.status = "failed"; record.error = errorName(error); report.errors.push(`${caseId}:${errorName(error)}`); }
      finally {
        record.final = await state();
        await sql`UPDATE users SET disabled_at=now() WHERE id=${scope.ownerUserId}`;
        await checkpoint();
      }
    }
    report.passed = report.errors.length === 0 && report.cases.length === RUNTIME_SAFETY_CASES.length;
    await checkpoint(); return report;
  } finally { await sql.end({ timeout: 5 }); }
}

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
