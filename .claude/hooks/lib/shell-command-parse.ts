/**
 * shell-command-parse — the shared, #618-proof command parser for repo hooks.
 *
 * WHY THIS MODULE EXISTS
 *
 * `.claude/hooks/pr-body-gate.ts` (ledger item 17) established the pattern that
 * keeps a Bash PreToolUse gate from becoming a tax: judge by PARSED ARGUMENTS,
 * never by text matching. Issue #618 is this repo's standing receipt for the
 * alternative — a git guard that matched protected-branch names inside heredoc
 * TEXT rather than in the command being run, and charged every lane for it.
 *
 * When merge-gate.ts arrived needing exactly the same tokenizer, there were two
 * options: copy it, or share it. A copy is the drift this repo's own SME
 * knowledge warns about (`sme.duplicated_selection_lists_diverge`): the two
 * copies would be identical on the day of the split and would silently diverge
 * afterwards, so a #618 fix landing in one would leave the other still taxing
 * lanes. So the parser is extracted HERE and both gates import it.
 *
 * The behavioural contract is unchanged from pr-body-gate.ts. Its own
 * done-means check (`scripts/done-means/pr-body-gate-fires.sh`, clauses 4a-4c)
 * and merge-gate's (clauses 5a-5c) both exercise this code, so a regression in
 * the shared tokenizer fails two checks rather than none.
 *
 * THE RULES, in one place:
 *
 *   - heredoc BODIES are stripped before parsing. A heredoc body is data the
 *     shell feeds a process; it is not command syntax and must never be scanned
 *     for one.
 *   - tokenization honours shell quoting, and records whether a token came from
 *     inside quotes. A quoted token is a VALUE — never an executable name,
 *     never a separator, never a flag.
 *   - command splitting happens on UNQUOTED separators only.
 *   - leading env assignments and `env`/`command` wrappers are skipped so a
 *     habitual prefix does not trivially evade a gate.
 */

export type Token = { value: string; quoted: boolean };

/**
 * Remove heredoc BODIES from a command string, leaving the redirection operator.
 *
 * Handles `<<WORD`, `<<'WORD'`, `<<"WORD"`, and the `<<-` indented form (whose
 * terminator may be preceded by tabs).
 */
