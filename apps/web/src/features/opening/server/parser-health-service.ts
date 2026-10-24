import "server-only";
import { createOpeningParserHealthRepository } from "@aistudy/database";
import type { Sql } from "postgres";

export const readParserHealth = (sql: Sql) => createOpeningParserHealthRepository(sql).read();
