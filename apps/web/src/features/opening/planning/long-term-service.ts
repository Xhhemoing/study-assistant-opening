import { calendarDateSchema, learningManagementCommandSchema, learningRecoveryCommandSchema, learningLifecycleCommandSchema, learningCardSessionCommandSchema, uuidSchema, type Scope } from "@aistudy/contracts";
import type { createOpeningLongTermPlanningRepository, readLearningCardSessions, writeLearningCardSession } from "@aistudy/database";

type Repository = ReturnType<typeof createOpeningLongTermPlanningRepository>;
export function createLongTermPlanningService(repository: Repository, cards?: {
  read: (scope: Scope, id?: string) => ReturnType<typeof readLearningCardSessions>;
  write: (scope: Scope, raw: unknown) => ReturnType<typeof writeLearningCardSession>;
}) {
  return {
    read: (scope: Scope, date?: string | null) => repository.read(scope, date ? calendarDateSchema.parse(date) : undefined),
    async command(scope: Scope, raw: unknown) { return repository.command(scope, learningManagementCommandSchema.parse(raw)); },
    recover: (scope: Scope, raw: unknown) => repository.recover(scope, learningRecoveryCommandSchema.parse(raw)),
    lifecycle: (scope: Scope, raw: unknown) => repository.lifecycle(scope, learningLifecycleCommandSchema.parse(raw)),
    readCards: (scope: Scope, id?: string | null) => {
      if (!cards) throw new Error("Card session repository unavailable");
      return cards.read(scope, id ? uuidSchema.parse(id) : undefined);
    },
    writeCards: (scope: Scope, raw: unknown) => {
      if (!cards) throw new Error("Card session repository unavailable");
      return cards.write(scope, learningCardSessionCommandSchema.parse(raw));
    },
  };
}
