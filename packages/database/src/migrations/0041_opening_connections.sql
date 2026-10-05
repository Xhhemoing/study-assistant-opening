-- C01: owner-scoped external connection metadata and encrypted credentials.
CREATE TABLE IF NOT EXISTS opening_connections (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('imap', 'dingtalk')),
  label TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 180),
  host TEXT,
  port INTEGER CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
  tls_mode TEXT CHECK (tls_mode IS NULL OR tls_mode IN ('implicit', 'starttls')),
  username TEXT,
  folders JSONB NOT NULL DEFAULT '[]'::jsonb,
  since_at TIMESTAMPTZ,
  allowed_scopes TEXT[] NOT NULL DEFAULT '{}',
  state TEXT NOT NULL DEFAULT 'needs_authorization'
    CHECK (state IN ('disabled', 'needs_authorization', 'ready', 'syncing', 'error', 'revoked')),
  last_success_at TIMESTAMPTZ,
  error_code TEXT,
  create_client_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, create_client_key)
);
CREATE INDEX IF NOT EXISTS opening_connections_owner_idx
  ON opening_connections (workspace_id, owner_user_id, state);

CREATE TABLE IF NOT EXISTS opening_connection_credentials (
  connection_id UUID PRIMARY KEY REFERENCES opening_connections(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 120),
  nonce BYTEA NOT NULL,
  ciphertext BYTEA NOT NULL,
  auth_tag BYTEA NOT NULL,
  client_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, connection_id, client_key)
);
