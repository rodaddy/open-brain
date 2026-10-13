/**
 * The grading page, as one self-contained HTML string. Issue #394.
 *
 * WHY A STRING IN A .ts FILE. There is no bundler, no template engine, and no
 * static-file serving anywhere in this repo (`rg` finds zero uses of
 * express.static or sendFile). Keeping the page as an exported constant means
 * `bun run grade` works from any working directory with no path resolution and
 * no build step -- the same property that makes scripts/dream-light-run.ts
 * runnable without ceremony.
 *
 * WHY IT IS SEVERAL FILES NOW (issue #864). The page outgrew a single module.
 * The template text is unchanged and lives in sibling files, one per HTML/CSS/JS
 * section; this module rejoins them with a newline between each, which is
 * exactly the newline the original single literal carried at each split point.
 * The composed string is byte-identical to the pre-split constant, and
 * `scripts/done-means/864-l6-move-grading-page.sh` is what holds that.
 *
 * FORM AND SEND, NOT KEYSTROKE AND WRITE. This is the page's governing shape and
 * it is the operator's, verbatim, 2026-07-28: "i would expect i fill it out and
 * hit send or something, that takes the current page out with the info go'n to
 * the server (NOT directly into the table(s))" and "also with a way to reset,
 * undo, change i needed". The previous build fired a POST on every grade key, so
 * a mis-hit was already in the table before it could be read back. Nothing here
 * reaches the server until SEND. Picking a grade stages it locally; the pending
 * batch is a visible, editable, removable list; Send commits the whole batch in
 * one transaction.
 *
 * THE PENDING BATCH IS PERSISTED TO localStorage, AND THAT IS NOT A CACHE. There
 * are 1,104 items to grade. A closed tab, a reload, or a laptop lid halfway
 * through a session must not destroy staged judgement, because the judgement is
 * the expensive part -- re-reading twenty candidates to reconstruct what you
 * already decided is exactly the friction that ends the slog. It stays purely
 * local: persisting it sends nothing, so the "nothing until Send" contract is
 * intact and the durability is free.
 *
 * KEYS ARE ACCELERATORS, NEVER SUBMITTERS. 1/2/3/4 select a grade in the form
 * (they do not stage and they do not send), Enter stages the current item,
 * Ctrl+Enter sends the batch, Escape resets the form. The distinction is the
 * whole point of the rebuild: a key that writes to the database is the failure
 * mode being removed. Speed still matters -- gbrain's precedent is "they graded
 * ALL of it. It was a big giant slug that was super annoying to do", and
 * dream-design.md:825-827 says "20 is reviewable, 200 gets skipped" -- so the
 * accelerators stay, they just accelerate staging instead of committing.
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE. dream-design.md contains no text on page
 * layout, column set, or ranking-widget-vs-per-item-grading, and :1363-1365 says
 * "Do not invent answers to these during implementation." So this page implements
 * what the operator asked for and nothing more; the ordinal-ranking surface
 * :785-786 anticipates is NOT built, and the open question of whether the page is
 * ceremony at all (:1372) stays open.
 *
 * CONTENT IS INSERTED WITH textContent, NEVER innerHTML. Candidate content is
 * real dialogue and routinely contains code, angle brackets, and markup. This is
 * a correctness requirement before it is a security one: `innerHTML` would render
 * a captured HTML snippet instead of showing it, which is the one thing a
 * reviewer must be able to read verbatim.
 *
 * THE OPERATOR'S WORDS LEAD THE CARD (migration 041). For an `exchange`, the
 * operator's own turn is rendered at the TOP as the thing being graded, and the
 * agent response and tool calls sit below it as the body. Operator, verbatim,
 * 2026-07-28: "my part of the conversation should be the first thing, anything
 * below that can be agent response and maybe tool calls to get there". This is
 * not cosmetic ordering -- the defect it fixes was the operator being asked to
 * grade the AGENT's middle sentence while his own turn sat in the context panel,
 * which makes the grade a judgement of a fragment of his own conversation rather
 * than of the interaction.
 *
 * CANNED REASONS INSERT TEXT, THEY DO NOT REPLACE THE NOTE (migration 042).
 * Operator, verbatim: "so the can'd response if i click one, should allow me to
 * put it into the notes for adjustment and/or the note section stays to allow me
 * to add a little color". So a reason button APPENDS its sentence into the
 * textarea, which stays editable and always visible; a second click appends
 * rather than overwrites; and the reason_code is recorded beside whatever the
 * note finally says, so editing the text cannot erase which reason was chosen.
 *
 * THE AGENT-BEHAVIOR CONTROL IS A SEPARATE AXIS AND IS DRAWN THAT WAY. It sits
 * in its own bordered block with its own heading, below the memory grade, so it
 * cannot be mistaken for a fifth grade value -- and it is optional, so nothing
 * refuses to stage without it. 042's header has the argument for why the two
 * must not be one control: a useless memory can come from excellent agent
 * behavior and a valuable memory from the agent screwing up.
 */

