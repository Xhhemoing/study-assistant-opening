import { randomUUID } from "node:crypto";
import {
  assetTypeSchema,
  type AssetType,
} from "@aistudy/contracts";
import type { Sql } from "postgres";
import {
  createLibraryRepository,
  LibraryError,
  type DocumentRecord,
} from "./library";

const ASSET_TYPES = new Set(assetTypeSchema.options);
const ROLES = new Set(["core", "optional", "reference", "archive"] as const);
const VISIBILITIES = new Set(["private", "course", "public"] as const);

export type CourseMembershipErrorCode =
  | "NOT_FOUND"
  | "VALIDATION"
  | "WORKSPACE_MISMATCH"
  | "CROSS_WORKSPACE_REFERENCE"
  | "DUPLICATE_MEMBERSHIP"
  | "CONFLICT";

export class CourseMembershipError extends Error {
  readonly code: CourseMembershipErrorCode;

  constructor(code: CourseMembershipErrorCode, message: string) {
    super(message);
    this.name = "CourseMembershipError";
    this.code = code;
  }
}

export type CourseRole = "core" | "optional" | "reference" | "archive";
export type CourseVisibility = "private" | "course" | "public";

export type CourseRecord = {
  id: string;
  workspaceId: string;
  title: string;
  slug: string;
  description: string;
  schemaVersion: number;
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
};

export type AssetMembershipRecord = {
  id: string;
  workspaceId: string;
  courseId: string;
  assetType: AssetType;
  assetId: string;
  role: CourseRole;
  sortOrder: number;
  visibility: CourseVisibility;
  createdAt: Date;
  updatedAt: Date;
};

export type CourseAssetListItem = AssetMembershipRecord & {
  /** Present when assetType is document and the document is loadable. */
  document?: DocumentRecord;
};

export type CourseForAsset = AssetMembershipRecord & {
  courseTitle: string;
  courseSlug: string;
};

export type CourseMembershipRepository = {
  createCourse(input: {
    workspaceId: string;
    title: string;
    slug: string;
    description?: string;
    courseId?: string;
  }): Promise<CourseRecord>;

  getCourse(input: {
    workspaceId: string;
    courseId: string;
  }): Promise<CourseRecord>;

  listCourses(input: { workspaceId: string }): Promise<CourseRecord[]>;

  addAssetMembership(input: {
    workspaceId: string;
    courseId: string;
    assetType: AssetType;
    assetId: string;
    role: CourseRole;
    sortOrder?: number;
    visibility: CourseVisibility;
  }): Promise<AssetMembershipRecord>;

  updateAssetMembership(input: {
    workspaceId: string;
    courseId: string;
    assetType: AssetType;
    assetId: string;
    role?: CourseRole;
    sortOrder?: number;
    visibility?: CourseVisibility;
  }): Promise<AssetMembershipRecord>;

  removeAssetMembership(input: {
    workspaceId: string;
    courseId: string;
    assetType: AssetType;
    assetId: string;
  }): Promise<void>;

  getMembership(input: {
    workspaceId: string;
    courseId: string;
    assetType: AssetType;
    assetId: string;
  }): Promise<AssetMembershipRecord>;

  listCourseAssets(input: {
    workspaceId: string;
    courseId: string;
  }): Promise<CourseAssetListItem[]>;

  listCoursesForAsset(input: {
    workspaceId: string;
    assetType: AssetType;
    assetId: string;
  }): Promise<CourseForAsset[]>;
};

function assertUuid(value: string, field: string): void {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    )
  ) {
    throw new CourseMembershipError("VALIDATION", `Invalid UUID for ${field}`);
  }
}

function assertRole(value: string): asserts value is CourseRole {
  if (!ROLES.has(value as CourseRole)) {
    throw new CourseMembershipError("VALIDATION", `Invalid role: ${value}`);
  }
}

