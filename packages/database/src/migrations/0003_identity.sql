-- 0003_identity.sql
-- Users, revocable sessions, and one personal workspace per user.

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  schema_version integer NOT NULL DEFAULT 1 CHECK (schema_version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz NULL,
  CONSTRAINT users_email_nonempty CHECK (char_length(trim(email)) > 0)
);

-- Case-insensitive unique email
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uidx
  ON users (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_idx
  ON sessions (user_id)
  WHERE revoked_at IS NULL;

-- Orphan workspaces cannot satisfy FK to users. Cleaning them requires
-- temporarily allowing deletion of append-only revision rows.
ALTER TABLE library_revisions DISABLE TRIGGER library_revisions_no_delete;
ALTER TABLE library_revisions DISABLE TRIGGER library_revisions_no_update;

DELETE FROM workspaces w
WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = w.owner_user_id);

ALTER TABLE library_revisions ENABLE TRIGGER library_revisions_no_delete;
ALTER TABLE library_revisions ENABLE TRIGGER library_revisions_no_update;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_owner_user_id_fkey'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_owner_user_id_fkey
      FOREIGN KEY (owner_user_id) REFERENCES users (id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_owner_user_uidx
  ON workspaces (owner_user_id);
