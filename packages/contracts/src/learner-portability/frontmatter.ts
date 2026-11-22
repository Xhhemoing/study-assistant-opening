const leadingMarker = /^---(?=[\s\u0085]|$)/u;
const documentMarker = /^(?:---|\.\.\.)(?=[\s\u0085]|$)/u;
const openingFence = /^---[ \t]*$/u;
const closingFence = /^(?:---|\.\.\.)[ \t]*$/u;
const plainKey = /^[\p{L}_][\p{L}\p{M}\p{N}_.-]*(?: [\p{L}\p{M}\p{N}_.-]+)*$/u;
const flowDelimiter = /[[\]{},]/u;
const scalarKeyword = /^(?:y|n|yes|no|on|off|true|false|null)$/iu;
const privateKeys = new Set([
  "workspaceid", "owneruserid", "userid", "principalid", "sessionid", "tenantid", "accountid", "privacyepoch",
  "claimtoken", "executionid", "jobexecution", "idempotencykey", "clientkey",
  "tutorjobid", "assistantturnid", "userturnid", "conversationid", "sourceturnids", "memorydependencyids",
  "contextsourcerefs", "exposurereceiptid", "materialpurposepin", "sourceversion", "uploadstate", "parsestate", "imageobjectkey",
  "sealed", "solutionsealed", "visibilityhint", "0109", "skillbelief", "skillbeliefv1", "bkt", "fiass", "remedyclinic",
  "examforecast", "diagnosticplacement", "openingcoursereservedquestions", "reservedquestions", "internalrubric", "<<",
  "privateanswerkey", "privateanswerkeys", "answerkey", "answerkeys", "officialanswer", "officialanswers", "modelanswer",
  "modelanswers", "referenceanswer", "referenceanswers", "solutions", "solutiontext", "rubric", "hiddenrubric", "reserveditems",
  "trustedkey", "trustedkeys", "teachinganswerkey", "teachinganswerkeys", "answerorrubricanchors",
  "pinnedkey", "pinnedkeys", "keytext", "keytexts", "solveranswer", "solveranswers",
  "expectedanswer", "expectedanswers", "canonicalanswer", "canonicalanswers", "correctanswer", "correctanswers",
  "samplesolution", "samplesolutions", "workedsolution", "workedsolutions", "unrevealedanswer", "unrevealedanswers",
  "teachingblindsolvereceipt", "teachingblindsolvereceipts", "answerblockid", "answerkeyblockids", "publicationcardids",
  "answerref", "revealstate", "costledgerref", "generatormodelidentity", "modelsnapshot",
  "retainedquestioneligibility", "questioneligibility",
  "correctoptionid", "correctoptionids", "correctoption", "correctoptions",
  "correctchoice", "correctchoices", "correctchoiceid", "correctchoiceids",
  "solution", "answer", "answers", "answerid", "answerids", "answertext", "referencetext",
  "explanation", "explanations", "accepted", "acceptedanswers",
  "evaluator", "evaluators", "evaluatorid", "evaluatorversion", "verifierid", "verifierversion",
  "partsnapshot", "partsnapshots", "resultmetadata", "questionevaluation", "questionevaluations", "questionidentity",
  "questionidentityrefid", "identityrefid", "keyrefid", "evaluationrefid", "unexposedreceipt",
  "questionunexposedreceipt", "serverexactreceipt",
  "lessonexposures", "lessonexposureids", "seenexampleexposureids", "partialexampleexposureids",
  "exposurecoverage", "exposurereceipt", "exposurereceipts", "predictionsnapshot", "contentkey", "heldout", "heldoutitems",
  "candidaterationale", "candidateoutcome", "rawoutput", "promptdigest", "rubricversion", "instructionversion",
  "comparatorversion", "answerrole", "protocolversion", "questionref", "sourcerefs", "conditionrefs", "figurerefs",
  "questionblockid", "teachingrevisionid", "sourceversions", "operationid", "reasoncodes",
  "inputcentspermillion", "outputcentspermillion", "historyrevision", "requirementkey", "partid", "verifier", "checker",
  "questionmatch", "unmetcriteria", "spantutorgrants", "purposepin", "exposureidentity", "contentfingerprint",
  "mappingversion", "displayedfamilyids", "partialfamilyids", "firstfamilyexposure", "restoredungraded",
  "worksource", "worksourceid", "worksourceversion", "referencesourceid", "referencesourceversion", "referencechecked",
  "imageevidenceref", "sourcecommit", "teachingunitid", "expectedversion", "expectedrevisionnumber", "blockorder",
  "verificationstatus", "generationconfig", "budgetclass", "providerhint", "modelroutes", "taskroutes", "providerid",
  "modelname", "modellabel", "bktcorrect", "baselinecorrect", "bktbrier", "baselinebrier", "nextcorrectprobability",
  "answerrevision", "autogradeskipped", "answerproblemref", "assistedproblemref", "sessionexposures",
  "weaknesses", "recentmistakes", "cohorttraprate", "cohortsamplesize",
  "identitystatus", "unexposedeligibility", "rawanswer", "originalanswer", "copiedanswer", "answerexcerpt",
  "answerrecordedat", "answersequences", "answerstrings", "answertruncated", "answerwithheld", "restrictedanswer",
  "aigrading", "aievaluation", "gradingversion", "previousgradingversion", "serverevaluation", "verificationscope",
  "datasetid", "datasetversion", "caseversion", "reviewerid", "dialogueevaluation",
  "evidenceeligibility", "evidencecontext", "evidencecontexts", "evidenceverdict", "coreevidencecomplete",
  "exposurehistoryuncertain", "intervalexposure", "intervalexposurecomplete", "firstquestionexposure",
  "helpinputsnapshot", "evaluatedcontent", "evaluationspec", "scoringauthorized", "scoringeligible", "scoringevidence",
  "coveredsourceversions", "currentsourceversions", "eligiblesourceversions", "sourceitemid", "coveredsourcechunkdigests",
  "evidencechunkids", "evidenceattemptids", "evidencerootids", "connectionid", "connectionversion", "remoteid",
  "retestid", "reteststatus", "expectedexceptionrevision", "beforeblocks", "afterblocks", "addedblocks",
  "kcmappingversion", "qualificationversion", "packversion", "questionindexsha256",
  "budgetcents", "budgetconfirmedat", "confirmbudget", "coststate", "ledger", "reservationid", "providerlabel",
  "spentcents", "reservedcents",
  "cachedinputtokens", "inputtokens", "outputtokens", "maxoutputtokens", "maxprovidercalls", "mediainputtokenupperbound",
  "bankversion", "modelversion", "pairedbrierdifference", "meanprediction", "bkteligible", "bkteligibleattemptids",
  "capcents", "checkpointjson", "lostblockids", "diagnosticbasis", "returnmoveid", "callid", "expectedlinkrevision",
]);
// Receipt and lineage families include sibling field names added by Opening
// without reserving generic public keys such as id, version, status, or source.
const privateKeyPattern = /^(?:private|blindsolve|trustedquestionkey)|(?:receipts?|receiptids?|(?:identity|evaluation|key)refids?|(?:itemversion|observation|attempt)ids?)$/u;
const privateEligibilityReasons: Readonly<Record<string, ReadonlySet<string>>> = {
  unknown: new Set(["identity_unknown", "identity_candidate", "key_unknown", "exposure_unknown", "coverage_unknown"]),
  unavailable: new Set(["identity_conflict", "key_unavailable", "reference_unavailable", "exposed", "stale_receipt"]),
};
const privateComparisonBases = new Set(["semantic", "model", "unverified_reference"]);
const privateComparisonReasons = new Set(["missing_identity", "missing_conditions", "missing_figures", "unavailable_reference"]);
const privateComparisonDimensions = new Set(["source_version", "conditions", "figures", "answer_role"]);
const privateSpanReasons = new Set([
  "prerequisite_binding_missing", "requirement_changed", "relation_unconfirmed", "source_unavailable",
  "prerequisite_evidence_missing", "prerequisite_evidence_changed", "prerequisite_identity_mismatch",
  "prerequisite_content_unavailable", "prerequisite_verification_mismatch", "prerequisite_not_verified_weak",
  "evidence_unavailable", "verification_mismatch", "predecessor_unobserved", "ambiguous_branch",
  "unsupported_target", "no_verified_error", "teaching_unavailable", "unknown_history",
]);
const privateToolNames = new Set([
  "learner_state", "explain_decision", "notes", "cards", "exam_sprint", "courses", "learning", "recommendation",
  "materials", "planning", "jobs", "settings", "teaching", "propose_teaching_move", "propose_plan_change",
  "propose_card", "propose_note", "propose_memory", "flag_dispute",
]);
const trackedFields = new Set(["kind", "basis", "dimensions", "status", "reason", "reasonCode", "name", "arguments", "role", "calls"]);
// Keep only collection kinds and the presence of a comparison dimension.
const mappingNode = Symbol();
const sequenceNode = Symbol();
const comparisonDimensionSequence = Symbol();
type FrontmatterValue = string | typeof mappingNode | typeof sequenceNode | typeof comparisonDimensionSequence | undefined;
const yamlEscapes: Readonly<Record<string, string>> = {
  "0": "\0", a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
  " ": " ", "\t": "\t", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: "\u00a0", L: "\u2028", P: "\u2029",
};

