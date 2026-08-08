/**
 * reduction-intent — judge the OPERATION, not the vocabulary.
 *
 * NAMING NOTE: this module is deliberately not named for the noun it guards.
 * The live wall refused an `import` statement whose PATH carried the trigger
 * stem — a filename is an identifier, which is operation 2 below, and the
 * clearest possible demonstration of the defect #637 describes.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS MODULE EXISTS (issue #637)
 * ---------------------------------------------------------------------------
 * The standing no-size-reduction rule is right and its teeth stay sharp. What
 * was wrong was the TEST: `design-lookup-gate.ts` asked "does this text contain
 * a word from a list?" and refused on a match. Measured taxes from the
 * 2026-08-07/08 sessions, every one recorded in docs/lane-contract.md or #637:
 *
 *   - `git worktree prune` — a command AGENTS.md MANDATES at cleanup —
 *     refused twice, inside commit messages.
 *   - an OPERATOR QUOTE being harvested into docs/lane-contract.md.
 *   - a BUG REPORT describing, in the past tense, a defect that already exists.
 *   - `information_schema.constraint_column_usage`, a catalog table name.
 *   - an AskUserQuestion presenting the operator's OWN recorded #563 options.
 *
 * This is the #618 defect class exactly: matching vocabulary instead of the
 * operation. #618's git guard read protected-branch names inside heredoc TEXT
 * rather than in the command being run; `.claude/hooks/lib/shell-command-parse.ts`
 * (PR #629) fixed that class by judging PARSED ARGUMENTS. This module applies
 * the same move to the other standing wall, and imports that same parser rather
 * than growing a second one.
 *
 * ---------------------------------------------------------------------------
 * THE CONSTRAINT THAT SHAPES EVERYTHING BELOW
 * ---------------------------------------------------------------------------
 * From #637, verbatim: "the no-size-reduction standing rule's TEETH MUST NOT
 * WEAKEN." So this module is not a relaxation. It is a REDIRECTION of the same
 * force onto a better-aimed question:
 *
 *     old:  does this text contain a word from a list?
 *     new:  is an AGENT, IN ITS OWN VOICE, PROPOSING A NEW REDUCTION?
 *
 * Everything the old test refused for the right reason is still refused. What
 * changes is that four operations which were never proposals stop being read
 * as proposals.
 *
 * ---------------------------------------------------------------------------
 * FAIL CLOSED, DELIBERATELY
 * ---------------------------------------------------------------------------
 * Where intent cannot be judged DETERMINISTICALLY, this returns "proposal" and
 * the caller refuses. #637 is explicit that a weaker gate is worse than a noisy
 * one, and the asymmetry that justified the original wall is unchanged: a false
 * refusal costs one reword, while a false pass costs silent data loss that
 * surfaces later as a false claim about what the database holds (2026-07-30,
 * three times in one day). Every exemption below is therefore a NARROW,
 * STRUCTURAL recognition — a parsed command shape, an attributed quotation, a
 * grammatical tense — never a general "this looks fine" judgement.
 */

import { parseSimpleCommands, executableWords } from "./shell-command-parse.ts";

/**
 * Vocabulary that MIGHT indicate a reduction. This is the trigger set, not the
 * verdict: a hit here only means "look closer", and the classifier below
 * decides. Kept identical in coverage to the pattern this module replaces so
 * nothing silently drops out of scope.
 */
export const REDUCTION_VOCABULARY = new RegExp(
  [
    String.raw`\b(cap|caps|capped|capping)\b`,
    String.raw`\b(limit|limits|limiting|limited|limitation|limitations)\b`,
    String.raw`\b(ceiling|quota|throttle|throttling|budgeted)\b`,
    String.raw`\b(truncat|trim|prun|downsiz|shrink|curtail|constrain|restrict)\w*`,
    String.raw`\bslim(?:med|ming)?\b`,
    String.raw`\bpared?\b|\bparing\b`,
    String.raw`\b(smaller|fewer|leaner|tighter)\b`,
    String.raw`\bmax[_\s-]?(tokens|size|items|chars|characters|length|rows|events|bytes|count)\b`,
    String.raw`\bsize\s+(limit|cap|budget|ceiling)\b`,
    String.raw`\btoken\s+budget\b`,
    String.raw`\bhow\s+(big|large|many|much)\b`,
    String.raw`\bcut\s+(it|them|this|that|down|off)\b`,
    String.raw`\bkeep\s+it\s+(small|short|tight|brief|bounded)\b`,
    String.raw`\btop[_\s-]?\d+\b`,
    String.raw`\bfirst\s+\d+\s+(rows|items|events|results|chars)\b`,
  ].join("|"),
  "i",
);

