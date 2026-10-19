import type { TransactionSql } from "postgres";
import type { Scope, SystemQueryRequest } from "@aistudy/contracts";
import { nextLearningStep, summarizeObservations, resolveEvidenceAssistance } from "@aistudy/domain";
import { openingEligibilityStateQuery, openingEligibilityPolicyVersion } from "./opening-learning-eligibility";
import { readOpeningLearningEvidenceContexts } from "./opening-learning-evidence-context";
import { mapLearningObservation } from "./opening-learning-facts";
import type { OpeningSystemQueryDraft } from "./opening-system-query";
import { readSystemQueryAncestry } from "./opening-system-query-admission";
