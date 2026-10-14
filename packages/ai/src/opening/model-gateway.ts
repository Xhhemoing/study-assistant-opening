import type { OpeningModelSnapshot, ProviderInput, ProviderOutput } from "@aistudy/contracts";
import { runBudgetedCall, type BudgetedProvider, type BudgetedRepository } from "./budgeted-call";
import { modelTaskSpec, type ModelTaskKey } from "./model-tasks";
import { actualCentsForOutput, reservationCentsForInput } from "./usage";

export type GatewayScope = { workspaceId: string; ownerUserId: string };

/** One selection supplies the provider, the ledger snapshot and the prices. */
export type ResolvedTaskModel = {
  provider: BudgetedProvider;
  modelSnapshot: OpeningModelSnapshot;
  inputCentsPerMillion: number;
  outputCentsPerMillion: number;
  supportsVision?: boolean;
};

export type ModelGatewayCallOptions = {
  budget: BudgetedRepository;
  input: ProviderInput;
  /** Durable ledger key: retries of one logical operation reuse one reservation. */
  operationId: string;
  resultRef?: string;
  /** Reservation floor, e.g. a configured per-call minimum. */
  minReservedCents?: number;
  signal?: AbortSignal;
  beforeSend?: () => Promise<void>;
};

export type ModelGateway = ReturnType<typeof createModelGateway>;

/**
 * Single entry point for model calls: task → configured model → budgeted call.
 * Routing failures surface as OpeningModelRoutingError before any reservation.
 */
export function createModelGateway(deps: {
  resolve(scope: GatewayScope, task: ModelTaskKey): Promise<ResolvedTaskModel>;
}) {
  async function call(scope: GatewayScope, task: ModelTaskKey, options: ModelGatewayCallOptions): Promise<ProviderOutput> {
    const model = await deps.resolve(scope, task);
    const rates = { inputCentsPerMillion: model.inputCentsPerMillion, outputCentsPerMillion: model.outputCentsPerMillion };
    const estimated = reservationCentsForInput(JSON.stringify(options.input), options.input.maxOutputTokens, rates);
    return runBudgetedCall({
      provider: model.provider,
      modelSnapshot: model.modelSnapshot,
      budget: options.budget,
      input: options.input,
      requestId: options.operationId,
      operationId: options.operationId,
      purpose: modelTaskSpec(task).purpose,
      ...(options.resultRef ? { resultRef: options.resultRef } : {}),
      reservedCents: Math.max(options.minReservedCents ?? 1, estimated),
      actualCents: (output) => actualCentsForOutput(output, rates),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.beforeSend ? { beforeSend: options.beforeSend } : {}),
    });
  }
  return {
    resolve: deps.resolve,
    call,
    /** Adapter for handlers that take a `{ complete(input) }` provider. */
    budgetedProvider(
      scope: GatewayScope,
      task: ModelTaskKey,
      options: Omit<ModelGatewayCallOptions, "input" | "signal">,
    ): BudgetedProvider {
      return {
        complete: (input, signal) => call(scope, task, { ...options, input, ...(signal ? { signal } : {}) }),
      };
    },
  };
}
