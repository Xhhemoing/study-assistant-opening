/**
 * Original, copyright-clean IELTS Academic Writing Task 2 sentinel anchor essays
 * and 3-way anti-padding counterfactual triplets for AnchorCalibratedRubricV1.
 */

export const RUBRIC_DIMENSIONS = [
  "task_response",
  "coherence_cohesion",
  "lexical_resource",
  "grammatical_range_accuracy",
] as const;

export type RubricDimension = (typeof RUBRIC_DIMENSIONS)[number];

export const SENTINEL_BANDS = [4.5, 5.0, 6.0, 6.5, 7.5, 8.0] as const;
export type SentinelBand = (typeof SENTINEL_BANDS)[number];

export type SentinelTier = "low" | "mid" | "high";

export const BRADLEY_TERRY_CENTER_BAND = 6.25;
export const BRADLEY_TERRY_SLOPE = 4.0;

export function thetaFromBand(band: number): number {
  return BRADLEY_TERRY_SLOPE * (band - BRADLEY_TERRY_CENTER_BAND);
}

export function bandFromTheta(theta: number): number {
  return BRADLEY_TERRY_CENTER_BAND + theta / BRADLEY_TERRY_SLOPE;
}

export interface DimensionAnchorDescriptor {
  readonly band: SentinelBand;
  readonly thetaAnchor: number;
  readonly criterionNote: string;
}

export interface SentinelAnchorEssay {
  readonly essayId: string;
  readonly band: SentinelBand;
  readonly tier: SentinelTier;
  readonly thetaAnchor: number;
  readonly prompt: string;
  readonly text: string;
  readonly dimensions: Readonly<Record<RubricDimension, DimensionAnchorDescriptor>>;
}

export interface DimensionSentinelAnchor {
  readonly anchorId: string;
  readonly essayId: string;
  readonly dimension: RubricDimension;
  readonly band: SentinelBand;
  readonly tier: SentinelTier;
  readonly thetaAnchor: number;
  readonly prompt: string;
  readonly text: string;
  readonly criterionNote: string;
}

export interface AntiPaddingCounterfactualTriplet {
  readonly tripletId: string;
  readonly prompt: string;
  readonly targetDimension: RubricDimension;
  readonly substantiveConcise: string;
  readonly templatePaddedExpansion: string;
  readonly equalLengthSubstantive: string;
}

export const SENTINEL_ESSAY_PROMPT =
  "Many cities subsidize public transit fares while raising central-district parking charges for private cars. " +
  "To what extent do the environmental and equity benefits outweigh the burdens placed on outer-suburb commuters?";

function buildDimensions(
  band: SentinelBand,
  notes: Readonly<Record<RubricDimension, string>>,
): Readonly<Record<RubricDimension, DimensionAnchorDescriptor>> {
  const thetaAnchor = thetaFromBand(band);
  return {
    task_response: { band, thetaAnchor, criterionNote: notes.task_response },
    coherence_cohesion: { band, thetaAnchor, criterionNote: notes.coherence_cohesion },
    lexical_resource: { band, thetaAnchor, criterionNote: notes.lexical_resource },
    grammatical_range_accuracy: { band, thetaAnchor, criterionNote: notes.grammatical_range_accuracy },
  };
}