function invalid(): never {
  throw new TypeError("Unrecognized or private YAML frontmatter");
}

function isPrivateKey(key: string): boolean {
  const normalized = key.normalize("NFKC").replace(/[-_.\s]/gu, "").toLowerCase();
  return privateKeyPattern.test(normalized) || privateKeys.has(normalized);
}

function hasValue(values: ReadonlySet<string>, value: FrontmatterValue): boolean {
  return typeof value === "string" && values.has(value.trim());
}

function isPlainSafe(character: string, flow: boolean): boolean {
  return character !== "" && !/[ \t\n]/u.test(character) && (!flow || !flowDelimiter.test(character));
}

// Walk the data-only YAML grammar without materializing records. Advanced YAML
// constructs such as tags, anchors, aliases and complex keys fail closed.
class FrontmatterReader {
  private offset = 0;
  private readonly source: string;

  constructor(source: string) {
    this.source = source;
  }

  read(): void {
    this.blankLines();
    if (this.done) return;
    const indent = this.indent();
    const first = this.source[this.offset + indent];
    if (first === "{" || first === "[") {
      this.offset += indent;
      this.flowValue(0, indent);
      this.endLine();
    } else this.block(indent, 0);
    this.blankLines();
    if (!this.done) invalid();
  }

  private get current(): string { return this.source[this.offset] ?? ""; }
  private get done(): boolean { return this.offset >= this.source.length; }

