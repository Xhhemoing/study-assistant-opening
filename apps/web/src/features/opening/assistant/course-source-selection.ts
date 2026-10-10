import type { SourceRecord } from "@aistudy/contracts";
import type { MaterialOrganization } from "../library/material-organization-client";
import { isSourceSelectable } from "./source-page-controls";

/** Contracts TurnInput.sourceIds max — keep UI selection in sync. */
export const MAX_ASSISTANT_SOURCE_IDS = 32;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Parse `?courseId=` from the assistant route; reject non-UUIDs. */
export function parseAssistantCourseIdParam(value: string | undefined | null): string | null {
  if (!value) return null;
  return UUID_RE.test(value) ? value : null;
}

/** learningAttempt > resume > query/shell initialCourseId. */
export function resolveAssistantCourseId(input: {
  learningAttemptCourseId?: string | null;
  resumeCourseId?: string | null;
  initialCourseId?: string | null;
}): string | null {
  return input.learningAttemptCourseId ?? input.resumeCourseId ?? input.initialCourseId ?? null;
}

export function membershipSourceIdsForCourse(
  organization: MaterialOrganization | null | undefined,
  courseId: string | null | undefined,
): Set<string> {
  if (!organization || !courseId) return new Set();
  return new Set(
    organization.memberships
      .filter((item) => item.courseId === courseId)
      .map((item) => item.sourceId),
  );
}

export function hasReadyMembershipMaterials(
  sources: readonly SourceRecord[],
  membershipIds: ReadonlySet<string>,
): boolean {
  return sources.some((source) => membershipIds.has(source.id) && isSourceSelectable(source));
}

/** Append new ids without duplicates, capped at max (default 32). */
export function addSelectedSourceIds(
  current: readonly string[],
  ids: readonly string[],
  cap = MAX_ASSISTANT_SOURCE_IDS,
): string[] {
  const next = [...current];
  for (const id of ids) {
    if (next.includes(id)) continue;
    if (next.length >= cap) break;
    next.push(id);
  }
  return next;
}


/** Replace selection with server-echoed ids: unique, order-preserving, capped (default 32). */
export function uniqueCappedSourceIds(
  ids: readonly string[],
  cap = MAX_ASSISTANT_SOURCE_IDS,
): string[] {
  const next: string[] = [];
  for (const id of ids) {
    if (next.includes(id)) continue;
    if (next.length >= cap) break;
    next.push(id);
  }
  return next;
}

export function toggleSelectedSourceId(
  current: readonly string[],
  id: string,
  cap = MAX_ASSISTANT_SOURCE_IDS,
): string[] {
  if (current.includes(id)) return current.filter((item) => item !== id);
  if (current.length >= cap) return [...current];
  return [...current, id];
}
