import {
  STAGE0_PERSONA_IDS,
  hashSeed32,
  type Stage0EpisodeSpec,
  type Stage0Scenario,
  type Stage0VariantInstance,
} from "./types";
import { getCanonicalStage0PersonaProfile } from "./personas";

export const STAGE0_SCENARIO_COUNT = 16 as const;
export const STAGE0_PERSONA_COUNT = 6 as const;
export const STAGE0_VARIANTS_PER_PAIR = 8 as const;
export const STAGE0_EXPECTED_EPISODE_COUNT =
  STAGE0_SCENARIO_COUNT * STAGE0_PERSONA_COUNT * STAGE0_VARIANTS_PER_PAIR; // 768
export const STAGE0_DEFAULT_MAX_TURNS = 4 as const;
export const STAGE0_DEFAULT_SEED = 20261121 as const;

function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  const obj = value as unknown as object;
  if (seen.has(obj)) return value;
  seen.add(obj);

  if (Array.isArray(value)) {
    for (const item of value) {
      deepFreeze(item, seen);
    }
  } else {
    for (const key of Object.getOwnPropertyNames(obj)) {
      if (
        typeof value === "function" &&
        (key === "caller" || key === "callee" || key === "arguments")
      ) {
        continue;
      }
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      if (desc && "value" in desc) {
        deepFreeze(desc.value, seen);
      }
    }
  }

  if (!Object.isFrozen(obj)) {
    Object.freeze(obj);
  }
  return value;
}

function cloneAndFreezeVariant(variant: Stage0VariantInstance): Stage0VariantInstance {
  return deepFreeze({
    variantIndex: variant.variantIndex,
    prompt: variant.prompt,
    masteredWork: variant.masteredWork,
    misconceptionWork: variant.misconceptionWork,
    ambiguousWork: variant.ambiguousWork,
    clarifiedWork: variant.clarifiedWork,
    slipWork: variant.slipWork,
    repairedWork: variant.repairedWork,
    wheelSpinWork: variant.wheelSpinWork,
    protectedAnswerTokens: [...variant.protectedAnswerTokens],
    protectedStepTokens: [...variant.protectedStepTokens],
    analogCue: variant.analogCue,
    freshTransferPrompt: variant.freshTransferPrompt,
  });
}

function cloneAndFreezeScenario(scenario: Stage0Scenario): Stage0Scenario {
  const originalBuildVariant = scenario.buildVariant;
  const wrappedBuildVariant = Object.freeze((variantIndex: number): Stage0VariantInstance =>
    cloneAndFreezeVariant(originalBuildVariant(variantIndex)),
  );
  return deepFreeze({
    scenarioId: scenario.scenarioId,
    domain: scenario.domain,
    conceptId: scenario.conceptId,
    itemFamilyId: scenario.itemFamilyId,
    freshTransferFamilyId: scenario.freshTransferFamilyId,
    title: scenario.title,
    misconceptionId: scenario.misconceptionId,
    misconceptionDescription: scenario.misconceptionDescription,
    missingPremise: scenario.missingPremise,
    canonicalErrorSignal: scenario.canonicalErrorSignal,
    distractorMisconception: {
      misconceptionId: scenario.distractorMisconception.misconceptionId,
      missingPremise: scenario.distractorMisconception.missingPremise,
      canonicalErrorSignal: scenario.distractorMisconception.canonicalErrorSignal,
      description: scenario.distractorMisconception.description,
    },
    ambiguousNotationSignal: scenario.ambiguousNotationSignal,
    clarificationCue: scenario.clarificationCue,
    slipSignal: scenario.slipSignal,
    buildVariant: wrappedBuildVariant,
  });
}

