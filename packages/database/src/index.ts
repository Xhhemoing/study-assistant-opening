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

export { identitySchema, users, sessions } from "./schema/identity";

export {
  createLibraryRepository,
  LibraryError,
  type LibraryRepository,
  type LibraryErrorCode,
  type DocumentRecord,
  type RevisionRecord,
  type RelationRecord,
  type PropertyRecord,
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
  applyMigrations,
  createSqlClient,
  listMigrationFiles,
  migrateFromUrl,
  type MigrationResult,
} from "./migrate";