export function stripHeredocBodies(command: string): string {
  const lines = command.split("\n");
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    out.push(line);
    i += 1;

    // Collect every heredoc opened on this line, in order.
    const opens = [...line.matchAll(/<<(-?)\s*(["']?)([A-Za-z_][A-Za-z0-9_]*)\2/g)];
    for (const open of opens) {
      const dashed = open[1] === "-";
      const terminator = open[3]!;
      while (i < lines.length) {
        const candidate = dashed ? lines[i]!.replace(/^\t+/, "") : lines[i]!;
        i += 1;
        if (candidate.trim() === terminator) break;
      }
    }
  }

  return out.join("\n");
}

/**
 * Tokenize with shell quoting rules.
 *
 * `quoted` records whether any part of the token came from inside quotes. That
 * flag is what keeps `echo 'gh pr merge 999'` from ever being read as a command:
 * the whole phrase is ONE token, and a quoted token is never treated as an
 * executable name or a separator.
 */
export function tokenize(command: string): Token[] {
  const tokens: Token[] = [];
  let current = "";
  let quoted = false;
  let started = false;
  let mode: "none" | "single" | "double" = "none";

  const push = () => {
    if (started) tokens.push({ value: current, quoted });
    current = "";
    quoted = false;
    started = false;
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!;

    if (mode === "single") {
      if (ch === "'") mode = "none";
      else current += ch;
      continue;
    }

    if (mode === "double") {
      if (ch === '"') mode = "none";
      else if (ch === "\\" && i + 1 < command.length) {
        i += 1;
        current += command[i]!;
      } else current += ch;
      continue;
    }

    if (ch === "'") {
      mode = "single";
      quoted = true;
      started = true;
      continue;
    }
    if (ch === '"') {
      mode = "double";
      quoted = true;
      started = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      i += 1;
      current += command[i]!;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }

    current += ch;
    started = true;
  }

  push();
  return tokens;
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "&", "\n"]);

/**
 * Split a token stream into simple commands on UNQUOTED separators.
 *
 * `a && gh pr merge 1` must still be inspected; `echo '&& gh pr merge 1'` must
 * not be split at all, because that separator is inside a quoted token.
 */
export function splitCommands(tokens: Token[]): Token[][] {
  const commands: Token[][] = [];
  let current: Token[] = [];

  for (const token of tokens) {
    if (!token.quoted && SEPARATORS.has(token.value)) {
      if (current.length > 0) commands.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  if (current.length > 0) commands.push(current);
  return commands;
}

/** Parse a raw command string into simple commands, heredoc bodies removed. */
export function parseSimpleCommands(rawCommand: string): Token[][] {
  return splitCommands(tokenize(stripHeredocBodies(rawCommand)));
}

/**
 * Drop leading env assignments and common wrappers so `FOO=1 command gh pr ...`
 * and `env X=y gh pr ...` still resolve to `gh`. Deliberately small: this is
 * about not being trivially evaded by a habitual prefix, not about emulating a
 * shell.
 */
export function executableWords(command: Token[]): Token[] {
  let index = 0;
  while (index < command.length) {
    const token = command[index]!;
    if (!token.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token.value)) {
      index += 1;
      continue;
    }
    if (!token.quoted && (token.value === "env" || token.value === "command")) {
      index += 1;
      continue;
    }
    break;
  }
  return command.slice(index);
}

export function isGhBinary(word: string): boolean {
  if (word === "gh") return true;
  // An absolute or relative path to the gh binary is still gh.
  return /(^|\/)gh$/.test(word) && word.includes("/");
}

/**
 * Walk a simple command to its `gh <subcommand> <verb>` shape.
 *
 * Returns the remaining words AFTER the verb (the command's own options) when
 * the command really is `gh <subcommand> <verb>`, else null. Skips gh's global
 * flags between `gh` and the subcommand (e.g. `--repo owner/name`).
 *
 * Everything here is positional and flag-shaped, which is why a command that
 * does not have this shape is allowed untouched by every gate built on it.
 */
export function matchGhCommand(
  command: Token[],
  subcommand: string,
  verbs: readonly string[],
): { verb: string; rest: Token[] } | null {
  const words = executableWords(command);
  const first = words[0];
  if (!first || first.quoted || !isGhBinary(first.value)) return null;

  let index = 1;
  const globalWithValue = new Set(["--repo", "-R"]);
  while (index < words.length) {
    const word = words[index]!;
    if (word.quoted || !word.value.startsWith("-")) break;
    if (word.value.includes("=")) index += 1;
    else if (globalWithValue.has(word.value)) index += 2;
    else index += 1;
  }

  const sub = words[index];
  if (!sub || sub.quoted || sub.value !== subcommand) return null;
  const verbToken = words[index + 1];
  if (!verbToken || verbToken.quoted) return null;
  if (!verbs.includes(verbToken.value)) return null;

  return { verb: verbToken.value, rest: words.slice(index + 2) };
}

/**
 * Read the first bare (non-flag, unquoted-position) argument of a command's
 * option list — for `gh pr merge 999 --squash` that is `999`.
 *
 * Flags that take a separate value are skipped so their VALUE is never mistaken
 * for the positional argument.
 */
export function firstPositional(
  rest: Token[],
  flagsWithValues: ReadonlySet<string>,
): string | null {
  let i = 0;
  while (i < rest.length) {
    const word = rest[i]!;
    if (!word.quoted && word.value.startsWith("-")) {
      const eq = word.value.indexOf("=");
      const flag = eq === -1 ? word.value : word.value.slice(0, eq);
      if (eq === -1 && flagsWithValues.has(flag)) i += 2;
      else i += 1;
      continue;
    }
    return word.value;
  }
  return null;
}