  private skipHorizontal(): void {
    this.offset = this.horizontalEnd(this.offset);
  }

  private horizontalEnd(offset: number): number {
    let end = offset;
    while (this.source[end] === " " || this.source[end] === "\t") end++;
    return end;
  }

  private indent(): number {
    const spaces = this.leadingSpaces();
    if (this.source[this.offset + spaces] === "\t") invalid();
    return spaces;
  }

  private leadingSpaces(): number {
    let end = this.offset;
    while (this.source[end] === " ") end++;
    return end - this.offset;
  }

  private lineEnd(): number {
    const end = this.source.indexOf("\n", this.offset);
    return end === -1 ? this.source.length : end;
  }

  private blankLines(): void {
    while (!this.done) {
      const start = this.offset;
      this.skipHorizontal();
      if (this.current === "#") this.offset = this.lineEnd();
      if (this.current === "\n") this.offset++;
      else if (!this.done) { this.offset = start; return; }
    }
  }

  private flowTrivia(): void {
    while (!this.done) {
      if (/[ \t\n]/u.test(this.current)) this.offset++;
      else if (this.current === "#") this.offset = this.lineEnd();
      else return;
    }
  }

  private endLine(): boolean {
    const at = this.offset;
    this.skipHorizontal();
    // A plain scalar may already have scanned the whitespace before a comment.
    const comment = this.current === "#" && (this.offset > at || /[ \t]/u.test(this.source[at - 1] ?? ""));
    if (comment) this.offset = this.lineEnd();
    if (this.current === "\n") this.offset++;
    else if (!this.done) invalid();
    return comment;
  }

