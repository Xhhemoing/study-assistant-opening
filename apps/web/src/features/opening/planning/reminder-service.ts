import { reminderEnqueueInputSchema, reminderListSchema, type Reminder, type ReminderEnqueueInput, type Scope } from "@aistudy/contracts";
import { ApiError } from "../../auth/service";

type ReminderRepo = {
  list(scope: Scope, now?: Date): Promise<{ reminders: Reminder[]; externalDelivery: "disabled" | "configured" }>;
  enqueue(scope: Scope, input: ReminderEnqueueInput, now?: Date): Promise<Array<Reminder & { created?: boolean }>>;
};

export function createOpeningReminderService(repo: ReminderRepo) {
  return {
    async list(scope: Scope) {
      return reminderListSchema.parse(await repo.list(scope));
    },
    async enqueue(scope: Scope, raw: unknown) {
      const input = reminderEnqueueInputSchema.parse(raw);
      try {
        return await repo.enqueue(scope, input);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "VALIDATION" && (input.channel !== "in_app" || "taskId" in input)) {
          throw new ApiError("VALIDATION", error.message, 422);
        }
        throw error;
      }
    },
  };
}