export const SENTINEL_ANCHOR_ESSAYS: readonly SentinelAnchorEssay[] = [
  {
    essayId: "sentinel-b45-transit",
    band: 4.5,
    tier: "low",
    thetaAnchor: thetaFromBand(4.5),
    prompt: SENTINEL_ESSAY_PROMPT,
    text:
      "City bus is cheap now and car parking cost more money in city center. Many people drive car every day because they live far and bus is slow. " +
      "I think this is hard for workers who wake up early. Some people like bus because air become clean and road have less traffic. " +
      "Car make smoke and noise so city try to stop too many car. But outer area not have enough train station, so people angry when pay high fee. " +
      "Government should think about driver and make good bus before charge money.",
    dimensions: buildDimensions(4.5, {
      task_response: "Addresses topic tangentially with undeveloped generalizations and unclear weighing of extent.",
      coherence_cohesion: "Single dense block lacking clear paragraph progression and relying on basic conjunctions.",
      lexical_resource: "Limited everyday vocabulary with repetitive phrasing and imprecise collocations.",
      grammatical_range_accuracy: "Frequent agreement, article, and auxiliary errors in mostly simple clauses.",
    }),
  },
  {
    essayId: "sentinel-b50-transit",
    band: 5.0,
    tier: "low",
    thetaAnchor: thetaFromBand(5.0),
    prompt: SENTINEL_ESSAY_PROMPT,
    text:
      "Cities are reducing public transport ticket prices and increasing central parking fees. I partly agree that this policy helps the environment, although it creates problems for suburban drivers.\n\n" +
      "Firstly, lower fares encourage office workers to take trains and buses instead of driving. This reduces air pollution and traffic jams in busy downtown streets. Poorer residents can also travel to work more cheaply.\n\n" +
      "Secondly, commuters from outer suburbs face higher daily expenses because public routes near their homes are often infrequent. They must spend more time or pay expensive parking fees.\n\n" +
      "In conclusion, cheaper transit helps clean the air, but governments should improve suburban routes so drivers do not suffer unfairly.",
    dimensions: buildDimensions(5.0, {
      task_response: "States a recognizable position with relevant points, though arguments remain brief and under-supported.",
      coherence_cohesion: "Clear paragraph breaks using mechanical sequencers with limited internal referencing.",
      lexical_resource: "Adequate common topic words with limited precision and few less-common collocations.",
      grammatical_range_accuracy: "Readable simple and basic compound sentences with limited structural variety.",
    }),
  },
  {
    essayId: "sentinel-b60-transit",
    band: 6.0,
    tier: "mid",
    thetaAnchor: thetaFromBand(6.0),
    prompt: SENTINEL_ESSAY_PROMPT,
    text:
      "Subsidizing public transit while raising downtown parking charges is an increasingly common urban policy. Overall, I believe its environmental and social gains outweigh the burdens on outer-suburb commuters, provided cities reinvest parking revenue into peripheral transit links.\n\n" +
      "Lower fares directly reduce transport costs for low-income workers and students who depend on buses and rail. At the same time, pricier central parking discourages discretionary solo car trips, which eases peak congestion and lowers roadside nitrogen oxide emissions across densely populated inner neighborhoods.\n\n" +
      "Nevertheless, outer-suburb residents often lack reliable feeder buses or nearby park-and-ride lots. For shift workers or parents managing school drop-offs, higher central parking fees act like a flat charge they cannot easily avoid without adding long transfers to their day.\n\n" +
      "Therefore, the policy delivers net public benefits when parking fees fund frequent suburban express routes and peripheral transfer hubs, turning a short-term commuter burden into broader network access.",
    dimensions: buildDimensions(6.0, {
      task_response: "Clear thesis addressing both environmental/equity gains and suburban burdens with plausible mechanisms.",
      coherence_cohesion: "Logical four-paragraph arc with functional transitions and clear topic sentences.",
      lexical_resource: "Topic-appropriate vocabulary ('discretionary', 'feeder buses', 'flat charge') with occasional stiffness.",
      grammatical_range_accuracy: "Controlled mix of complex and compound clauses with accurate punctuation and agreement.",
    }),
  },
  {
    essayId: "sentinel-b65-transit",
    band: 6.5,
    tier: "mid",
    thetaAnchor: thetaFromBand(6.5),
    prompt: SENTINEL_ESSAY_PROMPT,
    text:
      "Pairing subsidized public transit with steeper central parking fees shifts the true spatial cost of private cars onto drivers while expanding affordable mobility. On balance, these environmental and equity advantages outweigh suburban commuter burdens when the policy is sequenced alongside outer-ring transit upgrades.\n\n" +
      "The primary gain is dual: lower fares widen job access for lower-wage residents who already rely on buses, while priced parking curbs peak vehicle volume in congested corridors. Because downtown road space is scarce, even a modest shift from private sedans to high-capacity buses speeds up remaining bus lanes and reduces fine particulate exposure near schools and clinics.\n\n" +
      "Critics rightly note that outer-suburb households often chose distant housing precisely because inner neighborhoods were unaffordable. Penalizing their commute before offering reliable park-and-ride stations or off-peak rail frequencies risks making the policy regressive for tradespeople and night-shift staff.\n\n" +
      "In sum, the environmental and equity payoff exceeds the suburban cost only if municipalities dedicate parking surcharges to expanding outer-ring feeder networks and targeted exemptions for off-hour essential workers.",
    dimensions: buildDimensions(6.5, {
      task_response: "Well-focused argument evaluating conditional trade-offs with concrete stakeholder distinctions.",
      coherence_cohesion: "Smooth progression across paragraphs with cohesive lexical links and clear pronoun reference.",
      lexical_resource: "Confident use of policy and urban-planning collocations with strong clarity.",
      grammatical_range_accuracy: "Consistent control of subordination, participial clauses, and conditional framing.",
    }),
  },
  {
    essayId: "sentinel-b75-transit",
    band: 7.5,
    tier: "high",
    thetaAnchor: thetaFromBand(7.5),
    prompt: SENTINEL_ESSAY_PROMPT,
    text:
      "Cross-subsidizing transit fares through higher central-district parking charges addresses two linked urban market failures: unpriced roadway congestion and unequal access to employment centers. While outer-suburb motorists absorb tangible transitional costs, the long-run environmental and distributional gains substantially outweigh those burdens whenever revenue is ring-fenced for peripheral connectivity.\n\n" +
      "Environmentally, pricing scarce downtown curb space targets trips most likely to have viable rail or bus substitutes. Removing marginal peak-hour vehicles yields non-linear relief: bus travel times drop, service reliability improves, and urban particulate concentrations fall most sharply in dense inner corridors where lower-income renters disproportionately live. Subsidized fares simultaneously convert that cleaner capacity into direct household savings.\n\n" +
      "The equity objection from outer suburbs nonetheless merits design safeguards rather than dismissal. Households displaced to the urban fringe by housing prices often face sparse bus headways, meaning punitive parking tariffs alone operate regressively unless paired with subsidized perimeter park-and-ride lots, integrated fare caps, and off-peak rebates for shift workers.\n\n" +
      "Consequently, the policy's net welfare balance depends on institutional execution: when parking surcharges finance suburban feeder capacity first, environmental and equity dividends decisively exceed commuter friction.",
    dimensions: buildDimensions(7.5, {
      task_response: "Nuanced, thoroughly developed evaluation analyzing mechanisms, distributional incidence, and policy design.",
      coherence_cohesion: "Effortless thematic progression where each paragraph refines and qualifies the central claim.",
      lexical_resource: "Precise analytical vocabulary ('ring-fenced', 'non-linear relief', 'distributional incidence') used naturally.",
      grammatical_range_accuracy: "Wide syntactic variety with accurate punctuation, parallel structure, and zero distracting errors.",
    }),
  },
  {
    essayId: "sentinel-b80-transit",
    band: 8.0,
    tier: "high",
    thetaAnchor: thetaFromBand(8.0),
    prompt: SENTINEL_ESSAY_PROMPT,
    text:
      "Using central-district parking surcharges to underwrite subsidized transit fares realigns urban mobility prices with social cost, yet its equity verdict hinges on sequencing. Provided municipalities expand outer-ring access alongside pricing reform, the compounded environmental and distributional dividends markedly outweigh the adjustment burden borne by suburban drivers.\n\n" +
      "Dense commercial cores cannot physically accommodate unconstrained private car commuting without degrading both air quality and bus throughput. Raising central parking charges selectively deters peak-hour solo driving where modal alternatives already exist, generating a self-reinforcing loop: lighter arterial traffic restores bus punctuality, which in turn makes subsidized fares a genuinely reliable option rather than a nominal discount. Because lower-income urban residents spend a larger share of earnings on fares while suffering disproportionate roadside pollution, the policy delivers progressive health and income gains.\n\n" +
      "The legitimate counterweight is spatial lock-in. Families priced out of inner districts often inhabit car-dependent fringes underserved by evening or cross-suburban transit. Imposing steep parking fees ahead of park-and-ride capacity or multi-zone fare capping transfers adjustment costs onto workers with the least scheduling flexibility. Yet this vulnerability argues for hypothecating parking revenue into rapid feeder corridors and off-hour exemptions—not for preserving hidden parking subsidies that entrench congestion.\n\n" +
      "Weighed in full, pricing central parking to subsidize transit yields durable environmental and equity gains that clearly surpass suburban commuter costs once paired with targeted peripheral investment.",
    dimensions: buildDimensions(8.0, {
      task_response: "Incisive, balanced synthesis resolving competing spatial-equity and efficiency tensions with exact causal reasoning.",
      coherence_cohesion: "Seamless cohesion, disciplined paragraph architecture, and varied referencing without mechanical signposting.",
      lexical_resource: "Exact, idiomatic register ('spatial lock-in', 'hypothecating parking revenue', 'nominal discount').",
      grammatical_range_accuracy: "Flexible, error-free complex syntax deployed purposefully for emphasis and qualification.",
    }),
  },
] as const;

