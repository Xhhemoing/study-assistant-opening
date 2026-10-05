-- Workspace-scoped BYOK model providers (R07 补充): owners configure providers,
-- models and API keys from the web settings panel. Keys are stored as
-- AES-256-GCM envelopes bound to ("opening-model-provider", workspace, provider).
-- Additive only; no existing rows are rewritten.
CREATE TABLE opening_model_providers (
  id UUID PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  base_url TEXT NOT NULL CHECK (char_length(btrim(base_url)) BETWEEN 1 AND 2048),
  api_key_hint TEXT CHECK (api_key_hint IS NULL OR char_length(api_key_hint) = 4),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, label)
);
CREATE INDEX opening_model_providers_scope_idx
  ON opening_model_providers (workspace_id, owner_user_id);

CREATE TABLE opening_model_provider_models (
  id UUID PRIMARY KEY,
  provider_id UUID NOT NULL REFERENCES opening_model_providers(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 120),
  model_name TEXT NOT NULL CHECK (char_length(btrim(model_name)) BETWEEN 1 AND 200),
  supports_vision BOOLEAN NOT NULL DEFAULT false,
  input_cents_per_million DOUBLE PRECISION NOT NULL CHECK (input_cents_per_million > 0),
  output_cents_per_million DOUBLE PRECISION NOT NULL CHECK (output_cents_per_million > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, label)
);
CREATE INDEX opening_model_provider_models_scope_idx
  ON opening_model_provider_models (workspace_id, owner_user_id);

CREATE TABLE opening_model_provider_credentials (
  provider_id UUID PRIMARY KEY REFERENCES opening_model_providers(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key_id TEXT NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 120),
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  ciphertext BYTEA NOT NULL CHECK (octet_length(ciphertext) > 0),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Rollback: DROP TABLE opening_model_provider_credentials;
-- DROP TABLE opening_model_provider_models;
-- DROP TABLE opening_model_providers;