const INTERNAL_STAGE0_SCENARIOS: readonly Stage0Scenario[] = deepFreeze([
  // 1. STEM Algebra — dividing by variable without checking zero root
  {
    scenarioId: "stem_alg_zero_root_division",
    domain: "stem_algebra",
    conceptId: "alg.zero_product_property",
    itemFamilyId: "fam.alg.quadratic_factoring",
    freshTransferFamilyId: "fam.alg.cubic_common_factor_transfer",
    title: "Dividing x(x - a) = 0 by x without zero-root check",
    misconceptionId: "mis.alg.divide_by_variable_drops_zero_root",
    misconceptionDescription: "Cancels variable factor x on both sides of an equation without guarding the x = 0 branch.",
    missingPremise: "x != 0 case split before dividing by x",
    canonicalErrorSignal: "err.alg.divide_by_variable_without_zero_guard",
    distractorMisconception: {
      misconceptionId: "mis.alg.sign_inversion_on_factor",
      missingPremise: "preserving root sign when expanding (x - a)",
      canonicalErrorSignal: "err.alg.factor_sign_flip",
      description: "Reverses the sign of constant root a in (x - a) = 0.",
    },
    ambiguousNotationSignal: "ambig.alg.domain_positive_reals_unstated",
    clarificationCue: "Are we solving over all real numbers R, or is x constrained to positive reals (x > 0)?",
    slipSignal: "slip.alg.copied_root_sign",
    buildVariant(v: number): Stage0VariantInstance {
      const a = v + 1;
      const slipA = -(a + 1);
      return {
        variantIndex: v,
        prompt: `Solve x(x - ${a}) = 0 for all real x.`,
        masteredWork: `By zero-product property, either x = 0 or x - ${a} = 0, giving x in {0, ${a}}.`,
        misconceptionWork: `Divide both sides of x(x - ${a}) = 0 by x to get x - ${a} = 0, so only x = ${a}.`,
        ambiguousWork: `x(x - ${a}) = 0 => x = ${a} (domain not written)`,
        clarifiedWork: `Over positive length x > 0 (so x != 0), dividing by x is valid and yields x = ${a}.`,
        slipWork: `Case 1: x = 0. Case 2: x - ${a} = 0 => copied as x = ${slipA}.`,
        repairedWork: `Keep both branches: x = 0 or x - ${a} = 0, without dividing by x when x can be 0.`,
        wheelSpinWork: `Maybe expand to x^2 - ${a}x = 0, then move ${a}x over, then guess x = 1?`,
        protectedAnswerTokens: [`{0, ${a}}`, `x = 0 or x = ${a}`, `roots_0_and_${a}`],
        protectedStepTokens: [`SEALED_STEP_ZERO_PRODUCT_${a}: x=0 | x-${a}=0`],
        analogCue: `Consider an analog product u * v = 0: can u be zero even when v is not?`,
        freshTransferPrompt: `Solve t^2(t - ${a + 3}) = 0 over R without losing any solution branch.`,
      };
    },
  },

  // 2. STEM Algebra — inequality direction when dividing by negative coefficient
  {
    scenarioId: "stem_alg_inequality_sign_flip",
    domain: "stem_algebra",
    conceptId: "alg.linear_inequality_order",
    itemFamilyId: "fam.alg.negative_scale_inequality",
    freshTransferFamilyId: "fam.alg.compound_negative_inequality_transfer",
    title: "Dividing an inequality by a negative factor without reversing order",
    misconceptionId: "mis.alg.omit_inequality_flip_on_negative_div",
    misconceptionDescription: "Applies negative scalar division to an inequality without reversing the order symbol.",
    missingPremise: "sign of divisor (-k < 0) reverses inequality direction",
    canonicalErrorSignal: "err.alg.negative_divisor_no_flip",
    distractorMisconception: {
      misconceptionId: "mis.alg.strict_vs_nonstrict_boundary",
      missingPremise: "preserving inclusive <= boundary",
      canonicalErrorSignal: "err.alg.boundary_strictness_swap",
      description: "Changes <= to < during division.",
    },
    ambiguousNotationSignal: "ambig.alg.interval_paren_vs_pair",
    clarificationCue: "Does your notation represent a coordinate pair or an open/closed real interval?",
    slipSignal: "slip.alg.arithmetic_quotient_typo",
    buildVariant(v: number): Stage0VariantInstance {
      const k = v + 2;
      const rhs = k * (v + 3);
      const bound = -(v + 3);
      return {
        variantIndex: v,
        prompt: `Solve -${k}x <= ${rhs} for real x.`,
        masteredWork: `Since -${k} < 0, dividing reverses <= to >=, giving x >= ${bound}.`,
        misconceptionWork: `Divide both sides by -${k} directly to keep <= and write x <= ${bound}.`,
        ambiguousWork: `(${bound}, inf) written without specifying interval vs ordered pair`,
        clarifiedWork: `Interval notation [${bound}, +infinity) for all real x satisfying x >= ${bound}.`,
        slipWork: `Dividing by -${k} reverses <= to >=, so x >= ${bound - 1} (copied quotient off by 1).`,
        repairedWork: `Check divisor sign (-${k} < 0), flip <= to >=, then simplify the quotient.`,
        wheelSpinWork: `I tried adding ${k} to both sides and got stuck on the minus sign.`,
        protectedAnswerTokens: [`x >= ${bound}`, `[${bound}, +inf)`, `BOUND_GE_${bound}`],
        protectedStepTokens: [`SEALED_INEQ_FLIP_${k}_${rhs}: x >= ${bound}`],
        analogCue: `Test -2 < 4 and multiply both sides by -1: what happens to the order between 2 and -4?`,
        freshTransferPrompt: `Solve -${k + 1}y + 4 > ${rhs + 4} for real y.`,
      };
    },
  },

  // 3. STEM Algebra — squaring radical equation without domain check
  {
    scenarioId: "stem_alg_extraneous_radical",
    domain: "stem_algebra",
    conceptId: "alg.radical_equation_domain",
    itemFamilyId: "fam.alg.sqrt_squaring",
    freshTransferFamilyId: "fam.alg.shifted_radical_domain_transfer",
    title: "Squaring radical equation without checking RHS non-negativity",
    misconceptionId: "mis.alg.unverified_squaring_extraneous_root",
    misconceptionDescription: "Squares both sides of sqrt(P(x)) = Q(x) without enforcing Q(x) >= 0, keeping extraneous roots.",
    missingPremise: "principal square root non-negativity constraint Q(x) >= 0",
    canonicalErrorSignal: "err.alg.extraneous_root_unchecked",
    distractorMisconception: {
      misconceptionId: "mis.alg.binomial_square_cross_term",
      missingPremise: "including middle term -2ab when squaring (x - b)",
      canonicalErrorSignal: "err.alg.freshmans_dream_square",
      description: "Expands (x - b)^2 as x^2 + b^2.",
    },
    ambiguousNotationSignal: "ambig.alg.sqrt_principal_vs_multivalued",
    clarificationCue: "Are you using sqrt(.) as the principal non-negative real root or a multivalued algebraic root?",
    slipSignal: "slip.alg.quadratic_constant_copy",
    buildVariant(v: number): Stage0VariantInstance {
      const c = v + 2; // sqrt(x + c^2 - c) = x - (c - 1)? Let's construct exact integer roots!
      // Choose roots r1 = c + 2 (valid), r2 = c - 3 (extraneous when RHS = x - c, since r2 - c = -3 < 0)
      // Wait: if RHS = x - c, then sqrt(A*x + B) = x - c => x^2 - 2cx + c^2 = A*x + B.
      // Let valid root r_valid = c + 2 => RHS = 2 >= 0 => LHS = 4.
      // Let extraneous root r_ext = c - 1 => RHS = -1 < 0 => RHS^2 = 1.
      // Line passing through (c+2, 4) and (c-1, 1): slope = (4-1)/3 = 1, y - 1 = 1*(x - (c-1)) => y = x - c + 2.
      // Check: at x = c+2: sqrt((c+2) - c + 2) = sqrt(4) = 2 = (c+2) - c. VALID!
      // At x = c-1: sqrt((c-1) - c + 2) = sqrt(1) = 1 != -1 = (c-1) - c. EXTRANEOUS!
      const validRoot = c + 2;
      const extraneousRoot = c - 1;
      const shift = 2 - c;
      const exprInside = shift >= 0 ? `x + ${shift}` : `x - ${-shift}`;
      return {
        variantIndex: v,
        prompt: `Solve sqrt(${exprInside}) = x - ${c} over R.`,
        masteredWork: `Require x - ${c} >= 0, square to get x in {${extraneousRoot}, ${validRoot}}, discard ${extraneousRoot}, leaving x = ${validRoot}.`,
        misconceptionWork: `Square both sides to get quadratic roots x = ${extraneousRoot} and x = ${validRoot}, so both are solutions.`,
        ambiguousWork: `+/-sqrt(${exprInside}) = x - ${c} => {${extraneousRoot}, ${validRoot}} (principal root convention unstated)`,
        clarifiedWork: `Under the multivalued +/-sqrt convention both satisfy +/-sqrt = x - ${c}; for principal sqrt only x >= ${c} holds.`,
        slipWork: `Enforced x >= ${c} and rejected ${extraneousRoot}, then miscopied the remaining root as ${validRoot + 1}.`,
        repairedWork: `Substitute each candidate back into x - ${c} >= 0 so principal square root matches RHS sign.`,
        wheelSpinWork: `I squared once, then took a square root again and went back to the start.`,
        protectedAnswerTokens: [
          `ONLY_ROOT_${validRoot}`,
          `x = ${validRoot} (reject ${extraneousRoot})`,
          `x = ${validRoot}`,
        ],
        protectedStepTokens: [`SEALED_RADICAL_FILTER_${c}: valid=${validRoot}, reject=${extraneousRoot}`],
        analogCue: `Can the principal square root sqrt(u) ever equal a negative number like -1?`,
        freshTransferPrompt: `Solve sqrt(w - ${c - 1}) = w - ${c + 1} and verify every candidate against the domain.`,
      };
    },
  },

  // 4. Linear Algebra — matrix cancellation AB = AC => B = C (AND ambiguous points/angles notation!)
  {
    scenarioId: "lin_alg_matrix_cancellation",
    domain: "linear_algebra",
    conceptId: "linalg.matrix_left_cancellation",
    itemFamilyId: "fam.linalg.matrix_equation_cancel",
    freshTransferFamilyId: "fam.linalg.block_invertibility_transfer",
    title: "Matrix cancellation AB = AC => B = C without invertibility guard",
    misconceptionId: "mis.linalg.cancel_singular_matrix",
    misconceptionDescription: "Cancels a left matrix factor A in AB = AC without proving A is invertible (det(A) != 0).",
    missingPremise: "invertibility of matrix A (det(A) != 0 / trivial nullspace)",
    canonicalErrorSignal: "err.linalg.singular_matrix_cancellation",
    distractorMisconception: {
      misconceptionId: "mis.linalg.matrix_commutativity",
      missingPremise: "non-commutativity AB != BA",
      canonicalErrorSignal: "err.linalg.assumed_commutativity",
      description: "Swaps matrix multiplication order AB = BA.",
    },
    ambiguousNotationSignal: "ambig.linalg.ab_ac_points_vs_angles_vs_matrices",
    clarificationCue: "In your expression 'AB = AC => B = C', do A, B, C denote geometric points/lengths, angles, real scalars, or matrices?",
    slipSignal: "slip.linalg.determinant_entry_copy",
    buildVariant(v: number): Stage0VariantInstance {
      const d = v + 2;
      return {
        variantIndex: v,
        prompt: `Given 2x2 matrices A = [[${d}, ${d}], [1, 1]], B, C with AB = AC, does B = C follow?`,
        masteredWork: `Since det(A) = ${d}*1 - ${d}*1 = 0, A is singular (non-trivial nullspace), so B = C does not follow.`,
        misconceptionWork: `Cancel A on both sides of AB = AC immediately to conclude B = C for any nonzero matrix A.`,
        ambiguousWork: `AB = AC => B = C`,
        clarifiedWork: `I was denoting collinear ray segments from A on the same half-line (not matrices), where equal directed distances imply B = C.`,
        slipWork: `Checked det(A) first, wrote ${d}*1 - ${d}*1 = 1 by arithmetic slip before realizing rows are proportional.`,
        repairedWork: `Test det(A) != 0 (or ker(A) = {0}) before cancelling A; here rows are proportional so det(A) = 0.`,
        wheelSpinWork: `I multiplied random 2x2 entries for B and C without knowing what property of A matters.`,
        protectedAnswerTokens: [`SINGULAR_NO_CANCEL_${d}`, `det(A) = 0 therefore B != C in general`],
        protectedStepTokens: [`SEALED_LINALG_CANCEL_${d}: A(B-C)=0 with ker(A)!=0`],
        analogCue: `In scalar arithmetic, if 0 * b = 0 * c, can you divide by 0? What is the matrix analog of a zero divisor?`,
        freshTransferPrompt: `Given rank-1 matrix M = [[${d + 1}, 2], [${2 * (d + 1)}, 4]] and MX = MY, construct X != Y.`,
      };
    },
  },

  // 5. Linear Algebra — zero vector as eigenvector
  {
    scenarioId: "lin_alg_eigenvalue_zero_vector",
    domain: "linear_algebra",
    conceptId: "linalg.eigenvector_nonzero_definition",
    itemFamilyId: "fam.linalg.eigen_definition",
    freshTransferFamilyId: "fam.linalg.eigenspace_basis_transfer",
    title: "Treating the zero vector as a valid eigenvector",
    misconceptionId: "mis.linalg.zero_vector_is_eigenvector",
    misconceptionDescription: "Claims v = 0 satisfies Av = lambda*v so every scalar is an eigenvalue.",
    missingPremise: "eigenvector non-zero requirement (v != 0) so det(A - lambda*I) = 0",
    canonicalErrorSignal: "err.linalg.zero_vector_eigen_claim",
    distractorMisconception: {
      misconceptionId: "mis.linalg.trace_det_swap",
      missingPremise: "characteristic polynomial sign (-tr(A)*lambda + det(A))",
      canonicalErrorSignal: "err.linalg.charpoly_sign_swap",
      description: "Reverses sign of trace in characteristic polynomial.",
    },
    ambiguousNotationSignal: "ambig.linalg.zero_scalar_vs_zero_vector",
    clarificationCue: "In your line '0 is an eigen value/vector', do you mean eigenvalue lambda = 0 or vector v = 0?",
    slipSignal: "slip.linalg.diagonal_entry_copy",
    buildVariant(v: number): Stage0VariantInstance {
      const lam1 = v + 1;
      const lam2 = v + 4;
      return {
        variantIndex: v,
        prompt: `Find the eigenvalues of diagonal matrix diag(${lam1}, ${lam2}) and explain why not every real lambda is an eigenvalue.`,
        masteredWork: `Eigenvectors must satisfy v != 0, so (A - lambda*I) must be singular; thus lambda in {${lam1}, ${lam2}}.`,
        misconceptionWork: `Plug v = 0 into Av = lambda*v: 0 = 0 holds for every lambda, so all real numbers are eigenvalues.`,
        ambiguousWork: `0 works for A*v = lambda*v (unclear whether 0 refers to lambda = 0 or v = 0)`,
        clarifiedWork: `I meant lambda = 0 can be an eigenvalue for a singular matrix, while v = 0 is excluded as an eigenvector.`,
        slipWork: `Used v != 0 and det(A - lambda*I) = 0, then copied ${lam2} as ${lam2 + 1} on the last line.`,
        repairedWork: `Exclude v = 0 by definition so we solve det(A - lambda*I) = 0 for non-trivial solutions.`,
        wheelSpinWork: `I tried inverting A instead of subtracting lambda*I and got lost.`,
        protectedAnswerTokens: [`EIGENVALS_${lam1}_${lam2}`, `lambda in {${lam1}, ${lam2}}`],
        protectedStepTokens: [`SEALED_EIGEN_${lam1}_${lam2}: (${lam1}-lam)(${lam2}-lam)=0`],
        analogCue: `If v = 0 were allowed as an eigenvector, what would happen to the set of eigenvalues of EVERY matrix?`,
        freshTransferPrompt: `Determine all eigenvalues of upper-triangular [[${lam1}, 5], [0, ${lam2 + 2}]] using non-trivial nullspace.`,
      };
    },
  },

  // 6. Linear Algebra — rank additivity rank(A + B) = rank(A) + rank(B)
  {
    scenarioId: "lin_alg_rank_sum_additivity",
    domain: "linear_algebra",
    conceptId: "linalg.rank_subadditivity",
    itemFamilyId: "fam.linalg.rank_bounds",
    freshTransferFamilyId: "fam.linalg.rank_cancellation_transfer",
    title: "Assuming rank(A + B) = rank(A) + rank(B) unconditionally",
    misconceptionId: "mis.linalg.rank_assumed_linear",
    misconceptionDescription: "Treats matrix rank as strictly additive instead of subadditive rank(A + B) <= rank(A) + rank(B).",
    missingPremise: "subadditivity inequality and possible column-space cancellation (e.g. B = -A)",
    canonicalErrorSignal: "err.linalg.rank_strict_additivity",
    distractorMisconception: {
      misconceptionId: "mis.linalg.rank_product_bound",
      missingPremise: "rank(AB) <= min(rank(A), rank(B))",
      canonicalErrorSignal: "err.linalg.rank_product_sum",
      description: "Adds ranks under multiplication.",
    },
    ambiguousNotationSignal: "ambig.linalg.direct_sum_vs_matrix_sum",
    clarificationCue: "Does '+' denote block direct sum (A oplus B) or entrywise matrix addition (A + B)?",
    slipSignal: "slip.linalg.dimension_index_typo",
    buildVariant(v: number): Stage0VariantInstance {
      const r = v + 1;
      const n = r + 2;
      return {
        variantIndex: v,
        prompt: `For ${n}x${n} matrices A, B each of rank ${r}, what is the tight range of rank(A + B)?`,
        masteredWork: `Subadditivity gives rank(A+B) <= min(${n}, ${2 * r}), and B = -A gives rank 0; range is [0, ${Math.min(n, 2 * r)}].`,
        misconceptionWork: `Rank is additive, so rank(A + B) is always equal to ${r} + ${r} = ${2 * r}.`,
        ambiguousWork: `rank(A + B) = rank(A) + rank(B) (using + for block direct sum without symbol)`,
        clarifiedWork: `For block-diagonal direct sum diag(A, B), rank adds strictly to ${2 * r}; for entrywise A + B it can drop to 0.`,
        slipWork: `Applied subadditivity and B = -A for lower bound 0, then wrote upper bound ${Math.min(n, 2 * r) + 1} by addition typo.`,
        repairedWork: `Check counterexample B = -A (rank 0) and cap upper bound by matrix dimension ${n}.`,
        wheelSpinWork: `I tried taking determinants of A + B even though A and B are rank-deficient.`,
        protectedAnswerTokens: [`RANK_RANGE_0_TO_${Math.min(n, 2 * r)}`, `[0, ${Math.min(n, 2 * r)}]`],
        protectedStepTokens: [`SEALED_RANK_BOUND_${n}_${r}: 0 <= rank(A+B) <= min(${n},${2 * r})`],
        analogCue: `Test the extreme case where B = -A: what is A + (-A) and what is its rank?`,
        freshTransferPrompt: `For ${n + 1}x${n + 1} matrices with rank(P)=${r + 1}, rank(Q)=${r}, bound rank(P + Q).`,
      };
    },
  },

  // 7. Calculus — chain rule omitting inner derivative
  {
    scenarioId: "calc_chain_rule_inner_deriv",
    domain: "calculus",
    conceptId: "calc.chain_rule",
    itemFamilyId: "fam.calc.composite_power_deriv",
    freshTransferFamilyId: "fam.calc.composite_trig_deriv_transfer",
    title: "Differentiating composite f(g(x)) without inner derivative g'(x)",
    misconceptionId: "mis.calc.omit_inner_derivative",
    misconceptionDescription: "Applies outer power/trig derivative to f(g(x)) while dropping the inner factor g'(x).",
    missingPremise: "multiplying by inner derivative g'(x) in d/dx[f(g(x))] = f'(g(x))*g'(x)",
    canonicalErrorSignal: "err.calc.missing_chain_inner_factor",
    distractorMisconception: {
      misconceptionId: "mis.calc.power_exponent_not_decremented",
      missingPremise: "reducing power exponent from n to n - 1",
      canonicalErrorSignal: "err.calc.power_exponent_unchanged",
      description: "Leaves exponent unchanged after differentiation.",
    },
    ambiguousNotationSignal: "ambig.calc.prime_wrt_u_vs_x",
    clarificationCue: "Does your prime notation denote d/du with respect to the inner expression u, or d/dx with respect to x?",
    slipSignal: "slip.calc.coefficient_product_typo",
    buildVariant(v: number): Stage0VariantInstance {
      const a = v + 2;
      const n = v + 3;
      const coeff = a * n;
      return {
        variantIndex: v,
        prompt: `Differentiate h(x) = (${a}x + 1)^${n} with respect to x.`,
        masteredWork: `By chain rule, h'(x) = ${n}(${a}x + 1)^${n - 1} * ${a} = ${coeff}(${a}x + 1)^${n - 1}.`,
        misconceptionWork: `Bring down exponent ${n}: h'(x) = ${n}(${a}x + 1)^${n - 1}.`,
        ambiguousWork: `h' = ${n}u^${n - 1} (derivative variable u vs x unstated)`,
        clarifiedWork: `With u = ${a}x + 1, dh/du = ${n}u^${n - 1}, and multiplying by du/dx = ${a} gives dh/dx.`,
        slipWork: `Applied chain rule ${n} * ${a} * (${a}x + 1)^${n - 1} and mis-multiplied ${n}*${a} as ${coeff + 2}.`,
        repairedWork: `Differentiate outer u^${n} and multiply by inner derivative d/dx(${a}x + 1) = ${a}.`,
        wheelSpinWork: `I tried expanding (${a}x + 1)^${n} term by term and lost track of binomial coefficients.`,
        protectedAnswerTokens: [`${coeff}(${a}x + 1)^${n - 1}`, `CHAIN_ANS_${coeff}_${a}_${n - 1}`],
        protectedStepTokens: [`SEALED_CHAIN_${a}_${n}: ${n}*(${a}x+1)^${n - 1}*${a}`],
        analogCue: `If u = 3x changes 3 times faster than x, how does the rate of change of u^2 with respect to x compare to d(u^2)/du?`,
        freshTransferPrompt: `Differentiate p(x) = sin(${a + 1}x^2 - 1) with respect to x.`,
      };
    },
  },

  // 8. Calculus — L'Hopital on non-indeterminate limit
  {
    scenarioId: "calc_lhopital_non_indeterminate",
    domain: "calculus",
    conceptId: "calc.lhopital_preconditions",
    itemFamilyId: "fam.calc.rational_limit_eval",
    freshTransferFamilyId: "fam.calc.trig_non_indeterminate_transfer",
    title: "Applying L'Hopital's rule to a non-indeterminate limit",
    misconceptionId: "mis.calc.lhopital_without_indeterminate_form",
    misconceptionDescription: "Differentiates numerator and denominator without first verifying 0/0 or inf/inf form.",
    missingPremise: "verifying 0/0 or inf/inf indeterminate form before L'Hopital",
    canonicalErrorSignal: "err.calc.lhopital_on_determinate_limit",
    distractorMisconception: {
      misconceptionId: "mis.calc.quotient_rule_confusion",
      missingPremise: "distinguishing ratio of derivatives from derivative of ratio",
      canonicalErrorSignal: "err.calc.lhopital_quotient_rule_mix",
      description: "Applies quotient rule inside L'Hopital.",
    },
    ambiguousNotationSignal: "ambig.calc.limit_point_shorthand",
    clarificationCue: "In your shorthand 'lim f/g = f'/g'', did you confirm direct substitution gives 0/0 at the target point?",
    slipSignal: "slip.calc.substitution_addition_slip",
    buildVariant(v: number): Stage0VariantInstance {
      const k = v + 2;
      const numVal = 1 + k;
      const denVal = 2 + k;
      return {
        variantIndex: v,
        prompt: `Evaluate lim_{x -> 1} (x^2 + ${k}) / (2x + ${k}).`,
        masteredWork: `Direct substitution yields ${numVal}/${denVal} (not 0/0), so L'Hopital does not apply; limit is ${numVal}/${denVal}.`,
        misconceptionWork: `Apply L'Hopital immediately: lim (2x)/(2) = 1.`,
        ambiguousWork: `ratio -> deriv ratio (omitted substitution check at x -> 1 vs x -> infinity)`,
        clarifiedWork: `For x -> infinity it is inf/inf; at x -> 1 the denominator is ${denVal} != 0 so direct substitution applies.`,
        slipWork: `Checked direct substitution (not 0/0): (1^2 + ${k}) / (2*1 + ${k}) copied as ${numVal}/${denVal + 1}.`,
        repairedWork: `Check direct substitution first: denominator ${denVal} != 0, so evaluate directly without L'Hopital.`,
        wheelSpinWork: `I differentiated twice and got 2/0 and did not know why it blew up.`,
        protectedAnswerTokens: [`${numVal}/${denVal}`, `LIMIT_DIRECT_${numVal}_${denVal}`],
        protectedStepTokens: [`SEALED_LHOPITAL_GUARD_${k}: direct=${numVal}/${denVal}`],
        analogCue: `Test L'Hopital blindly on lim_{x->0} (x+1)/(x+2): direct value is 1/2, while derivative ratio gives 1/1. Why did they disagree?`,
        freshTransferPrompt: `Evaluate lim_{x -> 0} (cos(x) + ${k}) / (x + ${k + 1}) and state whether L'Hopital applies.`,
      };
    },
  },

  // 9. Calculus — FTC with composite upper bound
  {
    scenarioId: "calc_ftc_variable_bounds",
    domain: "calculus",
    conceptId: "calc.ftc_chain_rule",
    itemFamilyId: "fam.calc.integral_upper_bound_deriv",
    freshTransferFamilyId: "fam.calc.integral_both_bounds_transfer",
    title: "Differentiating integral with variable upper limit g(x) without g'(x)",
    misconceptionId: "mis.calc.ftc_drops_bound_derivative",
    misconceptionDescription: "Replaces integrand variable t with upper bound g(x) without multiplying by g'(x).",
    missingPremise: "chain rule factor g'(x) for composite upper integration bound",
    canonicalErrorSignal: "err.calc.ftc_missing_bound_deriv",
    distractorMisconception: {
      misconceptionId: "mis.calc.ftc_lower_constant_not_zero",
      missingPremise: "derivative of constant lower bound is zero",
      canonicalErrorSignal: "err.calc.ftc_constant_bound_kept",
      description: "Subtracts f(a) even when lower bound a is constant.",
    },
    ambiguousNotationSignal: "ambig.calc.dummy_var_reuse",
    clarificationCue: "Is x in your integrand the integration dummy variable or the outer limit variable?",
    slipSignal: "slip.calc.bound_power_copy",
    buildVariant(v: number): Stage0VariantInstance {
      const m = v + 2;
      return {
        variantIndex: v,
        prompt: `Find d/dx [ integral from 0 to x^${m} of sqrt(1 + t^2) dt ].`,
        masteredWork: `By FTC + chain rule: sqrt(1 + (x^${m})^2) * d/dx(x^${m}) = ${m}x^${m - 1}*sqrt(1 + x^${2 * m}).`,
        misconceptionWork: `Substitute upper bound t = x^${m} directly to get sqrt(1 + x^${2 * m}).`,
        ambiguousWork: `d/du integral_0^u sqrt(1+t^2) dt = sqrt(1+u^2) (without writing u = x^${m} vs x)`,
        clarifiedWork: `With u = x^${m}, d/du gives sqrt(1+u^2), then multiplying by du/dx = ${m}x^${m - 1} completes d/dx.`,
        slipWork: `Used FTC * d/dx(x^${m}) and wrote ${m}x^${m}*sqrt(1 + x^${2 * m}) (forgot to subtract 1 from copied exponent).`,
        repairedWork: `Substitute t = x^${m} AND multiply by derivative of the upper limit d/dx(x^${m}).`,
        wheelSpinWork: `I tried finding an elementary antiderivative of sqrt(1 + t^2) first and got stuck.`,
        protectedAnswerTokens: [`${m}x^${m - 1}*sqrt(1 + x^${2 * m})`, `FTC_ANS_${m}_${2 * m}`],
        protectedStepTokens: [`SEALED_FTC_${m}: sqrt(1+x^${2 * m})*${m}x^${m - 1}`],
        analogCue: `If F'(u) = h(u), what is d/dx [F(g(x))] by the chain rule?`,
        freshTransferPrompt: `Find d/dx [ integral from 1 to ${m}x^2 of cos(t^3) dt ].`,
      };
    },
  },

  // 10. CS 408 — Off-by-one pointer / loop invariant step
  {
    scenarioId: "cs408_pointer_off_by_one",
    domain: "cs_408",
    conceptId: "cs408.linked_list_pointer_invariant",
    itemFamilyId: "fam.cs408.list_kth_pointer_step",
    freshTransferFamilyId: "fam.cs408.binary_search_boundary_transfer",
    title: "Off-by-one pointer advancement without loop-invariant / null check",
    misconceptionId: "mis.cs408.pointer_off_by_one_advance",
    misconceptionDescription: "Advances pointer k times instead of k - 1 (or dereferences past tail) without checking loop invariant and null guard.",
    missingPremise: "pointer step count invariant (k - 1 hops from head for 1-indexed node k) and p != NULL guard",
    canonicalErrorSignal: "err.cs408.pointer_off_by_one_no_null_guard",
    distractorMisconception: {
      misconceptionId: "mis.cs408.head_pointer_overwrite",
      missingPremise: "preserving head pointer using a traversal cursor",
      canonicalErrorSignal: "err.cs408.mutated_head_ref",
      description: "Mutates the list head reference instead of a local cursor.",
    },
    ambiguousNotationSignal: "ambig.cs408.zero_vs_one_based_index",
    clarificationCue: "Is your position k 0-indexed (head = 0) or 1-indexed (head = 1, or dummy sentinel header node)?",
    slipSignal: "slip.cs408.loop_counter_init_typo",
    buildVariant(v: number): Stage0VariantInstance {
      const k = v + 3;
      const hops = k - 1;
      return {
        variantIndex: v,
        prompt: `In a singly linked list without a dummy header (1-indexed), how many next-pointer hops from head reach node #${k}, and what guard prevents null dereference?`,
        masteredWork: `Starting at p = head (node 1), advance ${hops} hops while checking p != NULL before each p = p->next.`,
        misconceptionWork: `Loop i = 0..${k - 1} (${k} hops) and run p = p->next without checking p != NULL.`,
        ambiguousWork: `step ${k} times from head to reach node ${k} (dummy header vs 0-indexed unstated)`,
        clarifiedWork: `With a dummy sentinel header node at index 0, ${k} hops reach 1-indexed data node ${k}; without dummy header it is ${hops}.`,
        slipWork: `Stated ${hops} hops and p != NULL guard, then accidentally wrote loop bound i < ${hops + 1} in pseudocode.`,
        repairedWork: `Trace small case k=1 (0 hops from head) to derive k-1 hops and guard p != NULL before dereferencing.`,
        wheelSpinWork: `I keep switching between i <= k and i < k randomly hoping the sample matches.`,
        protectedAnswerTokens: [`HOPS_${hops}_GUARD_P_NE_NULL`, `${hops} hops with p != NULL`],
        protectedStepTokens: [`SEALED_PTR_INVARIANT_${k}: hops=${hops}, guard=p!=NULL`],
        analogCue: `Trace the base case k = 1 on a 1-node list without a dummy header: how many p = p->next hops are needed to stand on node 1?`,
        freshTransferPrompt: `In a 0-indexed array of length ${k + 5}, state the loop invariant for binary search on [lo, hi) so mid never indexes out of bounds.`,
      };
    },
  },

  // 11. CS 408 — Stack push/pop permutation invariant
  {
    scenarioId: "cs408_stack_pop_order_invariant",
    domain: "cs_408",
    conceptId: "cs408.stack_lifo_permutation",
    itemFamilyId: "fam.cs408.stack_output_validity",
    freshTransferFamilyId: "fam.cs408.deque_output_order_transfer",
    title: "Checking stack pop sequence without LIFO 2-3-1 inversion invariant",
    misconceptionId: "mis.cs408.ignore_lifo_inversion_rule",
    misconceptionDescription: "Claims any permutation starting with a pushed element is valid without checking that smaller elements remaining in stack must pop in descending order.",
    missingPremise: "LIFO ordering constraint: after popping x, all unpopped elements smaller than x must appear in decreasing order",
    canonicalErrorSignal: "err.cs408.lifo_231_pattern_missed",
    distractorMisconception: {
      misconceptionId: "mis.cs408.stack_must_fill_completely",
      missingPremise: "interleaved push and pop operations are allowed",
      canonicalErrorSignal: "err.cs408.no_interleaved_pop",
      description: "Assumes all items must be pushed before any pop.",
    },
    ambiguousNotationSignal: "ambig.cs408.push_order_direction",
    clarificationCue: "Are elements pushed in ascending order 1..n from left to right, or is the sequence showing stack top-to-bottom snapshot?",
    slipSignal: "slip.cs408.sequence_digit_copy",
    buildVariant(v: number): Stage0VariantInstance {
      const n = v + 4;
      const pivot = v + 3;
      const small1 = 1;
      const small2 = 2;
      return {
        variantIndex: v,
        prompt: `Given push order 1..${n} into an initially empty stack, is a pop sequence starting with [${pivot}, ${small1}, ${small2}, ...] legal?`,
        masteredWork: `Illegal: to pop ${pivot} first, both ${small1} and ${small2} are already stacked with ${small2} above ${small1}, so ${small1} cannot pop before ${small2}.`,
        misconceptionWork: `Legal, because ${pivot} can be pushed and popped, then ${small1} and ${small2} can pop in any order.`,
        ambiguousWork: `[${pivot}, ${small1}, ${small2}] valid (unclear if input order was reversed or snapshot)`,
        clarifiedWork: `Under ascending push order 1..${n}, the LIFO order forces ${small2} before ${small1} once ${pivot} pops.`,
        slipWork: `Identified ${small2} sits above ${small1} in stack, then accidentally wrote 'legal' instead of 'illegal' in the summary.`,
        repairedWork: `Track stack contents when ${pivot} is popped: smaller items [${small1}, ${small2}] must exit in strict descending order.`,
        wheelSpinWork: `I tried listing all ${n}! permutations and lost count.`,
        protectedAnswerTokens: [`ILLEGAL_LIFO_${pivot}_${small1}_${small2}`, `illegal because ${small2} blocks ${small1}`],
        protectedStepTokens: [`SEALED_STACK_LIFO_${n}_${pivot}: stack_has_${small2}_above_${small1}`],
        analogCue: `Once item 3 has been popped from push order 1, 2, 3, which of 1 and 2 is sitting on top of the stack?`,
        freshTransferPrompt: `With push order 1..${n + 1}, verify whether [${pivot + 1}, ${small2}, ${small1}, ...] is a legal stack pop sequence.`,
      };
    },
  },

  // 12. CS 408 — Page replacement FIFO & Belady anomaly
  {
    scenarioId: "cs408_page_replacement_belady",
    domain: "cs_408",
    conceptId: "cs408.os_page_replacement",
    itemFamilyId: "fam.cs408.fifo_belady_anomaly",
    freshTransferFamilyId: "fam.cs408.lru_stack_inclusion_transfer",
    title: "Assuming FIFO satisfies the stack inclusion property (no Belady anomaly)",
    misconceptionId: "mis.cs408.assume_fifo_monotonic_faults",
    misconceptionDescription: "Assumes adding physical frames always decreases or preserves page faults under FIFO.",
    missingPremise: "stack inclusion property (LRU/OPT have it; FIFO does not, enabling Belady's anomaly)",
    canonicalErrorSignal: "err.cs408.fifo_assumed_stack_algorithm",
    distractorMisconception: {
      misconceptionId: "mis.cs408.cold_miss_excluded",
      missingPremise: "counting compulsory initial page faults",
      canonicalErrorSignal: "err.cs408.cold_miss_omitted",
      description: "Omits initial empty-frame faults from total count.",
    },
    ambiguousNotationSignal: "ambig.cs408.lru_vs_fifo_queue",
    clarificationCue: "In your notes 'queue eviction avoids anomaly', did you mean FIFO arrival queue or LRU recency stack?",
    slipSignal: "slip.cs408.fault_tally_arithmetic",
    buildVariant(v: number): Stage0VariantInstance {
      const fLow = 3;
      const fHigh = 4;
      const offset = v;
      return {
        variantIndex: v,
        prompt: `For reference string offset +${offset} of (1,2,3,4,1,2,5,1,2,3,4,5), can increasing FIFO frames from ${fLow} to ${fHigh} increase page faults?`,
        masteredWork: `Yes: FIFO lacks the stack inclusion property and exhibits Belady's anomaly (9 faults at 3 frames vs 10 faults at 4 frames).`,
        misconceptionWork: `No: more memory frames always strictly reduce or maintain page faults for every replacement algorithm including FIFO.`,
        ambiguousWork: `recency/arrival queue prevents Belady anomaly (algorithm name omitted)`,
        clarifiedWork: `LRU satisfies stack inclusion so faults never increase; FIFO lacks inclusion so Belady's anomaly occurs.`,
        slipWork: `Explained FIFO lacks stack inclusion and shows Belady's anomaly, then tallied 10 faults as 11 by counting slip.`,
        repairedWork: `Check stack inclusion: pages held in 3 frames are not always a subset of pages held in 4 frames under FIFO.`,
        wheelSpinWork: `I guessed 4 frames has fewer faults without simulating which page gets evicted on reference 5.`,
        protectedAnswerTokens: [`BELADY_YES_9_TO_10_OFF_${offset}`, `FIFO_9_vs_10_faults`],
        protectedStepTokens: [`SEALED_BELADY_${offset}: fifo_not_stack_algo_9_to_10`],
        analogCue: `For an algorithm to guarantee faults never rise with extra frames, what subset relation must hold between k frames and k+1 frames?`,
        freshTransferPrompt: `Prove why LRU cannot suffer Belady's anomaly when moving from ${fLow + 1} to ${fHigh + 1} frames.`,
      };
    },
  },

  // 13. CS 408 — TCP congestion control (3-dup ACK vs timeout)
  {
    scenarioId: "cs408_tcp_cwnd_ssthresh",
    domain: "cs_408",
    conceptId: "cs408.tcp_congestion_control",
    itemFamilyId: "fam.cs408.tcp_reno_fast_recovery",
    freshTransferFamilyId: "fam.cs408.tcp_timeout_slow_start_transfer",
    title: "Conflating TCP Reno 3-duplicate-ACK fast recovery with RTO timeout reset",
    misconceptionId: "mis.cs408.tcp_3dupack_resets_cwnd_to_1",
    misconceptionDescription: "Resets cwnd to 1 MSS on 3 duplicate ACKs under TCP Reno instead of halving to ssthresh.",
    missingPremise: "TCP Reno distinguishes 3-dup-ACK (fast recovery: cwnd = ssthresh = cwnd/2) from RTO timeout (cwnd = 1 MSS)",
    canonicalErrorSignal: "err.cs408.tcp_reno_3dupack_reset_1",
    distractorMisconception: {
      misconceptionId: "mis.cs408.tcp_linear_growth_in_slow_start",
      missingPremise: "exponential cwnd doubling during slow start",
      canonicalErrorSignal: "err.cs408.slow_start_linear",
      description: "Increments cwnd by 1 MSS per RTT during slow start.",
    },
    ambiguousNotationSignal: "ambig.cs408.tcp_tahoe_vs_reno_variant",
    clarificationCue: "Are you applying TCP Tahoe (resets cwnd = 1 on 3-dup-ACK) or TCP Reno (fast recovery cwnd = ssthresh)?",
    slipSignal: "slip.cs408.half_cwnd_division_typo",
    buildVariant(v: number): Stage0VariantInstance {
      const cwnd = 16 + v * 4;
      const half = cwnd / 2;
      return {
        variantIndex: v,
        prompt: `Under TCP Reno, if cwnd = ${cwnd} MSS and 3 duplicate ACKs arrive, what are the new ssthresh and cwnd?`,
        masteredWork: `TCP Reno fast recovery sets ssthresh = ${half} MSS and cwnd = ${half} MSS (avoiding reset to 1 MSS).`,
        misconceptionWork: `On 3 duplicate ACKs, set ssthresh = ${half} and always drop cwnd down to 1 MSS.`,
        ambiguousWork: `3-dup-ACK => cwnd = 1 MSS (TCP Tahoe vs Reno variant unspecified)`,
        clarifiedWork: `Under TCP Tahoe cwnd resets to 1 MSS; under TCP Reno fast recovery enters congestion avoidance at ${half} MSS.`,
        slipWork: `Used TCP Reno fast recovery ssthresh = cwnd = cwnd/2, then divided ${cwnd}/2 as ${half + 1} by slip.`,
        repairedWork: `Distinguish 3-dup-ACK (network still delivering packets -> Reno halves cwnd) from full timeout (cwnd = 1).`,
        wheelSpinWork: `I forgot whether ssthresh stays fixed or halves and kept guessing random numbers.`,
        protectedAnswerTokens: [`RENO_SSTHRESH_${half}_CWND_${half}`, `ssthresh=${half}, cwnd=${half}`],
        protectedStepTokens: [`SEALED_TCP_RENO_${cwnd}: ssthresh=${half}; cwnd=${half}`],
        analogCue: `Why does receiving 3 duplicate ACKs indicate milder congestion than a retransmission timeout?`,
        freshTransferPrompt: `Under TCP Reno at cwnd = ${cwnd + 8} MSS, compare new (ssthresh, cwnd) after an RTO timeout vs 3 duplicate ACKs.`,
      };
    },
  },

  // 14. Language — counterfactual conditional / subjunctive mood
  {
    scenarioId: "lang_subjunctive_counterfactual",
    domain: "language",
    conceptId: "lang.counterfactual_conditional_mood",
    itemFamilyId: "fam.lang.third_conditional_syntax",
    freshTransferFamilyId: "fam.lang.mixed_counterfactual_transfer",
    title: "Using simple past/would in both clauses of a past counterfactual conditional",
    misconceptionId: "mis.lang.double_would_in_if_clause",
    misconceptionDescription: "Places 'would have' inside the past counterfactual if-clause instead of past perfect 'had + past participle'.",
    missingPremise: "past counterfactual if-clause requires past perfect ('had + V3'), reserving 'would have + V3' for the main clause",
    canonicalErrorSignal: "err.lang.if_clause_modal_would_have",
    distractorMisconception: {
      misconceptionId: "mis.lang.present_simple_main_clause",
      missingPremise: "modal backshift in main result clause",
      canonicalErrorSignal: "err.lang.no_modal_backshift",
      description: "Uses 'will' in an unreal conditional main clause.",
    },
    ambiguousNotationSignal: "ambig.lang.register_colloquial_vs_formal",
    clarificationCue: "Are you aiming for formal academic English syntax or transcribing informal spoken usage?",
    slipSignal: "slip.lang.past_participle_spelling",
    buildVariant(v: number): Stage0VariantInstance {
      const subjects = ["Elena", "Marcus", "Priya", "Devon", "Sora", "Nadia", "Liam", "Tessa"];
      const subj = subjects[v % subjects.length] ?? "Elena";
      return {
        variantIndex: v,
        prompt: `Correct the formal counterfactual sentence: "If ${subj} would have reviewed the proof, ${subj} would have spotted the gap."`,
        masteredWork: `Use past perfect in the if-clause: "If ${subj} had reviewed the proof, ${subj} would have spotted the gap."`,
        misconceptionWork: `Keep "would have reviewed" in the if-clause so both clauses mirror "would have".`,
        ambiguousWork: `"If ${subj} would have reviewed..." (spoken colloquial register vs formal grammar unspecified)`,
        clarifiedWork: `For formal academic prose, the if-clause takes past perfect "had reviewed" while the result clause keeps "would have spotted".`,
        slipWork: `Changed if-clause to past perfect "had" and accidentally typed "had review" (dropped -ed suffix).`,
        repairedWork: `Place past perfect "had + past participle" in the condition clause and keep "would have" only in the result clause.`,
        wheelSpinWork: `I swapped "would" for "will" and "has" randomly without knowing which clause carries the modal.`,
        protectedAnswerTokens: [`If ${subj} had reviewed the proof`, `COUNTERFACTUAL_HAD_REVIEWED_${subj}`],
        protectedStepTokens: [`SEALED_SUBJ_${subj}: if-clause=had+V3; main=would_have+V3`],
        analogCue: `In "If it had rained, we would have stayed inside", which clause carries "had" and which carries "would have"?`,
        freshTransferPrompt: `Rewrite as a formal past counterfactual: "${subj} missed the train because ${subj} left late."`,
      };
    },
  },

  // 15. Language — dangling participial modifier
  {
    scenarioId: "lang_dangling_participle_subject",
    domain: "language",
    conceptId: "lang.participial_modifier_attachment",
    itemFamilyId: "fam.lang.dangling_modifier_repair",
    freshTransferFamilyId: "fam.lang.prepositional_gerund_subject_transfer",
    title: "Dangling initial participial phrase mismatched with main clause subject",
    misconceptionId: "mis.lang.dangling_modifier_subject_mismatch",
    misconceptionDescription: "Leaves an inanimate object as the main clause subject directly after an agentive participial phrase.",
    missingPremise: "subject alignment: the grammatical subject immediately after the comma must be the actor performing the participle",
    canonicalErrorSignal: "err.lang.dangling_participle_actor_mismatch",
    distractorMisconception: {
      misconceptionId: "mis.lang.comma_splice_confusion",
      missingPremise: "distinguishing introductory phrase comma from comma splice",
      canonicalErrorSignal: "err.lang.removed_intro_comma",
      description: "Removes the introductory phrase comma instead of fixing subject alignment.",
    },
    ambiguousNotationSignal: "ambig.lang.ellipsis_headline_style",
    clarificationCue: "Is this intended as compressed headline shorthand or a standard complete academic sentence?",
    slipSignal: "slip.lang.pronoun_number_typo",
    buildVariant(v: number): Stage0VariantInstance {
      const artifacts = ["report", "dataset", "blueprint", "manuscript", "ledger", "circuit", "memo", "protocol"];
      const noun = artifacts[v % artifacts.length] ?? "report";
      return {
        variantIndex: v,
        prompt: `Revise to eliminate the dangling modifier: "Walking into the lab, the ${noun} appeared unfinished."`,
        masteredWork: `Make the human actor the main subject: "Walking into the lab, the researcher noticed the ${noun} appeared unfinished."`,
        misconceptionWork: `The sentence is fine because the reader knows a person walked in and the ${noun} is near the verb.`,
        ambiguousWork: `"Walking into the lab, the ${noun}..." (telegraphic diary shorthand vs formal syntax unstated)`,
        clarifiedWork: `In formal syntax the subject after the comma must be the walker (e.g., "the researcher"), not "the ${noun}".`,
        slipWork: `Named the human actor right after the comma ("the researchers") and left singular verb "notices" by copy slip.`,
        repairedWork: `Align the grammatical subject right after the comma with who is performing "Walking into the lab".`,
        wheelSpinWork: `I only swapped "appeared" to "seemed" without changing the subject after the comma.`,
        protectedAnswerTokens: [`SUBJECT_ALIGN_RESEARCHER_${noun}`, `Walking into the lab, the researcher`],
        protectedStepTokens: [`SEALED_MODIFIER_${noun}: main_subject_must_be_actor_not_${noun}`],
        analogCue: `Ask literally: in "Opening the door, the lamp fell", who does the grammar claim opened the door?`,
        freshTransferPrompt: `Fix the dangling modifier: "After calibrating the sensor for hours, the readings finally stabilized."`,
      };
    },
  },

  // 16. Language / Logic — quantifier scope negation ("All X are Y")
  {
    scenarioId: "lang_quantifier_scope_negation",
    domain: "language",
    conceptId: "lang.universal_quantifier_negation",
    itemFamilyId: "fam.lang.demorgan_quantifier_negation",
    freshTransferFamilyId: "fam.lang.nested_quantifier_negation_transfer",
    title: "Negating 'All X are Y' as 'No X are Y' instead of 'Some X are not Y'",
    misconceptionId: "mis.lang.universal_negation_contrary_confusion",
    misconceptionDescription: "Confuses logical negation (contradictory: at least one counterexample) with universal contrary ('No X are Y').",
    missingPremise: "De Morgan quantifier duality: NOT(forall x, P(x)) <=> exists x, NOT P(x) (one counterexample suffices)",
    canonicalErrorSignal: "err.lang.all_negated_as_none",
    distractorMisconception: {
      misconceptionId: "mis.lang.converse_implication_swap",
      missingPremise: "preserving direction X -> Y rather than Y -> X",
      canonicalErrorSignal: "err.lang.quantifier_converse_swap",
      description: "Rewrites 'All X are Y' as 'All Y are X'.",
    },
    ambiguousNotationSignal: "ambig.lang.colloquial_all_not_scope",
    clarificationCue: "When you wrote 'All X are not Y', did you mean 'Not all X are Y' (some aren't) or 'None of X are Y'?",
    slipSignal: "slip.lang.double_negative_copy",
    buildVariant(v: number): Stage0VariantInstance {
      const pairs: readonly (readonly [string, string])[] = [
        ["primes", "odd"],
        ["birds", "capable of flight"],
        ["continuous functions", "differentiable"],
        ["graphs", "planar"],
        ["matrices", "invertible"],
        ["sorting algorithms", "stable"],
        ["polygons", "convex"],
        ["proofs", "constructive"],
      ];
      const pair = pairs[v % pairs.length] ?? ["primes", "odd"];
      const [xs, prop] = pair;
      return {
        variantIndex: v,
        prompt: `Write the exact logical negation of "All ${xs} are ${prop}."`,
        masteredWork: `By quantifier duality, the negation is "At least one ${xs} item (some ${xs}) is not ${prop}."`,
        misconceptionWork: `The opposite of "All ${xs} are ${prop}" is "No ${xs} are ${prop}."`,
        ambiguousWork: `"All ${xs} are not ${prop}" (negation scope over 'all' vs predicate unstated)`,
        clarifiedWork: `Clarified scope: "Not all ${xs} are ${prop}", i.e. "Some ${xs} are not ${prop}" (not "No ${xs} are ${prop}").`,
        slipWork: `Used existential counterexample form and accidentally typed "Some ${xs} are not un-${prop}" (double-negation typo).`,
        repairedWork: `Apply De Morgan duality: negating a universal claim only requires a single counterexample ("some are not").`,
        wheelSpinWork: `I swapped the subject and predicate instead of changing the quantifier.`,
        protectedAnswerTokens: [`NEGATION_SOME_NOT_${xs}_${prop}`, `Some ${xs} are not ${prop}`],
        protectedStepTokens: [`SEALED_QUANT_${xs}: exists_x_not_${prop}`],
        analogCue: `How many counterexamples do you need to disprove "Every card in this deck is red"? Must every card be black?`,
        freshTransferPrompt: `Write the exact logical negation of "Every student in the seminar passed every quiz."`,
      };
    },
  },
]);