export function getSentinelAnchorsForDimension(dimension: RubricDimension): readonly DimensionSentinelAnchor[] {
  return SENTINEL_ANCHOR_ESSAYS.map((essay) => {
    const descriptor = essay.dimensions[dimension];
    return {
      anchorId: `${essay.essayId}:${dimension}`,
      essayId: essay.essayId,
      dimension,
      band: descriptor.band,
      tier: essay.tier,
      thetaAnchor: descriptor.thetaAnchor,
      prompt: essay.prompt,
      text: essay.text,
      criterionNote: descriptor.criterionNote,
    };
  });
}

export const ANTI_PADDING_COUNTERFACTUAL_TRIPLETS: readonly AntiPaddingCounterfactualTriplet[] = [
  {
    tripletId: "counterfactual-transit-subsidy",
    prompt: SENTINEL_ESSAY_PROMPT,
    targetDimension: "task_response",
    substantiveConcise:
      "Raising central parking fees while cutting transit fares reduces peak road congestion and lowers commuting costs for lower-wage city workers. " +
      "Because central curb space is scarce, shifting discretionary car trips onto buses improves lane speeds and trims roadside exhaust near schools. " +
      "However, outer-suburb shift workers lack frequent feeder buses, so cities should channel parking revenue into perimeter park-and-ride lots and off-peak rebates to avoid regressive burdens.",
    templatePaddedExpansion:
      "In the contemporary era of rapid globalization, this hotly debated topic has sparked heated debate among citizens from all walks of life. " +
      "It is universally acknowledged that every coin has two sides, and it goes without saying that urban transport plays a pivotal role in modern society. " +
      "Raising central parking fees while cutting transit fares reduces peak road congestion and lowers commuting costs for lower-wage city workers. " +
      "Furthermore, needless to say, it is an undeniable fact that this double-edged sword speaks volumes about how cities function in today's fast-paced world. " +
      "Because central curb space is scarce, shifting discretionary car trips onto buses improves lane speeds and trims roadside exhaust near schools. " +
      "As far as I am concerned, from my perspective, I firmly believe that it is widely believed that decision-makers must look carefully at all aspects. " +
      "However, outer-suburb shift workers lack frequent feeder buses, so cities should channel parking revenue into perimeter park-and-ride lots and off-peak rebates to avoid regressive burdens. " +
      "In a nutshell, last but not least, in light of the aforementioned considerations, this issue deserves sustained attention from every corner of society.",
    equalLengthSubstantive:
      "Raising central parking fees while cutting transit fares reduces peak road congestion and lowers commuting costs for lower-wage city workers. " +
      "Because central curb space is scarce, shifting even fifteen percent of discretionary solo car trips onto high-capacity buses measurably raises arterial speeds, cuts diesel idling, and lowers roadside nitrogen oxide exposure around downtown schools and clinics. " +
      "Cheaper fares simultaneously expand labor-market reach for service and healthcare staff whose earnings are most sensitive to daily ticket outlays, turning congestion pricing from a narrow environmental fee into an active mobility subsidy. " +
      "The principal risk is spatial inequity: households pushed to outer suburbs by high inner-city rents frequently live beyond walking distance of rail lines and face sparse evening headways. " +
      "If parking surcharges take effect before alternatives exist, tradespeople and night-shift workers absorb unavoidable expenses without receiving equivalent time savings. " +
      "Cities can resolve this trade-off through transparent sequencing—ring-fencing parking revenue to finance perimeter park-and-ride stations, express feeder buses, and off-peak fare caps before escalating downtown rates. " +
      "Under that design, the durable health, reliability, and affordability gains clearly outweigh transitional friction for outer-ring commuters.",
  },
  {
    tripletId: "counterfactual-public-libraries",
    prompt:
      "Some municipalities propose shifting public library budgets from physical branches toward digital e-book subscriptions. " +
      "Do the operational savings outweigh the community losses?",
    targetDimension: "coherence_cohesion",
    substantiveConcise:
      "Digital e-book subscriptions expand remote catalog access and cut shelving upkeep, especially for commuters and mobility-limited readers. " +
      "Yet closing neighborhood branches removes quiet study desks, free broadband terminals, and early-literacy workshops that low-income families rely on. " +
      "Cities should therefore preserve core physical branches as civic learning hubs while pooling regional licensing contracts to restrain e-book costs.",
    templatePaddedExpansion:
      "Since the dawn of modern urban life, this controversial issue has sparked heated debate among citizens from all walks of life. " +
      "It is universally acknowledged that every coin has two sides, and needless to say, technology plays a pivotal role in today's fast-paced world. " +
      "Digital e-book subscriptions expand remote catalog access and cut shelving upkeep, especially for commuters and mobility-limited readers. " +
      "From my perspective, I firmly believe that it is an undeniable fact that digital change acts as a double-edged sword that speaks volumes across communities. " +
      "Yet closing neighborhood branches removes quiet study desks, free broadband terminals, and early-literacy workshops that low-income families rely on. " +
      "As far as I am concerned, it goes without saying that it is widely believed that authorities must balance old and new approaches carefully. " +
      "Cities should therefore preserve core physical branches as civic learning hubs while pooling regional licensing contracts to restrain e-book costs. " +
      "In a nutshell, last but not least, in light of the aforementioned considerations, thoughtful planning remains essential for the future.",
    equalLengthSubstantive:
      "Digital e-book subscriptions expand remote catalog access and cut shelving upkeep, especially for commuters, rural residents, and readers who depend on adjustable typography or screen-reader compatibility. " +
      "Moreover, centralized digital catalogs allow municipal systems to satisfy sudden spikes in textbook or exam-prep demand without duplicating physical inventory across dozens of small buildings. " +
      "Yet shrinking physical branches carries steep social losses that digital lending cannot replicate. " +
      "Neighborhood libraries supply climate-controlled quiet study desks, free broadband terminals, printing access for job applications, and structured early-literacy workshops for households lacking private workspaces at home. " +
      "Publisher licensing rules also complicate the promised savings, since metered e-book licenses frequently expire after a fixed number of checkouts and cost more per circulation than durable print copies. " +
      "Rather than treating print and digital budgets as a zero-sum trade-off, cities should retain neighborhood branches as shared civic infrastructure while negotiating consortium-level digital licenses to contain per-loan fees. " +
      "That hybrid allocation captures digital convenience without eroding vital offline access for vulnerable residents.",
  },
] as const;
