import type { AIRole, ReviewGrade, StudyGoalInput } from "@aistudy/contracts";
import {
  getPracticeItem,
  getTodayPlan,
  createPracticeItem,
  createReviewCard,
  gradeCard,
  listDueCards,
  listStatuses,
  recordStatusCorrection,
  setTaskStatus,
  submitAttempt,
  toggleTaskLock,
} from "./provider-plan";
import { archiveGoal, createGoal, findGoal, listGoals, updateGoal } from "./provider-goals";
import { getDiagnostics } from "./provider-diagnostics";
import {
  createExploration,
  getDocumentTags,
  getExploration,
  getGuidanceMode,
  indexDocumentLinks,
  listBacklinks,
  listExplorations,
  searchAll,
  sendExplorationMessage,
  setCandidateStatus,
  setDocumentTags,
  setGuidanceMode,
} from "./provider-explore";
import { createProviderState, ensureSeed, pause, resetState, type MockProviderState } from "./provider-state";
import type {
  AttemptInput,
  CandidateStatus,
  GuidanceMode,
  MockProviderOptions,
  StudyDataProvider,
  TaskStatus,
} from "../types";

export function createMockProvider(options: MockProviderOptions): StudyDataProvider {
  const state = createProviderState(options);
  const delayMs = options.delayMs ?? 60;

  async function run<T>(work: (current: MockProviderState) => T | Promise<T>): Promise<T> {
    ensureSeed(state);
    await pause(delayMs);
    return work(state);
  }

  return {
    listGoals: () => run(listGoals),
    getGoal: (id) => run((current) => findGoal(current, id)),
    createGoal: (input: StudyGoalInput) => run((current) => createGoal(current, input)),
    updateGoal: (id, input) => run((current) => updateGoal(current, id, input)),
    archiveGoal: (id) => run((current) => archiveGoal(current, id)),
    getTodayPlan: (date) => run((current) => getTodayPlan(current, date)),
    setTaskStatus: (date, taskId, status: TaskStatus) => run((current) => setTaskStatus(current, date, taskId, status)),
    toggleTaskLock: (date, taskId) => run((current) => toggleTaskLock(current, date, taskId)),
    getPracticeItem: (id) => run((current) => getPracticeItem(current, id)),
    submitAttempt: (input: AttemptInput) => run((current) => submitAttempt(current, input)),
    listStatuses: () => run(listStatuses),
    recordStatusCorrection: (pointId, note, overrideStatus) => run((current) => recordStatusCorrection(current, pointId, note, overrideStatus ?? null)),
    listDueCards: (at) => run((current) => listDueCards(current, at)),
    createReviewCard: (input) => run((current) => createReviewCard(current, input)),
    gradeCard: (cardId, grade: ReviewGrade) => run((current) => gradeCard(current, cardId, grade)),
    createPracticeItem: (input) => run((current) => createPracticeItem(current, input)),
    listExplorations: () => run(listExplorations),
    getExploration: (id) => run((current) => getExploration(current, id)),
    createExploration: (title) => run((current) => createExploration(current, title)),
    sendExplorationMessage: (id, content, role: AIRole) => run((current) => sendExplorationMessage(current, id, content, role)),
    setCandidateStatus: (id, status: CandidateStatus, targetId) => run((current) => setCandidateStatus(current, id, status, targetId)),
    getDiagnostics: () => run(getDiagnostics),
    searchAll: (query, limit) => run((current) => searchAll(current, query, limit)),
    getDocumentTags: (id) => run((current) => getDocumentTags(current, id)),
    setDocumentTags: (id, tags) => run((current) => setDocumentTags(current, id, tags)),
    indexDocumentLinks: (id, title, targets) => run((current) => indexDocumentLinks(current, id, title, targets)),
    listBacklinks: (title) => run((current) => listBacklinks(current, title)),
    getGuidanceMode: () => run(getGuidanceMode),
    setGuidanceMode: (mode: GuidanceMode) => run((current) => setGuidanceMode(current, mode)),
    resetDemoData: () => run((current) => resetState(current)),
  };
}
