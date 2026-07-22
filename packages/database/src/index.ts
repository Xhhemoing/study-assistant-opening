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
  applyMigrations,
  createSqlClient,
  listMigrationFiles,
  migrateFromUrl,
  type MigrationResult,
} from "./migrate";