export const STAGE0_SCENARIOS: readonly Stage0Scenario[] = deepFreeze(
  INTERNAL_STAGE0_SCENARIOS.map((scenario) => cloneAndFreezeScenario(scenario)),
);

export function generateStage0Episodes(
  seed: number = STAGE0_DEFAULT_SEED,
  maxTurns: number = STAGE0_DEFAULT_MAX_TURNS,
): readonly Stage0EpisodeSpec[] {
  const episodes: Stage0EpisodeSpec[] = [];
  let index = 0;

  for (const canonicalScenario of INTERNAL_STAGE0_SCENARIOS) {
    for (const personaId of STAGE0_PERSONA_IDS) {
      const profile = getCanonicalStage0PersonaProfile(personaId);
      for (let variantIndex = 0; variantIndex < STAGE0_VARIANTS_PER_PAIR; variantIndex += 1) {
        const variant = cloneAndFreezeVariant(canonicalScenario.buildVariant(variantIndex));
        const scenarioClone = cloneAndFreezeScenario(canonicalScenario);
        const candidateMisconceptions = deepFreeze([
          {
            misconceptionId: canonicalScenario.misconceptionId,
            missingPremise: canonicalScenario.missingPremise,
            canonicalErrorSignal: canonicalScenario.canonicalErrorSignal,
            description: canonicalScenario.misconceptionDescription,
          },
          {
            misconceptionId: canonicalScenario.distractorMisconception.misconceptionId,
            missingPremise: canonicalScenario.distractorMisconception.missingPremise,
            canonicalErrorSignal: canonicalScenario.distractorMisconception.canonicalErrorSignal,
            description: canonicalScenario.distractorMisconception.description,
          },
        ]);
        const episodeId = `ep_${canonicalScenario.scenarioId}__${personaId}__v${variantIndex}`;
        const episodeSeed = hashSeed32(`${seed >>> 0}:${episodeId}`);

        episodes.push(
          deepFreeze({
            episodeId,
            index,
            seed: episodeSeed,
            scenarioId: canonicalScenario.scenarioId,
            domain: canonicalScenario.domain,
            conceptId: canonicalScenario.conceptId,
            itemFamilyId: canonicalScenario.itemFamilyId,
            freshTransferFamilyId: canonicalScenario.freshTransferFamilyId,
            personaId,
            variantIndex,
            prompt: variant.prompt,
            groundTruthMisconceptionId: profile.hasPersistentMisconception
              ? canonicalScenario.misconceptionId
              : null,
            missingPremise: canonicalScenario.missingPremise,
            isCarelessSlip: personaId === "careless_transcription_slip",
            isAmbiguousNotation: personaId === "ambiguous_notation",
            remediationTarget: profile.remediationTarget,
            candidateMisconceptions,
            protectedAnswerTokens: [...variant.protectedAnswerTokens],
            protectedStepTokens: [...variant.protectedStepTokens],
            variant,
            scenario: scenarioClone,
            maxTurns,
          }),
        );
        index += 1;
      }
    }
  }

  return Object.freeze(episodes);
}
