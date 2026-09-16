export const DATABASE_PACKAGE = "@aistudy/database" as const;

export {
  librarySchema,
  workspaces,
  libraryDocuments,
  libraryBlocks,
  libraryRevisions,
  libraryRelations,
  libraryProperties,
  type RevisionBlockSnapshot,
} from "./schema/library";

export {
  courseSchema,
  courses,
  courseAssetMemberships,
} from "./schema/courses";

export {
  goalsSchema,
  courseGoals,
  goalTimeWindows,
} from "./schema/goals";

export { identitySchema, users, sessions } from "./schema/identity";

export {
  preferencesSchema,
  workspacePreferences,
} from "./schema/preferences";

export {
  explorationSchema,
  explorations,
  explorationBranches,
  explorationBlocks,
} from "./schema/explorations";

export {
  createLibraryRepository,
  LibraryError,
  type LibraryRepository,
  type LibraryErrorCode,
  type DocumentRecord,
  type RevisionRecord,
  type RelationRecord,
  type PropertyRecord,
  type SearchLibraryRow,
  type BlockInput,
} from "./repositories/library";

export {
  createCourseMembershipRepository,
  CourseMembershipError,
  type CourseMembershipRepository,
  type CourseMembershipErrorCode,
  type CourseRecord,
  type AssetMembershipRecord,
  type CourseAssetListItem,
  type CourseForAsset,
  type CourseRole,
  type CourseVisibility,
} from "./repositories/course-membership";

export {
  createIdentityRepository,
  IdentityError,
  hashSessionToken,
  type IdentityRepository,
  type IdentityErrorCode,
  type UserRecord,
  type SessionRecord,
  type WorkspaceOwnerRecord,
} from "./repositories/identity";

export {
  createWorkspacePreferencesRepository,
  WorkspacePreferencesError,
  type WorkspacePreferencesRepository,
  type WorkspacePreferencesErrorCode,
  type WorkspacePreferenceRecord,
} from "./repositories/preferences";

export {
  createExplorationRepository,
  ExplorationRepositoryError,
  type ExplorationRepository,
  type ExplorationErrorCode,
  type ExplorationRecord,
  type ExplorationDetailRecord,
  type ExplorationBranchRecord,
  type ExplorationBlockRecord,
} from "./repositories/explorations";

export {
  applyMigrations,
  createSqlClient,
  listMigrationFiles,
  migrateFromUrl,
  type MigrationResult,
  type ApplyMigrationsOptions,
  type Legacy0003Attestation,
  type MigrationRegistryErrorCode,
  MigrationRegistryError,
} from "./migrate";

export * from "./schema/promotions";
export * from "./repositories/promotions";
export * from "./schema/revision-proposals";
export * from "./repositories/revision-proposals";
export * from "./schema/learning-events";
export * from "./repositories/learning-events";
export * from "./schema/cards";
export * from "./repositories/cards";
export * from "./schema/practice-content";
export {
  createPracticeContentRepository,
  PracticeContentRepositoryError,
  type PracticeContentErrorCode,
  type PracticeContentRepository,
} from "./repositories/practice-content";
export {
  createPracticeSessionRepository,
  type PracticeSessionRepository,
} from "./repositories/practice-sessions";
export {
  createBackupRestoreRepository,
  BackupRestoreError,
  type BackupRestoreErrorCode,
  type BackupRestoreRepository,
} from "./repositories/backup-restore";

export {
  applyIdentityOwnerMappings,
  assertIdentityMigrationReady,
  getIdentityDatabaseFingerprint,
  inspectIdentityMigration,
  prepareIdentityOwnerMappings,
  IdentityMigrationPreflightError,
  IDENTITY_ORPHAN_WORKSPACES,
  type OrphanWorkspaceSummary,
} from "./migration-preflight";

export {
  openingSourcesSchema,
  openingSources,
} from "./schema/opening-sources";


export {
  createOpeningSourceRepository,
  OpeningSourceError,
  type OpeningSourceRepository,
  type OpeningSourceErrorCode,
  type OpeningScope,
} from "./repositories/opening-sources";

export {
  openingLearningSessions,
  openingProblemRefs,
  openingHelpExposures,
  openingLearningObservations,
} from "./schema/opening-learning";

export {
  createOpeningLearningRepository,
  type OpeningLearningDb,
  type OpeningLearningRepository,
} from "./repositories/opening-learning";

export {
  createOpeningConversationRepository,
  OpeningConversationError,
  type OpeningConversationRepository,
  type OpeningConversationScope,
  type OpeningConversationErrorCode,
} from "./repositories/opening-conversations";
