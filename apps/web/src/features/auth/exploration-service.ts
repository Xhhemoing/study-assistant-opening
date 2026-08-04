import {
  createExplorationBranchRequestSchema,
  createExplorationBlockRequestSchema,
  createExplorationRequestSchema,
  explorationStatusRequestSchema,
  type ExplorationBlockKind,
  type ExplorationStatus,
} from "@aistudy/contracts";
import type { AuthRuntime } from "./service";
import type { Principal } from "../../lib/authorization";

export async function listExplorationsForPrincipal(runtime: AuthRuntime, principal: Principal) {
  return runtime.explorations.listExplorations({ workspaceId: principal.workspaceId });
}

export async function createExplorationForPrincipal(runtime: AuthRuntime, principal: Principal, body: unknown) {
  const parsed = createExplorationRequestSchema.parse(body);
  return runtime.explorations.createExploration({
    workspaceId: principal.workspaceId,
    ownerUserId: principal.userId,
    title: parsed.title,
    courseId: parsed.courseId,
    goalId: parsed.goalId,
  });
}

export async function getExplorationForPrincipal(runtime: AuthRuntime, principal: Principal, explorationId: string) {
  return runtime.explorations.getExploration({ workspaceId: principal.workspaceId, explorationId });
}

export async function createExplorationBranchForPrincipal(runtime: AuthRuntime, principal: Principal, explorationId: string, body: unknown) {
  const parsed = createExplorationBranchRequestSchema.parse(body);
  return runtime.explorations.createBranch({ workspaceId: principal.workspaceId, explorationId, ...parsed });
}

export async function createExplorationBlockForPrincipal(runtime: AuthRuntime, principal: Principal, explorationId: string, body: unknown) {
  const parsed = createExplorationBlockRequestSchema.parse(body);
  return runtime.explorations.createBlock({ workspaceId: principal.workspaceId, explorationId, ...parsed });
}

export async function setExplorationStatusForPrincipal(runtime: AuthRuntime, principal: Principal, explorationId: string, body: unknown) {
  const parsed = explorationStatusRequestSchema.parse(body);
  return runtime.explorations.setStatus({ workspaceId: principal.workspaceId, explorationId, status: parsed.status });
}

export type { ExplorationBlockKind, ExplorationStatus };
