-- Add lifecycle/idempotency fields without rewriting the applied 0041 migration.
ALTER TABLE opening_connections
  ADD COLUMN requested_scopes TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN create_payload_hash TEXT,
  ADD COLUMN revoke_client_key TEXT,
  ADD COLUMN revoked_from_version INTEGER;
-- No connector has been implemented; requested scopes never constitute a grant.
UPDATE opening_connections SET requested_scopes=allowed_scopes, allowed_scopes='{}'
  WHERE kind='dingtalk';
ALTER TABLE opening_connection_credentials
  ADD CONSTRAINT opening_connection_nonce_length CHECK (octet_length(nonce)=12),
  ADD CONSTRAINT opening_connection_tag_length CHECK (octet_length(auth_tag)=16);
CREATE TABLE opening_connection_credential_requests (
  connection_id UUID NOT NULL REFERENCES opening_connections(id) ON DELETE CASCADE,
  client_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  PRIMARY KEY (connection_id, client_key)
);
