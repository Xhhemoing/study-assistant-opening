export const NATIVE_BACKUP_TABLES = [
  "workspaces",
  "courses",
  "course_asset_memberships",
  "course_goals",
  "goal_time_windows",
  "library_documents",
  "library_blocks",
  "library_relations",
  "library_revisions",
  "explorations",
  "promotion_records",
  "cards",
  "learning_events",
] as const;

export const RESTORE_TOPOLOGY = [
  "courses",
  "documents",
  "blocks",
  "revisions",
  "relations",
  "memberships",
  "goals",
  "windows",
  "explorations",
  "promotions",
  "cards",
  "events",
] as const;

export type RestoreCollection = (typeof RESTORE_TOPOLOGY)[number];

export type NativeBackupRecord = Record<string, unknown> & { id: string };

export type NativeBackupFileInput = {
  path: string;
  mediaType: string;
  bytes: Uint8Array;
};

export type NativeBackupSnapshot = {
  sourceWorkspaceId: string;
  workspace: Record<string, unknown> & { id: string };
  latestMigrationId: string;
  courses: NativeBackupRecord[];
  memberships: NativeBackupRecord[];
  goals: NativeBackupRecord[];
  windows: NativeBackupRecord[];
  documents: NativeBackupRecord[];
  blocks: NativeBackupRecord[];
  relations: NativeBackupRecord[];
  revisions: NativeBackupRecord[];
  explorations: NativeBackupRecord[];
  promotions: NativeBackupRecord[];
  cards: NativeBackupRecord[];
  events: NativeBackupRecord[];
  files: NativeBackupFileInput[];
};

export type ExistingBackupIds = Partial<Record<RestoreCollection, string[]>>;