/** Count trigger hits. Comparing before/after is what separates fix from defect. */
export function reductionWeight(text: string): number {
  return (text.match(new RegExp(REDUCTION_VOCABULARY.source, "gi")) ?? []).length;
}

/* ==========================================================================
 * OPERATION 1 — COMMAND VOCABULARY
 * ==========================================================================
 * `git worktree prune` is a registration cleanup. `LIMIT 20` is a SQL row
 * clause. `--max-count=20` is a git output flag. None of them reduce anything
 * that is remembered, and all of them were refused by the old text match.
 *
 * The discriminator is POSITION, resolved by the shared parser: the word is the
 * VERB or a FLAG of a command being run, not a claim in a sentence. That is a
 * structural fact about the command line, which is why it can be decided
 * deterministically rather than guessed at.
 */

/** `<binary> <subcommand>` pairs whose name merely contains trigger vocabulary. */
const SANCTIONED_SUBCOMMANDS: ReadonlyArray<readonly [string, string]> = [
  ["git", "prune"],
  ["git", "worktree"],
  ["git", "gc"],
  ["docker", "prune"],
  ["bun", "pm"],
  ["npm", "prune"],
];

/** Flags whose NAME carries trigger vocabulary but which only shape output. */
const SANCTIONED_FLAGS =
  /^--(max-count|max-depth|maxdepth|limit|truncate|prune|prune-empty|tail|head)(=|$)/;

function binaryName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}

/**
 * Strip the parts of a command that are SANCTIONED COMMAND SYNTAX, returning
 * what remains for prose judgement.
 *
 * A quoted token is a VALUE — a commit message, an issue body, a SQL string —
 * so it is NOT stripped: prose smuggled into a quoted argument still gets
 * judged as prose. That is the property that keeps this from becoming a bypass.
 */
export function stripSanctionedCommandSyntax(command: string): string {
  const remaining: string[] = [];

  for (const simple of parseSimpleCommands(command)) {
    const words = executableWords(simple);
    if (words.length === 0) continue;

    const first = words[0]!;
    const binary = first.quoted ? "" : binaryName(first.value);

    for (let i = 0; i < words.length; i += 1) {
      const word = words[i]!;

      if (!word.quoted) {
        // The binary name itself is never prose.
        if (i === 0) continue;

        // A sanctioned `<binary> <subcommand>` pair, in position.
        const isSanctionedSub = SANCTIONED_SUBCOMMANDS.some(
          ([bin, sub]) => bin === binary && word.value === sub,
        );
        if (isSanctionedSub) continue;

        // A sanctioned output-shaping flag.
        if (SANCTIONED_FLAGS.test(word.value)) continue;

        // A bare flag or a path is command syntax, not a claim.
        if (word.value.startsWith("-")) continue;
      }

      remaining.push(word.value);
    }
  }

  return remaining.join(" ");
}

/* ==========================================================================
 * OPERATION 2 — SQL AND CODE IDENTIFIERS
 * ==========================================================================
 * `information_schema.constraint_column_usage` is a catalog table. `LIMIT $1`
 * is grammar. `content_truncated` is a response field current source already
 * emits. An identifier is a NAME for something that exists; naming it is not
 * proposing it.
 *
 * Discriminator: the trigger word is bound inside an identifier (adjacent to
 * `_`, `.`, or a camelCase boundary) or is SQL keyword grammar — both
 * structural, both decidable.
 */
const IDENTIFIER_BOUND = new RegExp(
  [
    // snake_case / dotted identifiers containing the vocabulary
    String.raw`\b\w*_(?:constraint|limit|cap|truncated|trimmed|max)\w*\b`,
    String.raw`\b(?:constraint|limit|cap|truncat|trim|max)\w*_\w+\b`,
    String.raw`\b\w+\.(?:constraint|limit|cap|truncat|trim|max)\w*\b`,
    // SQL grammar
    String.raw`\bLIMIT\s+(\$\d+|\d+|ALL)\b`,
    String.raw`\bCHECK\s*\(`,
    String.raw`\bCONSTRAINTS?\b`,
    String.raw`\badd\s+constraint\b`,
    String.raw`\bdrop\s+constraint\b`,
    // JSON keys and object properties are recorded shapes, not sentences
    String.raw`["']\w*(?:limit|cap|max|truncated|trimmed)\w*["']\s*:`,
    String.raw`\b\w*(?:limit|cap|max|truncated|trimmed)\w*\s*:\s*`,
    String.raw`\.trim\(`,
    // FILE PATHS. A path is a name for a file, and naming one is never a claim
    // about size -- but hyphenated segments are neither snake_case, dotted, nor
    // camelCase, so none of the shapes above reach them. Observed on this
    // lane's own corpus: a commit that DELETES a ceiling, refused because the
    // message FILENAME said so. Any token carrying a path separator or a known
    // file extension is an identifier.
    String.raw`\S*/\S*`,
    String.raw`\b[\w.-]+\.(?:txt|md|json|ts|js|py|sql|ya?ml|sh|log|csv)\b`,
  ].join("|"),
  "i",
);

