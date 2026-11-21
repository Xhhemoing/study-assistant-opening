import type { HelpState, MinEntropyBudget, MinEntropyReleaseCheck } from "./min-entropy-budget";

type BudgetControl = {
  sealPure(): void;
  isPureBound(): boolean;
  canRelease(bits: number, nowMs: number): MinEntropyReleaseCheck;
  commitRelease(bits: number, nowMs: number): {
    state: HelpState;
    leakageBits: number;
    cooldownUntilMs: number | undefined;
  };
  runPure<T>(run: (wasTouched: () => boolean) => T): T;
};

const controls = new WeakMap<MinEntropyBudget, BudgetControl>();

export function registerBudgetControl(budget: MinEntropyBudget, control: BudgetControl): void {
  controls.set(budget, control);
}

export function getBudgetControl(budget: MinEntropyBudget): BudgetControl {
  const control = controls.get(budget);
  if (!control) throw new Error("unrecognized_entropy_budget");
  return control;
}
