import type { DependencyStatus, HealthResponse } from "@aistudy/contracts";
import { healthResponseSchema } from "@aistudy/contracts";

export type HealthChecks = {
  database: DependencyStatus;
  redis: DependencyStatus;
  storage: DependencyStatus;
};

export function buildHealthResponse(input: {
  service: string;
  checks: HealthChecks;
}): HealthResponse {
  const values = Object.values(input.checks);
  const allUp = values.every((check) => check.status === "up");
  const allDown = values.every((check) => check.status === "down");

  const body: HealthResponse = {
    service: input.service,
    status: allUp ? "ok" : allDown ? "down" : "degraded",
    checks: input.checks,
  };

  return healthResponseSchema.parse(body);
}