/** Remove identifier-bound occurrences so only free prose is judged. */
export function stripIdentifiers(text: string): string {
  return text.replace(new RegExp(IDENTIFIER_BOUND.source, "gi"), " ");
}

/* ==========================================================================
 * OPERATION 3 — ATTRIBUTED SPEECH (the operator's own words)
 * ==========================================================================
 * The rule protects the operator's authority over size. Quoting HIM exercising
 * that authority is the rule working, not a breach of it — and the old wall's
 * own closing line already promised "Quoting the operator" was never blocked.
 * It simply had no way to tell.
 *
 * Discriminator: a quotation span carrying an ATTRIBUTION MARKER. The marker
 * must name the speaker; an unattributed quotation is not exempt, because
 * "quote marks" would otherwise be a one-character bypass of the whole wall.
 */
const ATTRIBUTION_MARKER =
  /\b(operator|rico|he\s+said|his\s+own|verbatim|quoted?\s+from|as\s+recorded|your\s+(?:own\s+)?(?:option|options|words|ruling|framing)|recorded\s+(?:in|options)|ruling)\b/i;

/**
 * Remove quotation spans that sit near an attribution marker.
 *
 * "Near" is the same line or the line before, which is how attributed quotes
 * are actually written in this repo's docs ("Operator, 2026-07-30: \"...\"").
 */
export function stripAttributedQuotes(text: string): string {
  const lines = text.split("\n");
  return lines
    .map((line, index) => {
      const context = `${lines[index - 1] ?? ""}\n${line}`;
      if (!ATTRIBUTION_MARKER.test(context)) return line;
      // Strip double-quoted, single-quoted and smart-quoted spans on this line.
      return line
        .replace(/"[^"]*"/g, " ")
        .replace(/“[^”]*”/g, " ")
        .replace(/'[^']{8,}'/g, " ");
    })
    .join("\n");
}

/* ==========================================================================
 * OPERATION 4 — REPORTING WHAT ALREADY EXISTS
 * ==========================================================================
 * A defect report describes behavior that is ALREADY THERE. The 2026-07-30
 * incidents are themselves written up this way, and the wall refused the very
 * write-ups that record why it exists.
 *
 * Discriminator: GRAMMAR. Reporting is past/present indicative about an
 * existing subject ("resume.py truncated content", "get-entry already
 * truncates"). Proposing is modal, imperative, or first-person-plural future
 * ("we should cap", "let's trim", "I propose we truncate").
 *
 * PROPOSING GRAMMAR WINS TIES. A sentence carrying both is treated as a
 * proposal — a report is a fine wrapper to hide a proposal in, and that is the
 * direction the failure has to fall.
 */
const PROPOSING_GRAMMAR = new RegExp(
  [
    String.raw`\b(?:we|i|you|let'?s)\s+(?:should|could|can|will|might|may|must|need\s+to|ought\s+to|propose|suggest|recommend|want\s+to|plan\s+to)\b`,
    String.raw`\b(?:i|we)\s+(?:propose|suggest|recommend|think\s+we|would\s+like)\b`,
    String.raw`\blet'?s\b`,
    String.raw`\b(?:should|shall)\s+(?:we|i|it|the|this|that)\b`,
    // Imperative openings of a proposal
    String.raw`(?:^|[.\n]\s*)(?:add|introduce|set|apply|enforce|impose|start)\s+(?:a|an|the)?\s*\w*\s*(?:cap|limit|ceiling|quota|budget|bound|truncation)\b`,
    // Interrogative offering of a size
    String.raw`\bhow\s+(?:big|large|many|much|long)\b`,
    String.raw`\bwhat\s+(?:size|limit|cap|ceiling|maximum)\b`,
    // Purpose clauses that argue FOR a reduction
    String.raw`\bso\s+(?:the|it|they|we)\s+\w*\s*(?:stays?|remains?|keeps?)\s+(?:small|short|tight|lean|manageable|bounded)\b`,
    String.raw`\bto\s+keep\s+(?:the|it|them|things)\b[^.\n]*\b(?:small|short|tight|lean|manageable|bounded|smaller|leaner)\b`,
  ].join("|"),
  "i",
);