function assertVisibility(value: string): asserts value is CourseVisibility {
  if (!VISIBILITIES.has(value as CourseVisibility)) {
    throw new CourseMembershipError(
      "VALIDATION",
      `Invalid visibility: ${value}`,
    );
  }
}

function assertAssetType(value: string): asserts value is AssetType {
  if (!ASSET_TYPES.has(value as AssetType)) {
    throw new CourseMembershipError(
      "VALIDATION",
      `Invalid asset type: ${value}`,
    );
  }
}

function mapCourse(row: Record<string, unknown>): CourseRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    title: row.title as string,
    slug: row.slug as string,
    description: row.description as string,
    schemaVersion: row.schema_version as number,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
    archivedAt: row.archived_at
      ? new Date(row.archived_at as string | Date)
      : null,
  };
}

function mapMembership(row: Record<string, unknown>): AssetMembershipRecord {
  return {
    id: row.id as string,
    workspaceId: row.workspace_id as string,
    courseId: row.course_id as string,
    assetType: row.asset_type as AssetType,
    assetId: row.asset_id as string,
    role: row.role as CourseRole,
    sortOrder: row.sort_order as number,
    visibility: row.visibility as CourseVisibility,
    createdAt: new Date(row.created_at as string | Date),
    updatedAt: new Date(row.updated_at as string | Date),
  };
}

