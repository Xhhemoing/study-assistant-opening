-- Original learner self-report captured atomically with the first answer.
-- No historical backfill: missing is unknown, never the lowest category.
ALTER TABLE opening_learning_attempts ADD COLUMN pre_answer_confidence text
  CHECK (pre_answer_confidence IN ('not_confident', 'somewhat_confident', 'confident'));