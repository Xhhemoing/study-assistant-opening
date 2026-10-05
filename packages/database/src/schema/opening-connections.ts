import { customType, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./identity";
import { workspaces } from "./library";
const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

export const openingConnections = pgTable("opening_connections", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  ownerUserId: uuid("owner_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(0),
  kind: text("kind").notNull(), label: text("label").notNull(),
  host: text("host"), port: integer("port"), tlsMode: text("tls_mode"), username: text("username"),
  folders: jsonb("folders").notNull().default([]), sinceAt: timestamp("since_at", { withTimezone: true }),
  allowedScopes: text("allowed_scopes").array().notNull().default([]),
  requestedScopes: text("requested_scopes").array().notNull().default([]),
  state: text("state").notNull().default("needs_authorization"),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }), errorCode: text("error_code"),
  createClientKey: text("create_client_key").notNull(), createPayloadHash: text("create_payload_hash"),
  revokeClientKey: text("revoke_client_key"), revokedFromVersion: integer("revoked_from_version"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("opening_connections_workspace_client_key").on(t.workspaceId, t.createClientKey)]);
export const openingConnectionCredentials = pgTable("opening_connection_credentials", {
  connectionId: uuid("connection_id").primaryKey().references(() => openingConnections.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  keyId: text("key_id").notNull(), nonce: bytea("nonce").notNull(), ciphertext: bytea("ciphertext").notNull(),
  authTag: bytea("auth_tag").notNull(), clientKey: text("client_key").notNull(), payloadHash: text("payload_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const openingConnectionCredentialRequests = pgTable("opening_connection_credential_requests", {
  connectionId: uuid("connection_id").notNull().references(() => openingConnections.id, { onDelete: "cascade" }),
  clientKey: text("client_key").notNull(), payloadHash: text("payload_hash").notNull(),
}, t => [primaryKey({ columns: [t.connectionId, t.clientKey] })]);
