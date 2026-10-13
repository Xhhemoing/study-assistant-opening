-- PR-D (PM-approved direction; numbered 0059 because PR-C owns 0058_opening_turn_clarify): observable budget reconcile + atomic execution claim.
-- Additive only. Keeps global UNIQUE(request_id) and the existing state CHECK
-- (reserved|completed|released). Reconciled rows stay state='completed' and are
-- distinguished by reconciled_at / pending_reconcile_cents.
ALTER TABLE opening_budget_reservations
  ADD COLUMN IF NOT EXISTS execution_claimed_at timestamptz,
  ADD COLUMN IF NOT EXISTS outcome_unknown_at timestamptz,
  ADD COLUMN IF NOT EXISTS release_reason text
    CHECK (release_reason IS NULL OR release_reason IN ('not_sent','cancelled')),
  ADD COLUMN IF NOT EXISTS result_ref text,
  ADD COLUMN IF NOT EXISTS reconciled_at timestamptz,
  -- Original reserve amount (settle may lower amount_cents); replay identity.
  ADD COLUMN IF NOT EXISTS reserved_amount_cents integer
    CHECK (reserved_amount_cents IS NULL OR reserved_amount_cents > 0),
  ADD COLUMN IF NOT EXISTS pending_reconcile_cents integer NOT NULL DEFAULT 0
    CHECK (pending_reconcile_cents >= 0);

CREATE TABLE IF NOT EXISTS opening_budget_reconcile_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  reservation_id uuid NOT NULL REFERENCES opening_budget_reservations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- cap_overrun: a late receipt pushed local-day usage over the effective cap
  -- (alert; never silent).
  kind text NOT NULL CHECK (kind IN ('ttl_reconciled','late_receipt','cap_overrun')),
  amount_before_cents integer NOT NULL,
  amount_after_cents integer NOT NULL,
  reported_actual_cents integer,
  state_before text NOT NULL,
  cap_cents integer,
  usage_after_cents integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reservation_id, kind)
);
CREATE INDEX IF NOT EXISTS opening_budget_reconcile_events_ws_idx
  ON opening_budget_reconcile_events(workspace_id, created_at);
