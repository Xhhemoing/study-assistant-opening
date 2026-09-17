import { integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { openingSources } from "./opening-sources";
export const openingSourceChunks = pgTable("opening_source_chunks", {
  id: uuid("id").primaryKey().defaultRandom(),
  sourceId: uuid("source_id").notNull().references(() => openingSources.id, { onDelete: "cascade" }),
  sourceVersion: integer("source_version").notNull(),
  page: integer("page"),
  slideLabel: text("slide_label"),
  startMs: integer("start_ms"),
  endMs: integer("end_ms"),
  text: text("text").notNull(),
  imageObjectKey: text("image_object_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [uniqueIndex("opening_source_chunks_source_version_page_uidx").on(table.sourceId, table.sourceVersion, table.page)]);
export const openingSourceChunksSchema = { openingSourceChunks };
