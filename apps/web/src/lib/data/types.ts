import type {
  AIRole,
  AssessmentMode,
  AttemptEvent,
  ErrorCause,
  Exploration,
  PracticeItem,
  PromotionCandidate,
  ReviewCard,
  ReviewGrade,
  ReviewQueueMode,
  ReviewState,
  StatusResult,
  StudyGoal,
  StudyGoalInput,
  StatusWord,
  TodayPlan,
  PlannedTask,
  ChatTurn,
} from "@aistudy/contracts";
import type { SearchHit, AssessmentSlice } from "@aistudy/domain";
import type { StorageLike } from "./mock/storage";

export interface SearchableDocument {
  id: string;
  title: string;
  body?: string;
  tags?: string[];
  blocks?: Array<{ type: string; content: Record<string, unknown> }>;
}

export interface AttemptInput {
  practiceItemId: string;
  practiceSessionId?: string;
  answer: string;
  durationMs: number;
  hintCount: number;
  confidence: number;
  errorCause: ErrorCause | null;
  assisted: boolean;
  idempotencyKey: string;
  eventId?: string;
}

export interface SubmissionResult {
  event: AttemptEvent;
  status: StatusResult;
}

export interface ReviewQueueItem {
  card: ReviewCard;
  state: ReviewState;
}

export interface ReviewCardInput {
  front: string;
  back: string;
  tags?: string[];
  sourceDocumentId?: string | null;
  syllabusPointId?: string | null;
}

export interface PracticeItemInput {
  stem: string;
  answer: string;
  kind?: PracticeItem["kind"];
  options?: string[];
  hints?: string[];
  abilitySlice?: PracticeItem["abilitySlice"];
  estimatedMinutes?: number;
  syllabusPointId?: string;
}

export interface ExplorationDetail {
  exploration: Exploration;
  turns: ChatTurn[];
  candidates: PromotionCandidate[];
}

export interface ExplorationMessageResult {
  userTurn: ChatTurn;
  aiTurn: ChatTurn | null;
  candidate: PromotionCandidate | null;
}

export type CandidateStatus = PromotionCandidate["status"];
export type TaskStatus = PlannedTask["status"];
export type GuidanceMode = "direct" | "balanced" | "socratic";

export interface DocumentLink {
  sourceDocumentId: string;
  sourceTitle: string;
  targetTitle: string;
  createdAt: string;
}

export interface StatusCorrection {
  id: string;
  syllabusPointId: string;
  note: string;
  overrideStatus?: StatusWord | null;
  createdAt: string;
}

export interface ReviewEvidenceRecord {
  syllabusPointId: string;
  grade: ReviewGrade;
  occurredAt: string;
}

export interface SyllabusPoint {
  id: string;
  title: string;
}

export interface MockProviderOptions {
  userId: string;
  storage: StorageLike;
  fetchDocuments?: () => Promise<SearchableDocument[]>;
  now?: Date | (() => Date);
  delayMs?: number;
  syllabus?: SyllabusPoint[];
  assessmentMode?: AssessmentMode;
  disabledSlices?: AssessmentSlice[];
  protectedExplorationMinutes?: number;
  planningEnabled?: boolean;
}

export interface StudyDataProvider {
  listGoals(): Promise<StudyGoal[]>;
  getGoal(id: string): Promise<StudyGoal | null>;
  createGoal(input: StudyGoalInput): Promise<StudyGoal>;
  updateGoal(id: string, input: Partial<StudyGoalInput>): Promise<StudyGoal>;
  archiveGoal(id: string): Promise<StudyGoal>;
  getTodayPlan(date?: string): Promise<TodayPlan>;
  selectPlanOption(date: string, optionId: string): Promise<TodayPlan>;
  setTaskStatus(date: string, taskId: string, status: TaskStatus): Promise<TodayPlan>;
  toggleTaskLock(date: string, taskId: string): Promise<TodayPlan>;
  getPracticeItem(id: string): Promise<PracticeItem | null>;
  submitAttempt(input: AttemptInput): Promise<SubmissionResult>;
  listStatuses(): Promise<StatusResult[]>;
  recordStatusCorrection(
    syllabusPointId: string,
    note: string,
    overrideStatus?: StatusWord | null,
  ): Promise<StatusCorrection>;
  listDueCards(at?: Date, options?: { mode?: ReviewQueueMode }): Promise<ReviewQueueItem[]>;
  createReviewCard(input: ReviewCardInput): Promise<ReviewCard>;
  gradeCard(cardId: string, grade: ReviewGrade, input?: { idempotencyKey?: string }): Promise<ReviewState>;
  createPracticeItem(input: PracticeItemInput): Promise<PracticeItem>;
  listExplorations(): Promise<Exploration[]>;
  getExploration(id: string): Promise<ExplorationDetail | null>;
  createExploration(title: string): Promise<Exploration>;
  sendExplorationMessage(
    explorationId: string,
    content: string,
    role: AIRole,
  ): Promise<ExplorationMessageResult>;
  setCandidateStatus(
    candidateId: string,
    status: CandidateStatus,
    promotedTargetId?: string | null,
  ): Promise<PromotionCandidate>;
  getDiagnostics(): Promise<{
    versions: Record<string, string>;
    recentAttemptEvents: AttemptEvent[];
    statuses: StatusResult[];
    planTaskReasons: Array<{ taskId: string; reason: string }>;
  }>;
  searchAll(query: string, limit?: number): Promise<SearchHit[]>;
  getDocumentTags(documentId: string): Promise<string[]>;
  setDocumentTags(documentId: string, tags: string[]): Promise<string[]>;
  indexDocumentLinks(
    documentId: string,
    documentTitle: string,
    targetTitles: string[],
  ): Promise<void>;
  listBacklinks(targetTitle: string): Promise<DocumentLink[]>;
  getGuidanceMode(): Promise<GuidanceMode>;
  setGuidanceMode(mode: GuidanceMode): Promise<GuidanceMode>;
  resetDemoData(): Promise<void>;
}
