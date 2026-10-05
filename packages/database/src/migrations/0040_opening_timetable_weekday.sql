-- Align persisted timetable weekdays with the domain and spreadsheet contract: Monday=1 ... Sunday=7.
-- Legacy 0 represented Sunday in the original 0..6 contract; preserve its meaning.
UPDATE opening_timetable_sessions SET weekday = 7 WHERE weekday = 0;
ALTER TABLE opening_timetable_sessions
  DROP CONSTRAINT IF EXISTS opening_timetable_sessions_weekday_check;
ALTER TABLE opening_timetable_sessions
  ADD CONSTRAINT opening_timetable_sessions_weekday_check CHECK (weekday BETWEEN 1 AND 7);