  private indicator(token: string): boolean {
    const next = this.source[this.offset + 1];
    return this.current === token && (next === undefined || /[ \t\n]/u.test(next));
  }

  private quotedLineBreak(minIndent: number | undefined): number {
    if (minIndent === undefined) invalid(); // Implicit mapping keys are single-line.
    let breaks = 1;
    while (!this.done) {
      const start = this.offset;
      while (this.current === " ") this.offset++;
      const spaces = this.offset - start;
      this.skipHorizontal();
      if (this.current !== "\n") {
        if (spaces < minIndent) invalid();
        break;
      }
      this.offset++;
      breaks++;
    }
    return breaks;
  }

  private quoted(minIndent?: number): string {
    const quote = this.current;
    this.offset++;
    let value = "";
    while (!this.done) {
      const char = this.source[this.offset++]!;
      if (char === quote) {
        if (quote !== "'" || this.current !== "'") return value;
        this.offset++;
      } else if (quote === '"' && char === "\\") {
        const escape = this.source[this.offset++] ?? "";
        if (escape === "\n") {
          this.quotedLineBreak(minIndent);
          continue;
        }
        const width = escape === "x" ? 2 : escape === "u" ? 4 : escape === "U" ? 8 : 0;
        if (width) {
          const hex = this.source.slice(this.offset, this.offset + width);
          if (hex.length !== width || !/^[\da-f]+$/iu.test(hex)) invalid();
          value += String.fromCodePoint(Number.parseInt(hex, 16));
          this.offset += width;
        } else if (Object.hasOwn(yamlEscapes, escape)) value += yamlEscapes[escape];
        else invalid();
        continue;
      } else if (char === "\n") {
        const breaks = this.quotedLineBreak(minIndent);
        value = value.replace(/[ \t]+$/u, "") + (breaks === 1 ? " " : "\n".repeat(breaks - 1));
        continue;
      }
      value += char;
    }
    return invalid();
  }

