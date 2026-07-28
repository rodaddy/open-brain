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

import { GRADING_REASON_PAYLOAD } from "./grading-reasons.ts";

/**
 * The reason vocabulary, inlined into the page.
 *
 * There is no bundler, so this is how the page and the server share ONE
 * definition (src/grading-reasons.ts) instead of two lists that drift until the
 * page offers a button the server 400s -- which, because a batch is one
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

export const GRADING_PAGE_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open Brain -- candidate grading</title>
<style>
  :root {
    --bg: #12141a; --panel: #1a1d26; --panel2: #22262f; --line: #2f3542;
    --fg: #e6e9ef; --dim: #98a0b3; --accent: #6ea8fe;
    --pass: #4ade80; --fail: #f87171; --inc: #fbbf24; --dup: #a78bfa;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--fg);
    font: 14px/1.55 ui-sans-serif, -apple-system, "SF Pro Text", system-ui, sans-serif;
  }
  header {
    position: sticky; top: 0; z-index: 10; background: var(--panel);
    border-bottom: 1px solid var(--line); padding: 9px 16px;
    display: flex; gap: 16px; align-items: center; flex-wrap: wrap;
  }
  header .title { font-weight: 650; letter-spacing: .2px; }
  header .stat { color: var(--dim); font-variant-numeric: tabular-nums; }
  header .stat b { color: var(--fg); font-weight: 600; }
  .layout {
    display: grid; grid-template-columns: minmax(0, 1fr) 380px; gap: 18px;
    max-width: 1500px; margin: 0 auto; padding: 16px 16px 92px; align-items: start;
  }
  @media (max-width: 1080px) { .layout { grid-template-columns: minmax(0, 1fr); } }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 15px; }
  .row { display: flex; gap: 9px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
  .tag {
    font-size: 11.5px; text-transform: uppercase; letter-spacing: .6px;
    padding: 2px 8px; border-radius: 999px; border: 1px solid var(--line);
    background: var(--panel2); color: var(--dim);
  }
  .tag.type { color: var(--accent); border-color: #33507d; }
  .tag.uncertain { color: var(--inc); border-color: #6b5310; }
  .tag.machine { color: var(--dup); border-color: #4a3d78; }
  .tag.reinforced { color: var(--pass); border-color: #26603d; }
  .content {
    background: var(--panel2); border: 1px solid var(--line); border-radius: 8px;
    padding: 13px; font-size: 15.5px; white-space: pre-wrap; word-break: break-word;
    max-height: 320px; overflow: auto;
  }
  .reason { color: var(--inc); font-size: 13px; margin-top: 9px; white-space: pre-wrap; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .8px;
       color: var(--dim); margin: 18px 0 8px; font-weight: 600; }
  h2:first-child { margin-top: 0; }
  .turn {
    border-left: 3px solid var(--line); padding: 6px 0 6px 11px; margin-bottom: 6px;
    white-space: pre-wrap; word-break: break-word; font-size: 13px; color: #cdd3de;
  }
  .turn.src { border-left-color: var(--accent); background: #1c2130; }
  .turn .who {
    font-size: 11px; text-transform: uppercase; letter-spacing: .6px;
    color: var(--dim); margin-bottom: 3px;
  }
  .turn.src .who { color: var(--accent); }
  .turn .body { max-height: 200px; overflow: auto; }
  .warn {
    background: #3a1d1d; border: 1px solid #6b2a2a; color: #ffb4b4;
    padding: 10px 12px; border-radius: 8px; font-size: 13px;
  }
  footer {
    position: fixed; bottom: 0; left: 0; right: 0; background: var(--panel);
    border-top: 1px solid var(--line); padding: 8px 16px;
    display: flex; gap: 14px; align-items: center; flex-wrap: wrap; font-size: 12.5px;
  }
  kbd {
    background: var(--panel2); border: 1px solid var(--line); border-bottom-width: 2px;
    border-radius: 5px; padding: 1px 6px; font: 11.5px ui-monospace, monospace; color: var(--fg);
  }
  .msg { color: var(--dim); margin-left: auto; }
  .msg.err { color: var(--fail); }
  .msg.ok { color: var(--pass); }
  button {
    background: var(--panel2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 5px 11px; font: inherit; font-size: 13px; cursor: pointer;
  }
  button:hover:not(:disabled) { border-color: var(--accent); }
  button:disabled { opacity: .45; cursor: default; }
  button.primary { background: #1d3a5c; border-color: #33507d; color: #cfe3ff; font-weight: 600; }
  button.danger:hover:not(:disabled) { border-color: var(--fail); }
  /* The grade form: radios styled as buttons, but real radios underneath so the
     selection is keyboard- and screen-reader-addressable and the form has one
     source of truth. */
  .grades { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0 10px; }
  .grades label {
    display: inline-flex; align-items: center; gap: 7px; cursor: pointer;
    border: 1px solid var(--line); background: var(--panel2);
    border-radius: 7px; padding: 7px 13px; font-size: 13.5px; user-select: none;
  }
  .grades input { accent-color: var(--accent); margin: 0; }
  .grades label.g-promoted.on { border-color: var(--pass); color: var(--pass); background: #16281d; }
  .grades label.g-rejected.on { border-color: var(--fail); color: var(--fail); background: #2b1818; }
  .grades label.g-inconclusive.on { border-color: var(--inc); color: var(--inc); background: #2a2312; }
  .grades label.g-duplicate.on { border-color: var(--dup); color: var(--dup); background: #241d33; }
  .grades label .num { color: var(--dim); font-size: 11px; }
  textarea.note {
    width: 100%; min-height: 66px; resize: vertical; background: var(--panel2);
    color: var(--fg); border: 1px solid var(--line); border-radius: 7px;
    padding: 9px 10px; font: inherit; font-size: 13.5px;
  }
  /* THE OPERATOR'S OWN TURN, at the top of an exchange card and visibly the
     thing being graded. Bigger, brighter, and accent-bordered so it reads as the
     subject rather than as one more quoted turn -- 041 exists because the
     operator was grading the agent's sentence while his own sat below. */
  .op-lead {
    border: 1px solid #33507d; border-left: 4px solid var(--accent);
    background: #172033; border-radius: 8px; padding: 12px 14px;
    margin-bottom: 12px;
  }
  .op-lead .who {
    font-size: 11px; text-transform: uppercase; letter-spacing: .7px;
    color: var(--accent); margin-bottom: 5px; font-weight: 600;
  }
  .op-lead .body {
    font-size: 16px; white-space: pre-wrap; word-break: break-word;
    max-height: 300px; overflow: auto;
  }
  /* The agent side of the exchange, below the operator's words. Dimmer and
     labelled, because it is the body of what is being graded, not the head. */
  .agent-body { margin-top: 4px; }
  .agent-body > h2 { margin-top: 12px; }
  /* Canned reasons: small, scannable, one row. They insert text into the note;
     they never submit and never replace the note. */
  .reasons { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 8px; }
  .reasons button { padding: 3px 9px; font-size: 12px; }
  .reasons button.picked { border-color: var(--accent); color: #cfe3ff; background: #1d3a5c; }
  .reasons .hint { color: var(--dim); font-size: 12px; align-self: center; }
  /* The SECOND AXIS, in its own bordered block with its own heading so it can
     never be read as a fifth grade value. Optional, and it says so. */
  .behavior {
    border: 1px dashed var(--line); border-radius: 8px; padding: 9px 11px;
    margin-top: 12px; background: #171a22;
  }
  .behavior .axis-title {
    font-size: 11px; text-transform: uppercase; letter-spacing: .7px;
    color: var(--dim); margin-bottom: 6px; font-weight: 600;
  }
  .behavior .opts { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; }
  .behavior label {
    display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
    border: 1px solid var(--line); background: var(--panel2);
    border-radius: 7px; padding: 5px 11px; font-size: 13px; user-select: none;
  }
  .behavior input { accent-color: var(--accent); margin: 0; }
  .behavior label.b-good.on { border-color: var(--pass); color: var(--pass); background: #16281d; }
  .behavior label.b-bad.on { border-color: var(--fail); color: var(--fail); background: #2b1818; }
  .behavior label.b-neutral.on { border-color: var(--dim); color: var(--fg); background: var(--panel2); }
  .behavior .clear { margin-left: 4px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 11px; align-items: center; }
  .side { position: sticky; top: 58px; display: flex; flex-direction: column; gap: 14px; }
  .batch-list { max-height: 46vh; overflow: auto; display: flex; flex-direction: column; gap: 7px; }
  .staged {
    border: 1px solid var(--line); border-radius: 7px; background: var(--panel2);
    padding: 8px 9px; font-size: 12.5px;
  }
  .staged .head { display: flex; gap: 7px; align-items: center; margin-bottom: 4px; }
  .staged .act { font-weight: 650; text-transform: uppercase; letter-spacing: .5px; font-size: 11px; }
  .staged .act.promoted { color: var(--pass); }
  .staged .act.rejected { color: var(--fail); }
  .staged .act.inconclusive { color: var(--inc); }
  .staged .act.duplicate { color: var(--dup); }
  .staged .snippet {
    color: #c3c9d6; white-space: pre-wrap; word-break: break-word;
    max-height: 44px; overflow: hidden;
  }
  .staged .n { color: var(--dim); font-style: italic; margin-top: 3px;
    white-space: pre-wrap; word-break: break-word; }
  .staged .btns { margin-left: auto; display: flex; gap: 5px; }
  .staged button { padding: 1px 7px; font-size: 11.5px; }
  .empty { color: var(--dim); font-size: 13px; padding: 6px 0; }
  .hist { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
  .hist .item {
    border: 1px solid var(--line); border-radius: 7px; background: var(--panel2);
    padding: 9px 10px; font-size: 12.5px;
  }
  .hist .item.superseded { opacity: .55; }
  .hist .meta { color: var(--dim); font-size: 11.5px; margin-top: 4px;
    display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  /* The regrade picker: one button per grade, coloured like the form's radios so
     "change to fail" looks the same here as it does on the card. */
  .hist .meta button { padding: 1px 8px; font-size: 11.5px; }
  .hist .meta button.g-promoted:hover { border-color: var(--pass); color: var(--pass); }
  .hist .meta button.g-rejected:hover { border-color: var(--fail); color: var(--fail); }
  .hist .meta button.g-inconclusive:hover { border-color: var(--inc); color: var(--inc); }
  .hist .meta button.g-duplicate:hover { border-color: var(--dup); color: var(--dup); }
  dialog {
    background: var(--panel); color: var(--fg); border: 1px solid var(--line);
    border-radius: 11px; padding: 0; max-width: 900px; width: 92vw; max-height: 84vh;
  }
  dialog::backdrop { background: rgba(0,0,0,.62); }
  dialog .dlg-head {
    display: flex; align-items: center; gap: 12px; padding: 12px 15px;
    border-bottom: 1px solid var(--line); position: sticky; top: 0; background: var(--panel);
  }
  dialog .dlg-body { padding: 14px 15px; overflow: auto; max-height: 68vh; }
  .sep { color: var(--line); }
</style>
</head>
<body>
<header>
  <span class="title">Candidate grading</span>
  <span class="stat">item <b id="pos">-</b></span>
  <span class="stat">ungraded <b id="ungraded">-</b></span>
  <span class="stat">graded <b id="graded">-</b></span>
  <span class="stat">staged <b id="staged-count">0</b></span>
  <span class="stat">sent this session <b id="sent-count">0</b></span>
  <span class="stat">pass <b id="a-promoted">0</b> / fail <b id="a-rejected">0</b>
        / inc <b id="a-inconclusive">0</b> / dup <b id="a-duplicate">0</b></span>
  <span class="stat">machine agreement <b id="agree">n/a</b></span>
  <span class="stat" title="The second axis: how the agent behaved, counted over live grades only.">agent good <b id="b-good">0</b> / bad <b id="b-bad">0</b>
        / neutral <b id="b-neutral">0</b></span>
  <span class="stat" id="mode-label"></span>
</header>

<div class="layout">
  <main>
    <div id="stage"></div>
  </main>

  <aside class="side">
    <div class="card">
      <h2>pending batch (<span id="batch-n">0</span>) -- nothing sent yet</h2>
      <div id="batch-list" class="batch-list"></div>
      <div class="actions">
        <button id="send" class="primary" type="button">SEND BATCH</button>
        <button id="clear-batch" class="danger" type="button">Clear batch</button>
      </div>
    </div>

    <div class="card">
      <h2>after sending</h2>
      <div class="actions">
        <button id="undo-batch" type="button" disabled>Undo last batch</button>
        <button id="open-history" type="button">History / change a grade</button>
      </div>
      <div id="last-batch" class="empty">No batch sent from this page yet.</div>
    </div>
  </aside>
</div>

<footer>
  <span><kbd>1</kbd><kbd>2</kbd><kbd>3</kbd><kbd>4</kbd> pick grade</span>
  <span><kbd>Enter</kbd> add to batch</span>
  <span><kbd>Ctrl</kbd>+<kbd>Enter</kbd> send batch</span>
  <span><kbd>Esc</kbd> reset form</span>
  <span><kbd>&larr;</kbd><kbd>&rarr;</kbd> move</span>
  <span><kbd>n</kbd> note</span>
  <span><kbd>q</kbd><kbd>w</kbd><kbd>e</kbd><kbd>r</kbd> quick reason</span>
  <span><kbd>g</kbd><kbd>b</kbd><kbd>v</kbd> agent good/bad/neutral</span>
  <span id="msg" class="msg"></span>
</footer>

<dialog id="history">
  <div class="dlg-head">
    <b>Grade history</b>
    <span class="stat" id="hist-total"></span>
    <span class="msg" id="hist-msg"></span>
    <button id="hist-close" type="button" style="margin-left:auto">Close</button>
  </div>
  <div class="dlg-body"><div id="hist-list" class="hist"></div></div>
</dialog>

<script>
(() => {
  "use strict";

  // Keys select a grade in the form. They do NOT stage and they do NOT send --
  // that separation is the entire rebuild.
  const ACTIONS = { "1": "promoted", "2": "rejected", "3": "inconclusive", "4": "duplicate" };
  const ORDER = ["promoted", "rejected", "inconclusive", "duplicate"];
  const LABELS = { promoted: "pass", rejected: "fail", inconclusive: "inconclusive", duplicate: "duplicate" };
  // The canned reasons and the behavior vocabulary, inlined from
  // src/grading-reasons.ts at build time. ONE definition shared with the server,
  // so this page cannot offer a code the write path rejects at SEND.
  const VOCAB = ${REASON_PAYLOAD_JSON};
  const REASONS = VOCAB.reasons;
  const BEHAVIORS = VOCAB.behaviors;
  const BEHAVIOR_LABELS = VOCAB.behaviorLabels;
  // Positional accelerators for the reason row (index into the OFFERED list,
  // which depends on the selected grade) and fixed ones for the behavior axis.
  // Chosen to sit under the left hand while 1-4 pick the grade, and to avoid
  // the existing bindings: n (note), j/k (move).
  const REASON_KEYS = { q: 0, w: 1, e: 2, r: 3, t: 4, y: 5 };
  const BEHAVIOR_KEYS = { g: "good", b: "bad", v: "neutral" };
  // Versioned so a future shape change discards an incompatible saved batch
  // instead of half-reading it into the form.
  const STORE_KEY = "ob.grading.batch.v1";
  const LAST_BATCH_KEY = "ob.grading.lastBatch.v1";

  const el = (id) => document.getElementById(id);

  /** Set a counter's text, tolerating an element that is not on the page. */
  function setText(id, value) {
    const n = el(id);
    if (n) n.textContent = value;
  }

  const state = {
    items: [],
    idx: 0,
    total: 0,
    // The staged batch: the only place a judgement lives before Send. Array, not
    // a map, because order is what the operator sees and can reason about.
    batch: [],
    sent: 0,
    lastBatchId: null,
    lastBatchSize: 0,
    busy: false,
    mode: "queue",
    // The in-progress form, kept out of the DOM so a re-render (navigation,
    // reload of the page's queue) cannot silently lose a half-written note.
    //
    // reasonCode and note are SEPARATE fields on purpose (042). Clicking a
    // reason seeds the note text and sets the code; editing the text afterwards
    // touches only the note text, so the code survives an edit -- which is the
    // operator's stated requirement that a canned reason go "into the notes for
    // adjustment" without ceasing to be an identifiable reason.
    //
    // agentBehavior is null until rated, and null is what gets sent. It is never
    // defaulted to "neutral": an unrated item and an item rated unremarkable are
    // different facts, and 042 keeps them apart in the column too.
    form: { action: null, note: "", reasonCode: null, agentBehavior: null },
  };

  function say(text, kind) {
    const m = el("msg");
    m.textContent = text || "";
    m.className = "msg" + (kind ? " " + kind : "");
  }

  function fmtPct(rate) {
    return rate === null || rate === undefined ? "n/a" : Math.round(rate * 100) + "%";
  }

  // ---- local durability -----------------------------------------------------
  // Persisting the batch sends nothing. It exists so a reload or a closed tab
  // cannot destroy staged judgement across 1,104 items.

  function persist() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state.batch));
    } catch (e) {
      // Quota or a private-mode block. The batch is still in memory and still
      // sendable, so this is a warning, not a failure -- but the operator has to
      // know durability is gone before they close the tab believing otherwise.
      say("batch not saved locally (" + e.message + ") -- send before closing", "err");
    }
  }

  function restore() {
    let raw = null;
    try { raw = localStorage.getItem(STORE_KEY); } catch { return; }
    if (!raw) return;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!Array.isArray(parsed)) return;
    // Re-validate rather than trusting storage: a stale or hand-edited entry
    // must not be able to put an action the server will reject into a batch the
    // operator then sends as a unit.
    state.batch = parsed.filter((g) =>
      g && typeof g.candidateId === "string" && ORDER.indexOf(g.action) >= 0);
    try {
      const lb = JSON.parse(localStorage.getItem(LAST_BATCH_KEY) || "null");
      if (lb && typeof lb.batch_id === "string") {
        state.lastBatchId = lb.batch_id;
        state.lastBatchSize = lb.size || 0;
      }
    } catch { /* no last batch is the normal first-run case */ }
  }

  function rememberLastBatch(id, size) {
    state.lastBatchId = id;
    state.lastBatchSize = size;
    try {
      localStorage.setItem(LAST_BATCH_KEY,
        id === null ? "null" : JSON.stringify({ batch_id: id, size: size }));
    } catch { /* undo still works this session without it */ }
  }

  // ---- server ---------------------------------------------------------------

  async function api(path, options) {
    const res = await fetch(path, options);
    let body = null;
    try { body = await res.json(); } catch { /* a non-JSON error page is still an error */ }
    if (!res.ok) {
      const err = new Error((body && body.error) || ("HTTP " + res.status));
      err.status = res.status;
      throw err;
    }
    return body;
  }

  async function refreshStats() {
    const s = await api("/api/stats");
    el("ungraded").textContent = s.ungraded;
    el("graded").textContent = s.graded;
    el("a-promoted").textContent = s.by_action.promoted;
    el("a-rejected").textContent = s.by_action.rejected;
    el("a-inconclusive").textContent = s.by_action.inconclusive;
    el("a-duplicate").textContent = s.by_action.duplicate;
    // Guarded with a fallback: /api/stats is also served by an older deployment
    // during a rolling restart, and a missing key would throw here and blank the
    // whole readout rather than one counter.
    const ab = (s.agent_behavior && s.agent_behavior.by_value) || {};
    // setText, not a direct assignment: this is the LAST thing refreshStats
    // does before render() is reached, so a null element here would throw and
    // take the whole queue down with it -- a missing header counter is a
    // cosmetic problem and must not be able to blank the page.
    setText("b-good", ab.good || 0);
    setText("b-bad", ab.bad || 0);
    setText("b-neutral", ab.neutral || 0);
    // A constant grader makes the rate un-interpretable, so say that instead of
    // showing a percentage that only reflects the operator's own action mix.
    // Measured 2026-07-28: REM emitted one grade value for 1103 of 1104 rows.
    const ma = s.machine_agreement;
    const a = el("agree");
    if (ma.compared === 0) {
      a.textContent = "n/a";
      a.title = "no candidate has both a human and a machine grade yet";
    } else if (ma.distinct_machine_grades <= 1) {
      a.textContent = fmtPct(ma.rate) + " (" + ma.compared + ", machine is constant -- not a trust signal)";
      a.title =
        "REM emitted only one distinct grade, so this rate measures your own " +
        "action mix, not whether the machine can be trusted. The missing " +
        "one-off rule is an open design hole (dream-design.md:817-821).";
    } else {
      a.textContent = fmtPct(ma.rate) + " (" + ma.compared + ")";
      a.title = ma.distinct_machine_grades + " distinct machine grades compared";
    }
    return s;
  }

  async function loadPage(mode) {
    state.mode = mode || state.mode;
    const path = state.mode === "inconclusive" ? "/api/inconclusive" : "/api/queue";
    const data = await api(path + "?limit=50");
    // Items already staged are dropped from the queue view: showing an item the
    // operator has judged but not yet sent invites grading it twice, and the
    // server rejects a batch with a duplicate candidate.
    const stagedIds = new Set(state.batch.map((g) => g.candidateId));
    state.items = data.items.filter((i) => !stagedIds.has(i.id));
    state.total = data.total;
    state.idx = 0;
    resetForm();
    el("mode-label").textContent =
      state.mode === "inconclusive" ? "reviewing INCONCLUSIVE items" : "";
    await refreshStats();
    render();
    renderBatch();
  }

  // ---- rendering ------------------------------------------------------------

  function tag(text, cls) {
    const s = document.createElement("span");
    s.className = "tag" + (cls ? " " + cls : "");
    s.textContent = text;
    return s;
  }

  function makeTurn(t) {
    const d = document.createElement("div");
    d.className = "turn" + (t.is_source ? " src" : "");
    const who = document.createElement("div");
    who.className = "who";
    const bits = [t.role];
    if (t.is_human_prompt) bits.push("typed by operator");
    if (t.is_source) bits.push("SOURCE");
    if (t.repo) bits.push(t.repo);
    if (t.occurred_at) bits.push(new Date(t.occurred_at).toLocaleString());
    who.textContent = bits.join("  ·  ");
    const body = document.createElement("div");
    body.className = "body";
    // textContent, never innerHTML -- see the module header. Turn content is
    // frequently code and markup and must be shown, not rendered.
    body.textContent = t.content;
    d.append(who, body);
    return d;
  }

  function resetForm() {
    state.form = { action: null, note: "", reasonCode: null, agentBehavior: null };
  }

  function makeForm(item) {
    const wrap = document.createElement("div");

    const grades = document.createElement("div");
    grades.className = "grades";
    ORDER.forEach((action, i) => {
      const label = document.createElement("label");
      label.className = "g-" + action + (state.form.action === action ? " on" : "");
      const radio = document.createElement("input");
      radio.type = "radio";
      radio.name = "grade";
      radio.value = action;
      radio.checked = state.form.action === action;
      radio.onchange = () => {
        state.form.action = action;
        paintGrades();
        // The reason buttons filter to the selected action, so changing the
        // grade has to rebuild them. The note and the already-picked code are
        // untouched -- switching from inconclusive to rejected must not throw
        // away the sentence the operator just wrote.
        paintReasons();
      };
      const text = document.createElement("span");
      text.textContent = LABELS[action];
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(i + 1);
      label.append(radio, text, num);
      grades.append(label);
    });
    wrap.append(grades);

    // Canned reasons. Rebuilt by paintReasons() whenever the action changes, so
    // the container is created empty here and filled in one place.
    const reasons = document.createElement("div");
    reasons.className = "reasons";
    reasons.id = "reasons";
    wrap.append(reasons);

    const note = document.createElement("textarea");
    note.className = "note";
    note.id = "note";
    note.placeholder = "note (optional) -- your own words, or click a reason above to start one; goes to candidate_grade.note, never over the distiller's reason";
    note.value = state.form.note;
    // Typing edits ONLY the text. state.form.reasonCode is deliberately not
    // cleared here: the operator's requirement is that a canned reason lands in
    // the note "for adjustment", and adjusting it must not silently retract
    // which reason was chosen -- the code is what stays queryable once the
    // sentence has been rewritten.
    note.oninput = () => { state.form.note = note.value; };
    note.onkeydown = (e) => {
      // Ctrl/Cmd+Enter still sends from inside the note, because the note is
      // where the operator's hands are when they finish an item.
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault(); e.stopPropagation(); sendBatch(); return;
      }
      if (e.key === "Escape") { note.blur(); e.stopPropagation(); }
      // Plain Enter inside a textarea is a newline, not a stage. Staging from a
      // multi-line field would make it impossible to write a two-line note.
      e.stopPropagation();
    };
    wrap.append(note);

    // ---- the SECOND AXIS ----------------------------------------------------
    // Deliberately separated: its own dashed block, its own heading naming the
    // different question, and its own radio group. The grade above answers "is
    // this worth remembering"; this answers "did the agent behave well". 042's
    // header has the measurement for why they must not be one control.
    const behavior = document.createElement("div");
    behavior.className = "behavior";
    behavior.id = "behavior";
    const bTitle = document.createElement("div");
    bTitle.className = "axis-title";
    bTitle.textContent =
      "separate question -- agent behavior (optional, not part of the grade)";
    behavior.append(bTitle);
    const opts = document.createElement("div");
    opts.className = "opts";
    BEHAVIORS.forEach((value) => {
      const label = document.createElement("label");
      label.className = "b-" + value +
        (state.form.agentBehavior === value ? " on" : "");
      const radio = document.createElement("input");
      radio.type = "radio";
      // A DIFFERENT radio group name from the grades. Sharing "grade" would let
      // picking a behavior deselect the memory grade in a real browser.
      radio.name = "agent-behavior";
      radio.value = value;
      radio.checked = state.form.agentBehavior === value;
      radio.onchange = () => { state.form.agentBehavior = value; paintBehavior(); };
      const text = document.createElement("span");
      text.textContent = BEHAVIOR_LABELS[value];
      label.append(radio, text);
      opts.append(label);
    });
    // Rating is optional, so it must be un-ratable again. Without this an
    // accidental click is permanent for the item, and the operator would learn
    // to avoid the control entirely.
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "clear";
    clear.id = "clear-behavior";
    clear.textContent = "not rated";
    clear.title = "Leave the agent unrated. Different from 'unremarkable'.";
    clear.onclick = () => { state.form.agentBehavior = null; paintBehavior(); };
    opts.append(clear);
    behavior.append(opts);
    wrap.append(behavior);

    const actions = document.createElement("div");
    actions.className = "actions";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "primary";
    add.id = "add-to-batch";
    add.textContent = "Add to batch";
    add.onclick = () => stageCurrent();
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Reset form";
    reset.onclick = () => { resetForm(); render(); say("form reset"); };
    const skip = document.createElement("button");
    skip.type = "button";
    skip.textContent = "Skip (leave ungraded)";
    skip.onclick = () => move(1);
    const hint = document.createElement("span");
    hint.className = "stat";
    hint.textContent = "nothing is sent until SEND BATCH";
    actions.append(add, reset, skip, hint);
    wrap.append(actions);

    return wrap;
  }

  /**
   * Rebuild the canned-reason buttons for the currently selected action.
   *
   * WHY FILTERED BY ACTION. Twelve buttons is a list that gets read once and
   * then ignored; four is a list that gets used. "already known" under a
   * promote is noise and "shows reasoning" under a duplicate is nonsense, so
   * offering them costs attention with no possible gain -- and attention is the
   * hard constraint here (dream-design.md:825-827, "20 is reviewable, 200 gets
   * skipped") across 1,104 items.
   *
   * The FILTER IS A UI AID ONLY. The server does not enforce appliesTo (see
   * parseReasonCode), so an operator who picks a reason and then changes the
   * grade keeps the code rather than losing the batch to a 400.
   */
  function paintReasons() {
    const box = el("reasons");
    if (!box) return;
    box.textContent = "";
    if (!state.form.action) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "pick a grade to see quick reasons";
      box.append(hint);
      return;
    }
    const offered = REASONS.filter(
      (r) => r.appliesTo.indexOf(state.form.action) >= 0);
    if (offered.length === 0) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "no quick reasons for this grade -- type your own";
      box.append(hint);
      return;
    }
    for (const r of offered) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = state.form.reasonCode === r.code ? "picked" : "";
      b.textContent = r.label;
      b.title = r.text;
      b.onclick = () => applyReason(r);
      box.append(b);
    }
    // The picked code may belong to a reason no longer offered (the operator
    // changed the grade after choosing it). Say so rather than showing nothing,
    // because the code IS still being recorded and a silent one is a surprise
    // in the history later.
    if (state.form.reasonCode &&
        !offered.some((r) => r.code === state.form.reasonCode)) {
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "(recording reason: " + state.form.reasonCode + ")";
      box.append(hint);
    }
  }

  /**
   * Click a canned reason: INSERT its text into the note, record its code.
   *
   * Operator, verbatim, 2026-07-28: "so the can'd response if i click one,
   * should allow me to put it into the notes for adjustment and/or the note
   * section stays to allow me to add a little color".
   *
   * So this APPENDS rather than replaces -- a second reason adds a second
   * sentence instead of destroying the first one and whatever colour the
   * operator had already typed after it. The textarea is left focused and fully
   * editable, and nothing is submitted.
   *
   * The CODE is set to the most recently clicked reason. One column holds one
   * code, so with two reasons clicked the last one wins as the label while both
   * sentences survive in the note -- the note is the lossless record, the code
   * is the coarse queryable one, and that asymmetry is 042's whole design.
   */
  function applyReason(reason) {
    const note = el("note");
    const current = state.form.note || "";
    // Idempotent on the exact sentence: clicking the same button twice in a row
    // is a mis-click, not a request for the sentence twice.
    if (current.indexOf(reason.text) < 0) {
      state.form.note = current.trim() === ""
        ? reason.text
        : current.replace(/\s*$/, "") + " " + reason.text;
    }
    state.form.reasonCode = reason.code;
    if (note) {
      note.value = state.form.note;
      note.focus();
    }
    paintReasons();
    say("reason added to the note -- edit it freely, the code is recorded either way");
  }

  /** Repaint the behavior radios without rebuilding the card. */
  function paintBehavior() {
    const box = el("behavior");
    if (!box) return;
    const labels = box.querySelectorAll("label");
    labels.forEach((l) => {
      const input = l.querySelector("input");
      const on = input && input.value === state.form.agentBehavior;
      l.classList.toggle("on", !!on);
      if (input) input.checked = !!on;
    });
  }

  /** Repaint only the selection state, so typing in the note is never interrupted. */
  function paintGrades() {
    const labels = document.querySelectorAll(".grades label");
    labels.forEach((l) => {
      const input = l.querySelector("input");
      const on = input && input.value === state.form.action;
      l.classList.toggle("on", !!on);
      if (input) input.checked = !!on;
    });
  }

  function renderEmpty() {
    const stage = el("stage");
    stage.textContent = "";
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("div");
    h.style.fontSize = "16px";
    h.textContent = state.batch.length > 0
      ? "Nothing left to read on this page -- " + state.batch.length +
        " item(s) are still staged. Press SEND BATCH to commit them."
      : (state.mode === "inconclusive"
        ? "No inconclusive items left."
        : "Queue is empty -- every candidate in this namespace has been graded.");
    card.append(h);
    stage.append(card);
    el("pos").textContent = "0 of 0";
  }

  function render() {
    const stage = el("stage");
    stage.textContent = "";

    if (state.items.length === 0) { renderEmpty(); return; }
    if (state.idx >= state.items.length) {
      loadPage().catch((e) => say(e.message, "err"));
      return;
    }

    const it = state.items[state.idx];
    el("pos").textContent = (state.idx + 1) + " of " + state.items.length +
      " (" + state.total + " in queue)";

    const card = document.createElement("div");
    card.className = "card";

    const row = document.createElement("div");
    row.className = "row";
    row.append(tag(it.candidate_type, "type"));
    if (it.is_regrade) {
      row.append(tag("regrade -- already graded " +
        LABELS[it.previous_action], "machine"));
    }
    if (it.uncertain) row.append(tag("uncertain", "uncertain"));
    if (it.authority_tier) row.append(tag(it.authority_tier));
    if (it.model) row.append(tag(it.model));
    if (it.machine_grade) row.append(tag("machine says: " + it.machine_grade, "machine"));
    if (it.reinforcement && it.reinforcement.session_count > 1) {
      // gbrain-style receipt (dream-design.md:709-712): the count with its dates,
      // computed live from content_occurrences, never a stored number.
      const r = it.reinforcement;
      const first = r.first_seen ? new Date(r.first_seen).toLocaleDateString() : "?";
      const last = r.last_seen ? new Date(r.last_seen).toLocaleDateString() : "?";
      row.append(tag("seen " + r.occurrence_count + "x across " + r.session_count +
        " sessions, " + first + " to " + last, "reinforced"));
    }
    card.append(row);

    // ---- THE OPERATOR'S WORDS COME FIRST (migration 041) --------------------
    // Operator, verbatim: "my part of the conversation should be the first
    // thing, anything below that can be agent response and maybe tool calls to
    // get there". For an exchange, his own turn heads the card as the thing
    // being graded; the distilled claim and the agent activity follow as the
    // body. A fragment has no operator head and must NOT be given one -- putting
    // agent text in this position is precisely the defect 041 exists to fix.
    if (it.unit_kind === "exchange" && it.operator_text) {
      const lead = document.createElement("div");
      lead.className = "op-lead";
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = "you asked";
      const body = document.createElement("div");
      body.className = "body";
      body.textContent = it.operator_text;
      lead.append(who, body);
      card.append(lead);
    } else if (it.unit_kind === "exchange") {
      // An ORPHAN exchange: agent turns before the first operator turn of a
      // session (17 of 289, measured 2026-07-28). Saying so is better than
      // silently rendering it like an anchored one, because the missing head is
      // the reason it is worth less of the operator's attention.
      const orphan = document.createElement("div");
      orphan.className = "empty";
      orphan.textContent =
        "No operator turn heads this exchange -- it is agent activity from " +
        "before you said anything in that session.";
      card.append(orphan);
    }

    const content = document.createElement("div");
    content.className = "content";
    content.textContent = it.content;
    // Labelled only when something sits above it, so the operator can tell the
    // distilled claim apart from his own verbatim words directly above.
    if (it.unit_kind === "exchange" && it.operator_text) {
      const h = document.createElement("h2");
      h.textContent = "what the distiller pulled out of this exchange";
      card.append(h);
    }
    card.append(content);

    if (it.uncertainty_reason) {
      const why = document.createElement("div");
      why.className = "reason";
      // Named as the distiller's, because 040 exists so the operator's words no
      // longer overwrite it. Two authors, two fields, and the page says which.
      why.textContent = "distiller doubted this: " + it.uncertainty_reason;
      card.append(why);
    }

    card.append(makeForm(it));
    stage.append(card);
    // The reason row depends on the selected action, which makeForm does not
    // know how to lay out on its own. Painted once here after the card is in
    // the tree, then repainted by the action radios.
    paintReasons();

    // A candidate with no visible source is ungradeable, and saying so is more
    // honest than presenting a bare claim for judgement. A regrade is exempt:
    // it carries no context by design (the operator has already read this item
    // and is changing an answer), so the warning would be a false alarm.
    if (!it.context || it.context.length === 0) {
      const w = document.createElement("div");
      w.className = it.is_regrade ? "empty" : "warn";
      w.style.marginTop = "14px";
      w.textContent = it.is_regrade
        ? "Regrade -- source turns are not reloaded. Pick the new grade, edit " +
          "the note, and add it back to the batch."
        : "No source turns found for this candidate (" +
          it.source_turn_ids.length + " referenced). It cannot be judged on its " +
          "content alone -- grade it inconclusive unless you recognise it.";
      stage.append(w);
      return;
    }

    const h2 = document.createElement("h2");
    // Named for what it IS on an exchange -- the body under the operator's head
    // -- rather than the neutral "source turns", so the reading order the
    // operator asked for is stated and not just implied by position.
    h2.textContent = it.unit_kind === "exchange"
      ? "what the agent did about it -- response and tool calls"
      : "source turns and surrounding conversation";
    stage.append(h2);
    const body = document.createElement("div");
    body.className = "agent-body";
    for (const t of it.context) body.append(makeTurn(t));
    stage.append(body);
  }

  function renderBatch() {
    const list = el("batch-list");
    list.textContent = "";
    el("batch-n").textContent = state.batch.length;
    el("staged-count").textContent = state.batch.length;
    el("sent-count").textContent = state.sent;
    el("send").disabled = state.batch.length === 0 || state.busy;
    el("clear-batch").disabled = state.batch.length === 0;
    el("undo-batch").disabled = !state.lastBatchId || state.busy;

    const lb = el("last-batch");
    if (state.lastBatchId) {
      lb.className = "";
      lb.textContent = "Last sent: " + state.lastBatchSize + " grade(s), batch " +
        state.lastBatchId.slice(0, 8) + ".";
    } else {
      lb.className = "empty";
      lb.textContent = "No batch sent from this page yet.";
    }

    if (state.batch.length === 0) {
      const e = document.createElement("div");
      e.className = "empty";
      e.textContent = "Nothing staged. Pick a grade and press Enter or Add to batch.";
      list.append(e);
      return;
    }

    state.batch.forEach((g, i) => {
      const d = document.createElement("div");
      d.className = "staged";

      const head = document.createElement("div");
      head.className = "head";
      const act = document.createElement("span");
      act.className = "act " + g.action;
      act.textContent = LABELS[g.action];
      const n = document.createElement("span");
      n.className = "stat";
      // A regrade reads differently from a first grade -- it will supersede an
      // existing answer -- so the pending list says which it is.
      n.textContent = g.regrade
        ? "#" + (i + 1) + " regrade, was " + LABELS[g.regrade.previous_action]
        : "#" + (i + 1);
      const btns = document.createElement("div");
      btns.className = "btns";
      const edit = document.createElement("button");
      edit.type = "button";
      edit.textContent = "edit";
      edit.title = "Pull this back into the form to change the grade or the note";
      edit.onclick = () => unstage(i, true);
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "danger";
      rm.textContent = "remove";
      rm.onclick = () => unstage(i, false);
      btns.append(edit, rm);
      head.append(act, n, btns);
      d.append(head);

      const snip = document.createElement("div");
      snip.className = "snippet";
      snip.textContent = g.content || g.candidateId;
      d.append(snip);

      if (g.note) {
        const note = document.createElement("div");
        note.className = "n";
        note.textContent = "note: " + g.note;
        d.append(note);
      }
      // Both axes are shown in the pending list because both are being sent,
      // and the batch list is the operator's last look before SEND. A behavior
      // rating attached to the wrong item is otherwise invisible until it is in
      // the table.
      if (g.reasonCode || g.agentBehavior) {
        const axes = document.createElement("div");
        axes.className = "stat";
        const bits = [];
        if (g.reasonCode) bits.push("reason: " + g.reasonCode);
        if (g.agentBehavior) bits.push("agent: " + BEHAVIOR_LABELS[g.agentBehavior]);
        axes.textContent = bits.join("  ·  ");
        d.append(axes);
      }
      list.append(d);
    });
  }

  // ---- staging (local only) -------------------------------------------------

  function stageCurrent() {
    const it = state.items[state.idx];
    if (!it) { say("nothing to stage"); return; }
    if (!state.form.action) {
      say("pick a grade first (1 pass / 2 fail / 3 inconclusive / 4 duplicate)", "err");
      return;
    }
    // Guarded even though staged items are filtered out of the queue: an edit
    // round-trip or a restored batch can put the same id in front of the
    // operator again, and the server rejects a batch with a duplicate.
    if (state.batch.some((g) => g.candidateId === it.id)) {
      say("already staged -- edit it in the batch list instead", "err");
      return;
    }
    state.batch.push({
      candidateId: it.id,
      action: state.form.action,
      note: state.form.note.trim(),
      // Recorded independently of the note text, so the operator editing the
      // inserted sentence -- which is the point of inserting it -- cannot clear
      // which reason was chosen.
      reasonCode: state.form.reasonCode,
      agentBehavior: state.form.agentBehavior,
      // Kept for display only, so the pending list reads as claims rather than
      // uuids. Stripped before the POST -- the server has the content already.
      content: it.content.slice(0, 400),
    });
    persist();
    // Take it out of the queue view so it cannot be graded twice.
    state.items.splice(state.idx, 1);
    resetForm();
    say("staged (" + state.batch.length + " pending, nothing sent)", "ok");
    render();
    renderBatch();
  }

  function unstage(i, backToForm) {
    const g = state.batch[i];
    if (!g) return;
    state.batch.splice(i, 1);
    persist();
    if (backToForm) {
      // Put the item back in front of the operator with their own answer
      // pre-filled, so "change" is an edit and not a re-read.
      const known = state.items.findIndex((it) => it.id === g.candidateId);
      if (known >= 0) {
        state.idx = known;
        state.form = {
          action: g.action,
          note: g.note || "",
          // Restored, not dropped: pulling an item back to change the grade
          // must not silently retract the reason and the behavior rating the
          // operator already gave it.
          reasonCode: g.reasonCode || null,
          agentBehavior: g.agentBehavior || null,
        };
        render();
        say("editing -- change it and add it back");
      } else if (g.regrade) {
        // A REGRADE. Its candidate is not in state.items and never will be --
        // /api/queue filters "reviewed_at IS NULL" and this one is already
        // graded -- so a findIndex lookup always missed and the operator fell
        // through to a queue reload that dropped the item entirely. The staged
        // entry carries the card, so put that card on screen instead.
        state.items.splice(state.idx, 0, {
          id: g.candidateId,
          candidate_type: g.regrade.candidate_type,
          content: g.regrade.content,
          uncertain: g.regrade.uncertain,
          uncertainty_reason: g.regrade.uncertainty_reason,
          machine_grade: g.regrade.machine_grade,
          authority_tier: null,
          model: null,
          source_turn_ids: [],
          // No context is fetched for a regrade: the operator has already read
          // this item once and is changing an answer, not making a first
          // judgement. render() says so rather than showing a bare claim.
          context: [],
          reinforcement: null,
          is_regrade: true,
          previous_action: g.regrade.previous_action,
        });
        state.form = {
          action: g.action,
          note: g.note || "",
          reasonCode: g.reasonCode || null,
          agentBehavior: g.agentBehavior || null,
        };
        render();
        say("editing a regrade (was " + LABELS[g.regrade.previous_action] +
            ") -- change it and add it back");
      } else {
        // It is no longer on the loaded page (staged before a reload). Reload
        // and let the queue bring it back rather than inventing a card.
        say("pulled back into the queue -- reloading");
        loadPage().catch((e) => say(e.message, "err"));
      }
    } else {
      say("removed from batch");
      render();
    }
    renderBatch();
  }

  function clearBatch() {
    if (state.batch.length === 0) return;
    if (!confirm("Drop all " + state.batch.length + " staged grade(s)? " +
                 "They have not been sent, so this cannot be undone.")) return;
    state.batch = [];
    persist();
    say("batch cleared");
    loadPage().catch((e) => say(e.message, "err"));
  }

  // ---- send / undo ----------------------------------------------------------

  async function sendBatch() {
    if (state.busy || state.batch.length === 0) return;
    state.busy = true;
    renderBatch();
    say("sending " + state.batch.length + " grade(s)...");
    // Snapshot what is being sent: the batch must not be cleared until the
    // server confirms, and it must not be re-sent if the operator hits Send
    // twice while in flight.
    const payload = state.batch.map((g) => ({
      candidateId: g.candidateId,
      action: g.action,
      note: g.note || undefined,
      // undefined rather than null so an unset field is simply absent from the
      // JSON. The server treats absent and null identically, but an absent key
      // cannot be mistaken for an explicit "no reason" by a future reader of a
      // captured request body.
      reasonCode: g.reasonCode || undefined,
      agentBehavior: g.agentBehavior || undefined,
    }));
    try {
      const res = await api("/api/grade-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grades: payload }),
      });
      const n = res.results.length;
      state.sent += n;
      state.batch = [];
      persist();
      rememberLastBatch(res.batch_id, n);
      const regrades = res.results.filter((r) => r.superseded_grade_id).length;
      const disagreed = res.results.filter((r) => r.agreed === false).length;
      say("sent " + n + " grade(s)" +
          (regrades ? ", " + regrades + " regrade(s)" : "") +
          (disagreed ? ", " + disagreed + " disagreed with the machine" : ""), "ok");
      await loadPage();
    } catch (e) {
      // The batch is untouched and still staged. The whole transaction rolled
      // back, so "not saved" is the literal truth and pressing Send again is
      // the correct retry.
      say("NOT saved (whole batch rolled back): " + e.message, "err");
    } finally {
      state.busy = false;
      renderBatch();
    }
  }

  async function undoLastBatch() {
    if (state.busy || !state.lastBatchId) { say("no sent batch to undo"); return; }
    if (!confirm("Undo the last sent batch (" + state.lastBatchSize +
                 " grade(s))? They return to the queue.")) return;
    state.busy = true;
    renderBatch();
    try {
      const res = await api("/api/undo-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchId: state.lastBatchId }),
      });
      state.sent = Math.max(0, state.sent - res.removed);
      rememberLastBatch(null, 0);
      say("undone: " + res.removed + " grade(s) removed" +
          (res.restored ? ", " + res.restored + " earlier grade(s) restored" : ""), "ok");
      await loadPage();
    } catch (e) {
      say("undo failed: " + e.message, "err");
    } finally {
      state.busy = false;
      renderBatch();
    }
  }

  // ---- history / change -----------------------------------------------------

  async function openHistory() {
    const dlg = el("history");
    const list = el("hist-list");
    list.textContent = "";
    el("hist-msg").textContent = "loading...";
    if (!dlg.open) dlg.showModal();
    try {
      const h = await api("/api/history?limit=50");
      el("hist-total").textContent = h.total + " grade(s) recorded";
      el("hist-msg").textContent = "";
      list.textContent = "";
      if (h.items.length === 0) {
        const e = document.createElement("div");
        e.className = "empty";
        e.textContent = "No grades recorded yet.";
        list.append(e);
        return;
      }
      for (const g of h.items) {
        const d = document.createElement("div");
        d.className = "item" + (g.superseded_at ? " superseded" : "");
        const head = document.createElement("div");
        head.className = "head";
        const act = document.createElement("span");
        act.className = "act " + g.action;
        act.textContent = LABELS[g.action];
        act.style.fontWeight = "650";
        head.append(act);
        d.append(head);
        const snip = document.createElement("div");
        snip.className = "snippet";
        snip.textContent = g.content;
        d.append(snip);
        if (g.note) {
          const n = document.createElement("div");
          n.className = "n";
          n.textContent = "note: " + g.note;
          d.append(n);
        }
        const meta = document.createElement("div");
        meta.className = "meta";
        const when = document.createElement("span");
        when.textContent = new Date(g.created_at).toLocaleString() + " by " + g.graded_by;
        meta.append(when);
        // Shown even though the note is right above it: the note may have been
        // edited past recognition, and the code is the part that still answers
        // "why". That independence is the reason 042 stores both.
        if (g.reason_code) {
          const rc = document.createElement("span");
          rc.textContent = "reason: " + g.reason_code;
          meta.append(rc);
        }
        if (g.agent_behavior) {
          const ab = document.createElement("span");
          ab.textContent = "agent: " + BEHAVIOR_LABELS[g.agent_behavior];
          meta.append(ab);
        }
        if (g.machine_grade) {
          const m = document.createElement("span");
          m.textContent = "machine: " + g.machine_grade;
          meta.append(m);
        }
        if (g.superseded_at) {
          const s = document.createElement("span");
          // The superseded row is kept and shown on purpose: 040 exists so a
          // changed mind is recorded rather than erased, and the first answer is
          // part of the evidence.
          s.textContent = "superseded " + new Date(g.superseded_at).toLocaleString();
          meta.append(s);
        } else {
          // One button per grade, so the operator picks the new answer directly.
          // The current grade is shown but not offered: re-staging the same
          // value would supersede a row with an identical one, which is history
          // noise rather than a change of mind.
          const changeTo = document.createElement("span");
          changeTo.textContent = "change to:";
          meta.append(changeTo);
          for (const action of ORDER) {
            if (action === g.action) continue;
            const b = document.createElement("button");
            b.type = "button";
            b.className = "g-" + action;
            b.textContent = LABELS[action];
            b.title = "Stage a regrade of this item as " + LABELS[action];
            b.onclick = () => stageRegrade(g, action);
            meta.append(b);
          }
        }
        d.append(meta);
        list.append(d);
      }
    } catch (e) {
      el("hist-msg").textContent = e.message;
      el("hist-msg").className = "msg err";
    }
  }

  /**
   * Re-grade a previously sent item: the operator PICKS the new grade.
   *
   * It goes through the SAME batch flow: staged locally, editable, sent with the
   * next Send. The server then supersedes the old grade row rather than
   * overwriting it. A separate "edit in place" path would be a second write
   * shape with different semantics, and the operator asked for one.
   *
   * WHY A PICKER AND NOT A ROTATION. This used to stage
   * ORDER[(indexOf(action)+1) % 4] -- "change this" on a promoted item silently
   * staged "rejected". That is not a change, it is a guess, and the operator's
   * requirement was "a way to reset, undo, change i needed". The buttons below
   * name every grade including the current one, so changing your mind means
   * choosing the answer rather than cycling until the label happens to read right.
   */
  function stageRegrade(g, action) {
    if (state.batch.some((b) => b.candidateId === g.candidate_id)) {
      say("already staged", "err"); return;
    }
    state.batch.push({
      candidateId: g.candidate_id,
      action: action,
      note: g.note || "",
      // Carried forward from the grade being changed, so a regrade starts from
      // what the operator already said rather than blank. He can clear or
      // replace either one in the form before sending.
      reasonCode: g.reason_code || null,
      agentBehavior: g.agent_behavior || null,
      content: g.content.slice(0, 400),
      // A regrade's candidate is BY DEFINITION not in the ungraded queue
      // (/api/queue filters reviewed_at IS NULL), so "edit" cannot find it by
      // looking in state.items. Carrying the card's own data here is what makes
      // the staged entry editable at all -- without it the edit button fell
      // through to a queue reload that dropped the item from view entirely.
      regrade: {
        candidate_type: g.candidate_type,
        content: g.content,
        uncertain: g.uncertain,
        uncertainty_reason: g.uncertainty_reason,
        machine_grade: g.machine_grade,
        previous_action: g.action,
      },
    });
    persist();
    renderBatch();
    el("history").close();
    say("staged a regrade of a " + LABELS[g.action] + " item as " + LABELS[action] +
        " -- edit or remove it in the batch list, then SEND", "ok");
  }

  // ---- keyboard -------------------------------------------------------------

  document.addEventListener("keydown", (e) => {
    const t = e.target;
    const typing = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA");

    // Ctrl/Cmd+Enter sends from anywhere, including a focused field.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); sendBatch(); return;
    }
    if (typing) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // A grade key SELECTS. It does not stage and it does not send.
    if (ACTIONS[e.key]) {
      e.preventDefault();
      state.form.action = ACTIONS[e.key];
      paintGrades();
      say("selected " + LABELS[state.form.action] + " -- Enter to add to batch");
      return;
    }
    // Quick reasons, positionally bound to the row currently on screen -- q is
    // the first offered reason for the selected grade, w the second, and so on.
    // Positional rather than per-code because the offered set changes with the
    // action: a fixed key per code would leave most of them dead on any given
    // card, and the operator would stop reaching for them.
    //
    // Like every other accelerator here these only SELECT. A reason key inserts
    // text into the note and sets the code; it never stages and never sends.
    if (REASON_KEYS[e.key] !== undefined) {
      e.preventDefault();
      if (!state.form.action) {
        say("pick a grade first -- quick reasons depend on it", "err");
        return;
      }
      const offered = REASONS.filter(
        (r) => r.appliesTo.indexOf(state.form.action) >= 0);
      const reason = offered[REASON_KEYS[e.key]];
      if (!reason) { say("no quick reason on that key for this grade"); return; }
      applyReason(reason);
      return;
    }
    // The second axis, on its own keys. Pressing the same one twice clears it,
    // because rating is optional and an accidental press must be undoable
    // without reaching for the mouse.
    if (BEHAVIOR_KEYS[e.key]) {
      e.preventDefault();
      const value = BEHAVIOR_KEYS[e.key];
      state.form.agentBehavior = state.form.agentBehavior === value ? null : value;
      paintBehavior();
      say(state.form.agentBehavior
        ? "agent behavior: " + BEHAVIOR_LABELS[value] + " (not part of the grade)"
        : "agent behavior cleared -- not rated");
      return;
    }
    if (e.key === "Enter") { e.preventDefault(); stageCurrent(); return; }
    if (e.key === "Escape") { e.preventDefault(); resetForm(); render(); say("form reset"); return; }
    if (e.key === "n") {
      e.preventDefault();
      const n = el("note");
      if (n) n.focus();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "j") { e.preventDefault(); move(1); return; }
    if (e.key === "ArrowLeft" || e.key === "k") { e.preventDefault(); move(-1); return; }
  });

  /**
   * Move between items WITHOUT grading. The item stays ungraded and comes back
   * on the next queue load -- navigation is not a judgement.
   */
  function move(delta) {
    const next = state.idx + delta;
    if (next < 0) { say("start of this page"); return; }
    if (next >= state.items.length) {
      say("end of this page -- send the batch to pull more");
      return;
    }
    state.idx = next;
    resetForm();
    render();
  }

  // ---- wiring ---------------------------------------------------------------

  el("send").onclick = () => sendBatch();
  el("clear-batch").onclick = () => clearBatch();
  el("undo-batch").onclick = () => undoLastBatch();
  el("open-history").onclick = () => openHistory();
  el("hist-close").onclick = () => el("history").close();

  // Last line of defence for the "nothing until Send" model: staged work is
  // local, so a closed tab with an unsent batch is the one way to lose it even
  // with localStorage (a different browser, a cleared profile).
  window.addEventListener("beforeunload", (e) => {
    if (state.batch.length === 0) return;
    e.preventDefault();
    e.returnValue = "";
  });

  restore();
  renderBatch();
  loadPage("queue").catch((e) => {
    el("stage").textContent = "";
    const w = document.createElement("div");
    w.className = "warn";
    w.textContent = "Could not load the queue: " + e.message;
    el("stage").append(w);
  });
})();
</script>
</body>
</html>
`;
