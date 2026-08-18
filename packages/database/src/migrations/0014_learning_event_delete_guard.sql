-- 0014_learning_event_delete_guard.sql
-- Reject ordinary DELETE on learning_events. Corrections remain append-only
-- INSERT facts. Do not add a session-variable bypass; account deletion is a
-- later privileged maintenance path.

CREATE OR REPLACE FUNCTION learning_events_reject_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'learning_events are append-only'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

DROP TRIGGER IF EXISTS learning_events_no_delete ON learning_events;
CREATE TRIGGER learning_events_no_delete
  BEFORE DELETE ON learning_events
  FOR EACH ROW
  EXECUTE FUNCTION learning_events_reject_delete();