  private plain(flow: boolean, continuation = false): string {
    const start = this.offset;
    const first = this.current;
    if (!first || (!continuation && (/^[[\]{},#&*!|>'"%@`]/u.test(first)
      || (/^[-?:]$/u.test(first) && !isPlainSafe(this.source[start + 1] ?? "", flow))))) invalid();
    while (!this.done) {
      const char = this.current;
      const next = this.source[this.offset + 1] ?? "";
      if (char === "\n" || (char === "#" && /[ \t]/u.test(this.source[this.offset - 1] ?? ""))
        || (flow && flowDelimiter.test(char)) || (char === ":" && !isPlainSafe(next, flow))) break;
      this.offset++;
    }
    const value = this.source.slice(start, this.offset).trimEnd();
    if (!value) invalid();
    return value;
  }

  private key(flow: boolean, fields: Map<string, FrontmatterValue>): string {
    const quoted = this.current === '"' || this.current === "'";
    const key = quoted ? this.quoted() : this.plain(flow);
    this.skipHorizontal();
    if (!key || fields.has(key) || (flow ? this.current !== ":" : !this.indicator(":"))
      || (!quoted && (!plainKey.test(key) || scalarKeyword.test(key)))
      || isPrivateKey(key)) invalid();
    fields.set(key, undefined);
    this.offset++;
    return key;
  }

  private recordValue(fields: Map<string, FrontmatterValue>, key: string | undefined, value: FrontmatterValue): void {
    if (key === undefined || !trackedFields.has(key)) return;
    fields.set(key, typeof value === "string" ? value.trim() : value);
    const kind = fields.get("kind");
    const status = fields.get("status");
    const reason = fields.get("reason");
    const calls = fields.get("calls");
    if ((kind === "candidate" && hasValue(privateComparisonBases, fields.get("basis")))
      || (kind === "unknown" && hasValue(privateComparisonReasons, reason))
      || (kind === "conflict" && fields.get("dimensions") === comparisonDimensionSequence)
      || (typeof status === "string" && Object.hasOwn(privateEligibilityReasons, status) && hasValue(privateEligibilityReasons[status]!, reason))
      || ((status === "unknown" || status === "needs_clarification") && hasValue(privateSpanReasons, fields.get("reasonCode")))
      || (fields.get("arguments") === mappingNode && hasValue(privateToolNames, fields.get("name")))
      || ((calls === sequenceNode || calls === comparisonDimensionSequence) && fields.get("role") === "assistant")) invalid();
  }

  private flowValue(depth: number, minIndent: number): FrontmatterValue {
    if (depth > 100) invalid();
    this.flowTrivia();
    const opener = this.source[this.offset];
    if (opener === "[" || opener === "{") {
      const closer = opener === "[" ? "]" : "}";
      const fields = new Map<string, FrontmatterValue>();
      let sequenceValue: FrontmatterValue;
      this.offset++;
      this.flowTrivia();
      while (this.current !== closer) {
        const field = opener === "{" ? this.key(true, fields) : undefined;
        this.flowTrivia();
        if (this.current !== closer && this.current !== ",") {
          const value = this.flowValue(depth + 1, minIndent);
          if (opener === "[" && hasValue(privateComparisonDimensions, value)) sequenceValue = comparisonDimensionSequence;
          this.recordValue(fields, field, value);
        } else if (opener === "[") invalid();
        this.flowTrivia();
        if (this.current === closer) break;
        if (this.current !== ",") invalid();
        this.offset++;
        this.flowTrivia();
      }
      this.offset++;
      return opener === "[" ? sequenceValue ?? sequenceNode : mappingNode;
    }
    return opener === '"' || opener === "'" ? this.quoted(minIndent) : this.plain(true);
  }

  private inlineMapping(minIndent: number): boolean {
    const start = this.offset;
    if (!this.current || /^[[\]{},#|>]/u.test(this.current)) return false;
    if (this.current === '"' || this.current === "'") this.quoted(minIndent);
    else this.plain(false);
    this.skipHorizontal();
    const found = this.indicator(":");
    this.offset = start;
    return found;
  }

  private block(indent: number, depth: number, inline = false, indentlessSequence = false): FrontmatterValue {
    if (depth > 100) invalid();
    let sequence: boolean | undefined;
    const fields = new Map<string, FrontmatterValue>();
    let sequenceValue: FrontmatterValue;
    while (!this.done) {
      if (!inline) {
        this.blankLines();
        if (this.done) break;
        const actual = this.indent();
        if (actual < indent) break;
        if (actual > indent) invalid();
        if (indentlessSequence && !this.sequenceAt(indent)) break;
        this.offset += indent;
      }
      inline = false;
      const item = this.indicator("-");
      if (sequence !== undefined && sequence !== item) invalid();
      sequence = item;
      const start = this.offset;
      const field = item ? undefined : this.key(false, fields);
      if (item) this.offset++;
      this.skipHorizontal();
      if (this.current === "#") this.offset = this.lineEnd();
      let value: FrontmatterValue;
      if (this.current === "\n" || this.done) {
        value = this.nextLineValue(indent, depth, !item);
      } else if (item && (this.indicator("-") || this.inlineMapping(indent + 1))) {
        value = this.block(indent + this.offset - start, depth + 1, true);
      } else {
        value = this.blockValue(indent, depth);
      }
      if (item && hasValue(privateComparisonDimensions, value)) sequenceValue = comparisonDimensionSequence;
      this.recordValue(fields, field, value);
    }
    if (sequence) return sequenceValue ?? sequenceNode;
    return sequence === false ? mappingNode : undefined;
  }

  private nextLineValue(parentIndent: number, depth: number, allowIndentlessSequence: boolean): FrontmatterValue {
    this.endLine();
    this.blankLines();
    if (this.done) return undefined;
    const indent = this.leadingSpaces();
    const first = this.offset + indent;
    if (indent <= parentIndent && this.source[first] === "\t") invalid();
    if (indent === parentIndent && allowIndentlessSequence && this.sequenceAt(indent)) {
      return this.block(indent, depth + 1, false, true);
    }
    if (indent <= parentIndent) return undefined;
    const start = this.offset;
    this.offset = this.horizontalEnd(first);
    if (!this.indicator("-") && !this.inlineMapping(parentIndent + 1)) return this.blockValue(parentIndent, depth);
    this.offset = start;
    return this.block(indent, depth + 1);
  }

  private blockValue(parentIndent: number, depth: number): FrontmatterValue {
    if (this.current === "|" || this.current === ">") return this.blockScalar(parentIndent);
    if (this.current === "[" || this.current === "{" || this.current === '"' || this.current === "'") {
      const value = this.flowValue(depth + 1, parentIndent + 1);
      this.endLine();
      return value;
    }
    return this.plainBlockValue(parentIndent);
  }

  private plainBlockValue(parentIndent: number): string {
    let value = this.plain(false);
    let comment = this.endLine();
    while (!this.done && !comment) {
      const start = this.offset;
      let breaks = 1;
      while (!this.done) {
        const end = this.lineEnd();
        if (!/^[ \t]*$/u.test(this.source.slice(this.offset, end))) break;
        this.offset = Math.min(end + 1, this.source.length);
        breaks++;
      }
      const indent = this.leadingSpaces();
      const first = this.offset + indent;
      const textStart = this.horizontalEnd(first);
      if (this.done || this.source[textStart] === "#" || indent <= parentIndent) {
        if (this.source[textStart] !== "#" && this.source[first] === "\t") invalid();
        this.offset = start;
        break;
      }
      this.offset = textStart;
      value += (breaks === 1 ? " " : "\n".repeat(breaks - 1)) + this.plain(false, true);
      comment = this.endLine();
    }
    return value;
  }

  private sequenceAt(indent: number): boolean {
    const start = this.offset;
    this.offset += indent;
    const found = this.indicator("-");
    this.offset = start;
    return found;
  }

  private blockScalar(parentIndent: number): string | undefined {
    this.offset++;
    const flags = /^(?:[1-9][+-]?|[+-][1-9]?)?/u.exec(this.source.slice(this.offset, this.lineEnd()))![0];
    this.offset += flags.length;
    const digit = /[1-9]/u.exec(flags)?.[0];
    this.endLine();
    let contentIndent = digit ? parentIndent + Number(digit) : undefined;
    let firstLine: string | undefined;
    let nonemptyLines = 0;
    while (!this.done) {
      const end = this.lineEnd();
      const spaces = this.leadingSpaces();
      const first = this.source[this.offset + spaces];
      if (this.offset + spaces < end) {
        if (spaces < (contentIndent ?? parentIndent + 1)) {
          const textStart = this.horizontalEnd(this.offset + spaces);
          // A dedented tab-only line terminates the scalar like a comment.
          if (textStart === end || this.source[textStart] === "#" || (spaces <= parentIndent && first !== "\t")) break;
          invalid();
        }
        contentIndent ??= spaces;
        if (nonemptyLines++ === 0) firstLine = this.source.slice(this.offset + contentIndent, end).trim();
      }
      this.offset = Math.min(end + 1, this.source.length);
    }
    return nonemptyLines === 1 ? firstLine : undefined;
  }
}

export function hasPortableFrontmatter(markdown: string): boolean {
  const raw = markdown.replace(/^\uFEFF/u, "");
  if (!leadingMarker.test(raw)) return true;
  const lines = raw.split(/\r\n?|\n/u);
  if (!openingFence.test(lines[0]!)) return false;
  const end = lines.findIndex((line, index) => index > 0 && closingFence.test(line));
  if (end < 0) return false;
  const metadata = lines.slice(1, end);
  if (metadata.some(line => documentMarker.test(line))) return false;
  const body = metadata.join("\n");
  // YAML readers disagree on Unicode line separators. Preserve them in the
  // Markdown body, but decline frontmatter with ambiguous line boundaries.
  if (/(?![\t\n])[\p{Cc}\u2028\u2029]/u.test(body)) return false;
  try {
    new FrontmatterReader(body).read();
    return true;
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) return false;
    throw error;
  }
}
