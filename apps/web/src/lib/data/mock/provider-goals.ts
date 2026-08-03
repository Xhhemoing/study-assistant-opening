import { studyGoalInputSchema, type StudyGoal, type StudyGoalInput } from "@aistudy/contracts";
import { newId, readDomain, writeDomain, type MockProviderState } from "./provider-state";

export function listGoals(state: MockProviderState): StudyGoal[] {
  return readDomain<StudyGoal[]>(state, "goals", []).filter((goal) => goal.archivedAt === null);
}

export function findGoal(state: MockProviderState, id: string): StudyGoal | null {
  return readDomain<StudyGoal[]>(state, "goals", []).find((goal) => goal.id === id) ?? null;
}

export function createGoal(state: MockProviderState, input: StudyGoalInput): StudyGoal {
  const parsed = studyGoalInputSchema.parse(input);
  const now = state.now().toISOString();
  const goal: StudyGoal = {
    id: newId(),
    ownerUserId: state.userId,
    ...parsed,
    archivedAt: null,
    strategyVersion: "goal-1",
    createdAt: now,
    updatedAt: now,
  };
  writeDomain(state, "goals", [...readDomain<StudyGoal[]>(state, "goals", []), goal]);
  return goal;
}

export function updateGoal(state: MockProviderState, id: string, input: Partial<StudyGoalInput>): StudyGoal {
  const goals = readDomain<StudyGoal[]>(state, "goals", []);
  const current = goals.find((goal) => goal.id === id);
  if (!current) throw new Error("目标不存在");
  const next = studyGoalInputSchema.parse({ ...current, ...input });
  const goal: StudyGoal = { ...current, ...next, updatedAt: state.now().toISOString() };
  writeDomain(state, "goals", goals.map((item) => (item.id === id ? goal : item)));
  return goal;
}

export function archiveGoal(state: MockProviderState, id: string): StudyGoal {
  const goals = readDomain<StudyGoal[]>(state, "goals", []);
  const current = goals.find((goal) => goal.id === id);
  if (!current) throw new Error("目标不存在");
  const now = state.now().toISOString();
  const goal = { ...current, archivedAt: now, updatedAt: now };
  writeDomain(state, "goals", goals.map((item) => (item.id === id ? goal : item)));
  return goal;
}
