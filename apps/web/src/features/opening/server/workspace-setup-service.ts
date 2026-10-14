import "server-only";
import type { Scope } from "@aistudy/contracts";
import type { Sql } from "postgres";
import { openingOnboardingInputSchema } from "@aistudy/contracts";
import { createOpeningOnboardingRepository, createOpeningGuidanceSettingsRepository } from "@aistudy/database";
export function getOpeningOnboardingStatus(sql: Sql, scope: Scope) { return createOpeningOnboardingRepository(sql).status(scope); }
export function completeOpeningOnboarding(sql: Sql, scope: Scope, input: unknown) { return createOpeningOnboardingRepository(sql).complete(scope, openingOnboardingInputSchema.parse(input)); }
export function getOpeningGuidanceSettings(sql: Sql, scope: Scope) { return createOpeningGuidanceSettingsRepository(sql).get(scope); }
export function saveOpeningGuidanceSettings(sql: Sql, scope: Scope, input: unknown) { return createOpeningGuidanceSettingsRepository(sql).save(scope, input); }
