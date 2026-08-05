import { rolePolicySchema, type AIRole } from "@aistudy/contracts";

export type RolePolicy = {
  readonly role: AIRole;
  readonly instruction: string;
  readonly allowSourceRetrieval: boolean;
  readonly allowCandidateProposal: boolean;
  readonly allowFormalAssetMutation: false;
};

const policies: Record<AIRole, RolePolicy> = {
  retriever: { role: "retriever", instruction: "Retrieve relevant source-grounded context.", allowSourceRetrieval: true, allowCandidateProposal: false, allowFormalAssetMutation: false },
  explainer: { role: "explainer", instruction: "Explain the topic clearly and accurately.", allowSourceRetrieval: true, allowCandidateProposal: true, allowFormalAssetMutation: false },
  tutor: { role: "tutor", instruction: "Guide the learner with scaffolded questions and feedback.", allowSourceRetrieval: true, allowCandidateProposal: true, allowFormalAssetMutation: false },
  challenger: { role: "challenger", instruction: "Challenge assumptions and surface counterexamples.", allowSourceRetrieval: true, allowCandidateProposal: true, allowFormalAssetMutation: false },
  editor: { role: "editor", instruction: "Edit and clarify learner-provided material.", allowSourceRetrieval: false, allowCandidateProposal: true, allowFormalAssetMutation: false },
  examiner: { role: "examiner", instruction: "Assess understanding with rigorous questions.", allowSourceRetrieval: true, allowCandidateProposal: true, allowFormalAssetMutation: false },
  collaborator: { role: "collaborator", instruction: "Collaborate on a useful next step.", allowSourceRetrieval: true, allowCandidateProposal: true, allowFormalAssetMutation: false },
  silent: { role: "silent", instruction: "Remain silent while preserving candidate-only semantics.", allowSourceRetrieval: false, allowCandidateProposal: false, allowFormalAssetMutation: false },
};

export const ROLE_POLICIES: Readonly<Record<AIRole, RolePolicy>> = Object.freeze(
  Object.fromEntries(Object.entries(policies).map(([role, policy]) => [role, Object.freeze(policy)])) as Record<AIRole, RolePolicy>,
);

export function getRolePolicy(role: AIRole): RolePolicy {
  return Object.freeze(rolePolicySchema.parse({ ...ROLE_POLICIES[role] }));
}
