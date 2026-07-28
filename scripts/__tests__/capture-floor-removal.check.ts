/**
 * The evidence behind docs/decisions/capture-never-drops-a-turn.md.
 *
 * NOT part of `bun test`, hence `.check.ts`: it imports the DEPLOYED adapter by
 * absolute hash-pinned path, which is machine-local and scheduled for deletion
 * by #420. A normal test would break the suite the moment that happens.
 *
 * Run it by hand after touching the capture path:
 *   bun run scripts/__tests__/capture-floor-removal.check.ts
 *
 * WHEN #418 LANDS, port these nine cases into the Python package's real test
 * suite and delete this file. The cases are the point; the import path is not.
 */
import { classifyTurn } from "/Users/rico/.local/share/openbrain-memory/adapters/versions/sha256-cd5fb4e4d7f940f5ec0cb5b6ac4bf5ce615d22ebb566d27f665bfa36abfba3a2/ob-memory-provider/turn-capture.ts";

const cases: [string, string, boolean][] = [
  ["short: yes", "yes", true],
  ["short: ok", "ok", true],
  ["short: no do it", "no do it", true],
  ["the doubt case", "okay", true],
  ["under the old floor (23 chars)", "use postgres not sqlite", true],
  ["empty", "", false],
  ["whitespace only", "   \n  ", false],
  ["system reminder only", "<system-reminder>blah</system-reminder>", false],
  [
    "pasted terminal",
    "❯ cd open-brain\n⏺ Bash(ls)\n⎿  total 48\n✻ Thinking\n" +
      "─".repeat(40) +
      "\nwe decided to use postgres",
    false,
  ],
];

let pass = 0,
  fail = 0;
for (const [name, input, shouldClassify] of cases) {
  const got = classifyTurn(input);
  const ok = shouldClassify ? got !== null : got === null;
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name.padEnd(32)} -> ${got ? `${got.eventType}` : "null"}`,
  );
  ok ? pass++ : fail++;
}
console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