export function createCourseMembershipRepository(
  sql: Sql,
): CourseMembershipRepository {
  const library = createLibraryRepository(sql);

  async function ensureWorkspace(workspaceId: string): Promise<void> {
    assertUuid(workspaceId, "workspaceId");
    const rows = await sql`
      SELECT id FROM workspaces WHERE id = ${workspaceId} LIMIT 1
    `;
    if (!rows.length) {
      throw new CourseMembershipError(
        "NOT_FOUND",
        `Workspace not found: ${workspaceId}`,
      );
    }
  }

  async function loadCourse(
    workspaceId: string,
    courseId: string,
  ): Promise<CourseRecord> {
    assertUuid(courseId, "courseId");
    const rows = await sql`
      SELECT * FROM courses
      WHERE id = ${courseId} AND workspace_id = ${workspaceId}
      LIMIT 1
    `;
    if (!rows.length) {
      const any = await sql`
        SELECT workspace_id FROM courses WHERE id = ${courseId} LIMIT 1
      `;
      if (any.length && any[0]!.workspace_id !== workspaceId) {
        throw new CourseMembershipError(
          "WORKSPACE_MISMATCH",
          `Course ${courseId} is not in workspace ${workspaceId}`,
        );
      }
      throw new CourseMembershipError(
        "NOT_FOUND",
        `Course not found: ${courseId}`,
      );
    }
    return mapCourse(rows[0] as Record<string, unknown>);
  }

  /**
   * Resolve the workspace that owns an asset. Currently documents are
   * first-class library assets; other types are reserved for later tasks.
   */
  async function resolveAssetWorkspace(
    assetType: AssetType,
    assetId: string,
  ): Promise<string> {
    assertUuid(assetId, "assetId");
    assertAssetType(assetType);

    if (assetType === "document") {
      const rows = await sql`
        SELECT workspace_id FROM library_documents
        WHERE id = ${assetId} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!rows.length) {
        throw new CourseMembershipError(
          "NOT_FOUND",
          `Document not found: ${assetId}`,
        );
      }
      return rows[0]!.workspace_id as string;
    }

    if (assetType === "block") {
      const rows = await sql`
        SELECT workspace_id FROM library_blocks WHERE id = ${assetId} LIMIT 1
      `;
      if (!rows.length) {
        throw new CourseMembershipError(
          "NOT_FOUND",
          `Block not found: ${assetId}`,
        );
      }
      return rows[0]!.workspace_id as string;
    }

    if (assetType === "card") {
      const rows = await sql`
        SELECT workspace_id FROM cards WHERE id = ${assetId} LIMIT 1
      `;
      if (!rows.length) {
        throw new CourseMembershipError("NOT_FOUND", `Card not found: ${assetId}`);
      }
      return rows[0]!.workspace_id as string;
    }

    // Other asset types land in later migrations; reject until tables exist.
    throw new CourseMembershipError(
      "VALIDATION",
      `Asset type not yet membership-backed: ${assetType}`,
    );
  }

  return {
    async createCourse(input) {
      await ensureWorkspace(input.workspaceId);
      if (!input.title?.trim()) {
        throw new CourseMembershipError("VALIDATION", "Course title is required");
      }
      if (!input.slug?.trim()) {
        throw new CourseMembershipError("VALIDATION", "Course slug is required");
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug)) {
        throw new CourseMembershipError(
          "VALIDATION",
          "Course slug must be lowercase kebab-case",
        );
      }

      const courseId = input.courseId ?? randomUUID();
      assertUuid(courseId, "courseId");

      try {
        const rows = await sql`
          INSERT INTO courses (id, workspace_id, title, slug, description)
          VALUES (
            ${courseId},
            ${input.workspaceId},
            ${input.title},
            ${input.slug},
            ${input.description ?? ""}
          )
          RETURNING *
        `;
        return mapCourse(rows[0] as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("courses_workspace_id_slug_key") || message.includes("unique")) {
          throw new CourseMembershipError(
            "CONFLICT",
            `Course slug already exists in workspace: ${input.slug}`,
          );
        }
        throw error;
      }
    },

    async getCourse(input) {
      return loadCourse(input.workspaceId, input.courseId);
    },

    async listCourses(input) {
      await ensureWorkspace(input.workspaceId);
      const rows = await sql`
        SELECT * FROM courses
        WHERE workspace_id = ${input.workspaceId}
          AND archived_at IS NULL
        ORDER BY title ASC, created_at ASC
      `;
      return rows.map((row) => mapCourse(row as Record<string, unknown>));
    },

    async addAssetMembership(input) {
      await ensureWorkspace(input.workspaceId);
      assertAssetType(input.assetType);
      assertRole(input.role);
      assertVisibility(input.visibility);
      assertUuid(input.assetId, "assetId");

      const course = await loadCourse(input.workspaceId, input.courseId);
      if (course.workspaceId !== input.workspaceId) {
        throw new CourseMembershipError(
          "WORKSPACE_MISMATCH",
          "Course workspace mismatch",
        );
      }

      const assetWs = await resolveAssetWorkspace(
        input.assetType,
        input.assetId,
      );
      if (assetWs !== input.workspaceId) {
        throw new CourseMembershipError(
          "CROSS_WORKSPACE_REFERENCE",
          "Cannot attach an asset from another workspace to a course",
        );
      }

      const sortOrder = input.sortOrder ?? 0;
      if (!Number.isInteger(sortOrder)) {
        throw new CourseMembershipError(
          "VALIDATION",
          "sortOrder must be an integer",
        );
      }

      try {
        const rows = await sql`
          INSERT INTO course_asset_memberships (
            workspace_id,
            course_id,
            asset_type,
            asset_id,
            role,
            sort_order,
            visibility
          ) VALUES (
            ${input.workspaceId},
            ${input.courseId},
            ${input.assetType},
            ${input.assetId},
            ${input.role},
            ${sortOrder},
            ${input.visibility}
          )
          RETURNING *
        `;
        return mapMembership(rows[0] as Record<string, unknown>);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("course_asset_memberships") &&
          (message.includes("unique") || message.includes("duplicate"))
        ) {
          throw new CourseMembershipError(
            "DUPLICATE_MEMBERSHIP",
            `Asset ${input.assetId} is already a member of course ${input.courseId}`,
          );
        }
        throw error;
      }
    },

    async updateAssetMembership(input) {
      await ensureWorkspace(input.workspaceId);
      const current = await this.getMembership(input);

      const role = input.role ?? current.role;
      const visibility = input.visibility ?? current.visibility;
      const sortOrder = input.sortOrder ?? current.sortOrder;
      assertRole(role);
      assertVisibility(visibility);
      if (!Number.isInteger(sortOrder)) {
        throw new CourseMembershipError(
          "VALIDATION",
          "sortOrder must be an integer",
        );
      }

      const rows = await sql`
        UPDATE course_asset_memberships
        SET role = ${role},
            sort_order = ${sortOrder},
            visibility = ${visibility},
            updated_at = now()
        WHERE course_id = ${input.courseId}
          AND workspace_id = ${input.workspaceId}
          AND asset_type = ${input.assetType}
          AND asset_id = ${input.assetId}
        RETURNING *
      `;
      if (!rows.length) {
        throw new CourseMembershipError(
          "NOT_FOUND",
          "Membership not found for update",
        );
      }
      return mapMembership(rows[0] as Record<string, unknown>);
    },

    async removeAssetMembership(input) {
      await ensureWorkspace(input.workspaceId);
      const result = await sql`
        DELETE FROM course_asset_memberships
        WHERE course_id = ${input.courseId}
          AND workspace_id = ${input.workspaceId}
          AND asset_type = ${input.assetType}
          AND asset_id = ${input.assetId}
        RETURNING id
      `;
      if (!result.length) {
        throw new CourseMembershipError(
          "NOT_FOUND",
          `Membership not found for asset ${input.assetId} in course ${input.courseId}`,
        );
      }
    },

    async getMembership(input) {
      await ensureWorkspace(input.workspaceId);
      const rows = await sql`
        SELECT * FROM course_asset_memberships
        WHERE course_id = ${input.courseId}
          AND workspace_id = ${input.workspaceId}
          AND asset_type = ${input.assetType}
          AND asset_id = ${input.assetId}
        LIMIT 1
      `;
      if (!rows.length) {
        throw new CourseMembershipError(
          "NOT_FOUND",
          `Membership not found for asset ${input.assetId} in course ${input.courseId}`,
        );
      }
      return mapMembership(rows[0] as Record<string, unknown>);
    },

    async listCourseAssets(input) {
      await loadCourse(input.workspaceId, input.courseId);
      const rows = await sql`
        SELECT * FROM course_asset_memberships
        WHERE course_id = ${input.courseId}
          AND workspace_id = ${input.workspaceId}
        ORDER BY sort_order ASC, created_at ASC
      `;

      const items: CourseAssetListItem[] = [];
      for (const row of rows) {
        const membership = mapMembership(row as Record<string, unknown>);
        const item: CourseAssetListItem = { ...membership };

        if (membership.assetType === "document") {
          try {
            item.document = await library.getDocument({
              workspaceId: input.workspaceId,
              documentId: membership.assetId,
            });
          } catch (error) {
            if (
              !(error instanceof LibraryError && error.code === "NOT_FOUND")
            ) {
              throw error;
            }
            // Soft-deleted or missing document: membership remains, no content.
          }
        }

        items.push(item);
      }
      return items;
    },

    async listCoursesForAsset(input) {
      await ensureWorkspace(input.workspaceId);
      assertAssetType(input.assetType);
      assertUuid(input.assetId, "assetId");

      const rows = await sql`
        SELECT m.*, c.title AS course_title, c.slug AS course_slug
        FROM course_asset_memberships m
        INNER JOIN courses c ON c.id = m.course_id
        WHERE m.workspace_id = ${input.workspaceId}
          AND m.asset_type = ${input.assetType}
          AND m.asset_id = ${input.assetId}
        ORDER BY c.title ASC
      `;

      return rows.map((row) => ({
        ...mapMembership(row as Record<string, unknown>),
        courseTitle: row.course_title as string,
        courseSlug: row.course_slug as string,
      }));
    },
  };
}
