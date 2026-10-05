import type { SourceRecord } from "@aistudy/contracts";
import type { MaterialOrganization } from "./material-organization-client";
import { materialStatus } from "./material-collection";

export type MaterialSpace = "all" | "inbox" | "ready" | "attention" | `course:${string}`;
export function materialsInSpace(sources: readonly SourceRecord[], organization: MaterialOrganization, space: MaterialSpace): SourceRecord[] {
  if (space === "all") return [...sources];
  const assigned = new Set(organization.memberships.map(item => item.sourceId));
  if (space === "inbox") return sources.filter(item => !assigned.has(item.id));
  if (space === "ready" || space === "attention") return sources.filter(item => materialStatus(item) === space);
  const courseId = space.slice("course:".length);
  const members = new Set(organization.memberships.filter(item => item.courseId === courseId).map(item => item.sourceId));
  return sources.filter(item => members.has(item.id));
}
export function selectedMaterials(selected: readonly string[], sources: readonly SourceRecord[]): string[] {
  const available = new Set(sources.map(item => item.id));
  return [...new Set(selected)].filter(id => available.has(id));
}
