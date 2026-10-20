-- Durable budgets belong to one user intent, independent of job/round/fallback IDs.
-- Rollback: stop new workers; keep this additive DDL and ledger rows when reverting code.
CREATE TABLE opening_parent_interaction_budgets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  id text NOT NULL CHECK (length(btrim(id)) > 0 AND length(id) <= 256),
  budget_cents integer NOT NULL CHECK (budget_cents >= 0),
  max_provider_calls integer NOT NULL CHECK (max_provider_calls > 0),
  blocked_at timestamptz,
  blocked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
ALTER TABLE opening_budget_reservations
  ADD COLUMN parent_interaction_id text,
  ADD COLUMN settlement_cost_basis text
    CHECK (settlement_cost_basis IS NULL OR settlement_cost_basis IN ('usage_pricing','media_usage_upper_bound','vendor_receipt'));
ALTER TABLE opening_budget_reservations ADD CONSTRAINT opening_budget_parent_fk
  FOREIGN KEY (workspace_id, parent_interaction_id)
  REFERENCES opening_parent_interaction_budgets(workspace_id, id);
CREATE INDEX opening_budget_parent_idx
  ON opening_budget_reservations(workspace_id, parent_interaction_id);
COMMENT ON TABLE opening_parent_interaction_budgets IS
  'Pinned first-reserve cap. All reserves and settlements serialize under the workspace row lock.';