import { GRADING_REASON_PAYLOAD } from "../grading-reasons.ts";
import { GRADING_PAGE_HEAD } from "./head.ts";
import { GRADING_PAGE_BODY } from "./body.ts";
import { GRADING_PAGE_SCRIPT_OPEN } from "./script-open.ts";
import { GRADING_PAGE_SCRIPT_STATE } from "./script-state.ts";
import { GRADING_PAGE_SCRIPT_FORM } from "./script-form.ts";
import { GRADING_PAGE_SCRIPT_BATCH } from "./script-batch.ts";
import { GRADING_PAGE_SCRIPT_HISTORY } from "./script-history.ts";

/**
 * The reason vocabulary, inlined into the page.
 *
 * There is no bundler, so this is how the page and the server share ONE
 * definition (server/domain/grading-reasons.ts) instead of two lists that drift
 * until the page offers a button the server 400s -- which, because a batch is one
 * transaction, would roll back the operator's whole session's worth of grading
 * at SEND.
 *
 * JSON.stringify is safe to interpolate here because the payload is entirely
 * module-authored constants: no candidate content, no operator input, nothing
 * from the database ever reaches this string. The one sequence that could break
 * out of a <script> element is "</script" inside a string literal, which cannot
 * occur in a set of hand-written kebab-case codes and plain-English labels --
 * and the escape below removes even that possibility rather than relying on it.
 */
const REASON_PAYLOAD_JSON = JSON.stringify(GRADING_REASON_PAYLOAD).replace(
  /<\//g,
  "<\\/",
);

/** The one interpolated line of the page: the vocabulary handed to the script. */
const VOCAB_LINE = String.raw`  const VOCAB = ${REASON_PAYLOAD_JSON};`;

type GradingPageOptions = {
  readonly blind?: boolean;
  readonly snapshotSha256?: string;
};

function modeLines(options: GradingPageOptions): string {
  const blind = options.blind ?? false;
  const snapshotSha256 = options.snapshotSha256 ?? null;
  if (blind && !/^[a-f0-9]{64}$/i.test(snapshotSha256 ?? "")) {
    throw new Error("blind grading page requires a 64-character hex snapshotSha256");
  }
  return String.raw`  const BLIND_MODE = ${blind};
  const SNAPSHOT_SHA256 = ${JSON.stringify(snapshotSha256)};`;
}

export function createGradingPageHtml(options: GradingPageOptions = {}): string {
  return [
    GRADING_PAGE_HEAD,
    GRADING_PAGE_BODY,
    GRADING_PAGE_SCRIPT_OPEN,
    VOCAB_LINE,
    modeLines(options),
    GRADING_PAGE_SCRIPT_STATE,
    GRADING_PAGE_SCRIPT_FORM,
    GRADING_PAGE_SCRIPT_BATCH,
    GRADING_PAGE_SCRIPT_HISTORY,
  ].join("\n");
}

export const GRADING_PAGE_HTML = createGradingPageHtml();
