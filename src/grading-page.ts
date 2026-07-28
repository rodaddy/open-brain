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
 */

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
  // Versioned so a future shape change discards an incompatible saved batch
  // instead of half-reading it into the form.
  const STORE_KEY = "ob.grading.batch.v1";
  const LAST_BATCH_KEY = "ob.grading.lastBatch.v1";

  const el = (id) => document.getElementById(id);

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
    form: { action: null, note: "" },
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
    state.form = { action: null, note: "" };
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
      radio.onchange = () => { state.form.action = action; paintGrades(); };
      const text = document.createElement("span");
      text.textContent = LABELS[action];
      const num = document.createElement("span");
      num.className = "num";
      num.textContent = String(i + 1);
      label.append(radio, text, num);
      grades.append(label);
    });
    wrap.append(grades);

    const note = document.createElement("textarea");
    note.className = "note";
    note.id = "note";
    note.placeholder = "note (optional) -- your own words; goes to candidate_grade.note, never over the distiller's reason";
    note.value = state.form.note;
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

    const content = document.createElement("div");
    content.className = "content";
    content.textContent = it.content;
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
    h2.textContent = "source turns and surrounding conversation";
    stage.append(h2);
    for (const t of it.context) stage.append(makeTurn(t));
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
        state.form = { action: g.action, note: g.note || "" };
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
        state.form = { action: g.action, note: g.note || "" };
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