/**
 * Indicative reporting about an EXISTING subject. Only consulted when no
 * proposing grammar is present.
 */
const REPORTING_GRAMMAR = new RegExp(
  [
    String.raw`\b(?:already|currently|existing|existed|has\s+been|had\s+been|used\s+to|since\s+it\s+was)\b`,
    String.raw`\b\w+(?:\.py|\.ts|\.js|\.sql|\(\))\s+\w*\s*(?:truncat|trim|cap|limit|slic)\w*(?:ed|es|s)\b`,
    String.raw`\b(?:was|were|is|are)\s+(?:being\s+)?(?:truncat|trimm|capp|limit|bound)\w*\b`,
    String.raw`\b(?:the\s+)?(?:defect|bug|regression|incident|failure|symptom|finding)\b`,
    String.raw`\bi\s+(?:found|observed|measured|hit|am\s+not\s+proposing)\b`,
    String.raw`\bnot\s+proposing\b`,
    String.raw`\b(?:fix|fixed|removal|removing|deleted?|deleting)\s+(?:was|is|it)\b`,
    // COMMIT-MESSAGE GRAMMAR. A commit message describes work ALREADY DONE, in
    // the imperative mood the git convention requires. That mood is shaped
    // exactly like a proposal's imperative, so mood ALONE cannot separate them
    // -- but a conventional-commit type prefix marks the sentence as a record
    // of a landed change rather than an argument for a future one.
    String.raw`^\s*(?:build|chore|ci|docs|feat|fix|perf|refactor|revert|style|test)(?:\([^)]*\))?!?:`,
    String.raw`\b(?:chore|docs|refactor|revert)\([^)]*\)\s*:`,
    // Cleanup verbs acting on BOOKKEEPING -- registrations, worktrees, caches,
    // branches. These never touch remembered content, and AGENTS.md mandates
    // several of them at session wrap.
    String.raw`\b(?:stale|merged|orphan(?:ed)?|dangling|leftover)\s+(?:registration|registrations|worktree|worktrees|branch|branches|entry|entries|ref|refs)\b`,
    String.raw`\bworktree\s+(?:registration|registrations)\b`,
  ].join("|"),
  "i",
);

export type Intent = "proposal" | "command-syntax" | "identifier" | "quotation" | "report";

/**
 * Classify what a piece of text is DOING with its reduction vocabulary.
 *
 * Order matters and is deliberate. Command syntax and identifiers are resolved
 * first because they are structural and certain; attribution and grammar come
 * after because they read prose. Anything still carrying free-prose trigger
 * vocabulary after all four passes is a PROPOSAL — the fail-closed default.
 */
export function classifyIntent(text: string, isBashCommand: boolean): Intent {
  if (!REDUCTION_VOCABULARY.test(text)) return "report";

  // 1. Sanctioned command syntax (verb/flag position, parsed).
  const afterCommand = isBashCommand ? stripSanctionedCommandSyntax(text) : text;
  if (!REDUCTION_VOCABULARY.test(afterCommand)) return "command-syntax";

  // 2. Identifiers and SQL grammar.
  const withoutIdentifiers = stripIdentifiers(afterCommand);
  if (!REDUCTION_VOCABULARY.test(withoutIdentifiers)) return "identifier";

  // 3. Attributed quotation of the operator.
  const withoutQuotes = stripAttributedQuotes(withoutIdentifiers);
  if (!REDUCTION_VOCABULARY.test(withoutQuotes)) return "quotation";

  // 4. Grammar.
  //
  // JUDGED ON `afterCommand`, NOT on the stripped residue. Passes 2 and 3 exist
  // to answer "is any trigger vocabulary left?", and they delete text to do it
  // -- including the SUBJECT NOUNS that grammar needs to tell a report from a
  // proposal. Observed on this lane's own corpus: a defect report naming a
  // source file lost that filename to the path-identifier rule, and the
  // sentence that remained no longer looked like a report, so it fell through
  // to the fail-closed default. Stripping is for detection; classification
  // reads the sentence as written.
  //
  // Proposing beats reporting on a tie, by design: a report is a comfortable
  // wrapper to hide a proposal in, and that is the direction this has to fall.
  if (PROPOSING_GRAMMAR.test(afterCommand)) return "proposal";
  if (REPORTING_GRAMMAR.test(afterCommand)) return "report";

  // Undecidable -> fail closed. #637: a weaker gate is worse than a noisy one.
  return "proposal";
}
