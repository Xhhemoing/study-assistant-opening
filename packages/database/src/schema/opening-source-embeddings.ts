import { customType, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { openingSourceChunks } from "./opening-source-chunks";
import { openingSources } from "./opening-sources";

const embeddingVector = customType<{ data: number[]; driverData: string }>({
  dataType: () => "vector",
  toDriver: value => JSON.stringify(value),
  fromDriver: value => JSON.parse(value) as number[],
});
export const openingSourceEmbeddings = pgTable("opening_source_embeddings", {
  chunkId: uuid("chunk_id").notNull().references(() => openingSourceChunks.id, { onDelete: "cascade" }),
  sourceId: uuid("source_id").notNull().references(() => openingSources.id, { onDelete: "cascade" }),
  sourceVersion: integer("source_version").notNull(),
  modelKey: text("model_key").notNull(),
  dimensions: integer("dimensions").notNull(),
  segmentIndex: integer("segment_index").notNull(),
  text: text("text").notNull(),
  embedding: embeddingVector("embedding").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, table => [primaryKey({ columns: [table.chunkId, table.modelKey, table.segmentIndex] }),
  index("opening_source_embeddings_source_model_idx").on(table.sourceId, table.sourceVersion, table.modelKey, table.dimensions)]);
