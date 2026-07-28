/**
 * The grading page, as one self-contained HTML string. Issue #394.
 *
 * WHY A STRING IN A .ts FILE. There is no bundler, no template engine, and no
 * static-file serving anywhere in this repo (`rg` finds zero uses of
 * express.static or sendFile). Keeping the page as an exported constant means
 * `bun scripts/grading-server-run.ts` works from any working directory with no
 * path resolution and no build step -- the same property that makes
 * scripts/dream-light-run.ts runnable without ceremony.
 *
 * WHY IT IS KEYBOARD-DRIVEN AND ONE ITEM AT A TIME. The operator's stated
 * requirement, and gbrain's precedent behind it: "they graded ALL of it. It was
 * a big giant slug that was super annoying to do." The slog is the cost of
 * getting ground truth, and the only lever on it is per-item friction. A grid
 * of rows with mouse targets makes 1,104 items unfinishable; 1/2/3/4 under the
 * fingers makes it a session. dream-design.md:825-827 sets the same constraint
 * from the other end -- "20 is reviewable, 200 gets skipped."
 *
 * WHAT IS DELIBERATELY NOT DECIDED HERE. dream-design.md contains no text on
 * page layout, column set, or ranking-widget-vs-per-item-grading, and
 * :1363-1365 says "Do not invent answers to these during implementation." So
 * this page implements exactly what the operator asked for verbatim -- "pass
 * fail inconclusive", an inconclusive follow-up pass, and speed -- and the
 * open question of whether the page is ceremony at all (:1372) stays open.
 * The ordinal-ranking surface that :785-786 anticipates is NOT built here;
 * per-item grading is what was asked for, and grades are the input a ranking
 * would be fitted from anyway.
 *
 * NO AUTO-ADVANCE WITHOUT A GRADE. The card moves only after a grade POSTs
 * successfully, or when the operator explicitly navigates with the arrow keys.
 * A page that advances on a failed write silently drops the judgement.
 *
 * CONTENT IS INSERTED WITH textContent, NEVER innerHTML. Candidate content is
 * real dialogue and routinely contains code, angle brackets, and markup. This
 * is a correctness requirement before it is a security one: `innerHTML` would
 * render a captured HTML snippet instead of showing it, which is the one thing
 * a reviewer must be able to read verbatim.
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
    border-bottom: 1px solid var(--line); padding: 10px 16px;
    display: flex; gap: 18px; align-items: center; flex-wrap: wrap;
  }
  header .title { font-weight: 650; letter-spacing: .2px; }
  header .stat { color: var(--dim); font-variant-numeric: tabular-nums; }
  header .stat b { color: var(--fg); font-weight: 600; }
  main { max-width: 1040px; margin: 0 auto; padding: 18px 16px 120px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
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
    padding: 14px; font-size: 15.5px; white-space: pre-wrap; word-break: break-word;
    max-height: 340px; overflow: auto;
  }
  .reason { color: var(--inc); font-size: 13px; margin-top: 10px; white-space: pre-wrap; }
  h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .8px;
       color: var(--dim); margin: 22px 0 8px; font-weight: 600; }
  .turn {
    border-left: 3px solid var(--line); padding: 7px 0 7px 11px; margin-bottom: 7px;
    white-space: pre-wrap; word-break: break-word; font-size: 13px; color: #cdd3de;
  }
  .turn.src { border-left-color: var(--accent); background: #1c2130; }
  .turn .who {
    font-size: 11px; text-transform: uppercase; letter-spacing: .6px;
    color: var(--dim); margin-bottom: 3px;
  }
  .turn.src .who { color: var(--accent); }
  .turn .body { max-height: 220px; overflow: auto; }
  .warn {
    background: #3a1d1d; border: 1px solid #6b2a2a; color: #ffb4b4;
    padding: 10px 12px; border-radius: 8px; font-size: 13px;
  }
  footer {
    position: fixed; bottom: 0; left: 0; right: 0; background: var(--panel);
    border-top: 1px solid var(--line); padding: 9px 16px;
    display: flex; gap: 16px; align-items: center; flex-wrap: wrap; font-size: 13px;
  }
  kbd {
    background: var(--panel2); border: 1px solid var(--line); border-bottom-width: 2px;
    border-radius: 5px; padding: 1px 7px; font: 12px ui-monospace, monospace; color: var(--fg);
  }
  .k-pass b { color: var(--pass); } .k-fail b { color: var(--fail); }
  .k-inc b { color: var(--inc); }  .k-dup b { color: var(--dup); }
  .msg { color: var(--dim); }
  .msg.err { color: var(--fail); }
  .msg.ok { color: var(--pass); }
  button {
    background: var(--panel2); color: var(--fg); border: 1px solid var(--line);
    border-radius: 6px; padding: 4px 11px; font-size: 13px; cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  .banner {
    background: #1e2a1e; border: 1px solid #33582f; color: #bde5b5;
    padding: 12px 14px; border-radius: 9px; margin-bottom: 16px;
    display: flex; gap: 12px; align-items: center; flex-wrap: wrap;
  }
  .note { width: 100%; background: var(--panel2); color: var(--fg);
    border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px;
    font: inherit; margin-top: 12px; }
</style>
</head>
<body>
<header>
  <span class="title">Candidate grading</span>
  <span class="stat">item <b id="pos">-</b></span>
  <span class="stat">ungraded <b id="ungraded">-</b></span>
  <span class="stat">graded <b id="graded">-</b></span>
  <span class="stat">pass <b id="a-promoted">0</b> / fail <b id="a-rejected">0</b>
        / inc <b id="a-inconclusive">0</b> / dup <b id="a-duplicate">0</b></span>
  <span class="stat">machine agreement <b id="agree">n/a</b></span>
  <span class="stat" id="mode-label"></span>
</header>

<main>
  <div id="banner" class="banner" hidden></div>
  <div id="stage"></div>
</main>

<footer>
  <span class="k-pass"><kbd>1</kbd> <b>pass</b></span>
  <span class="k-fail"><kbd>2</kbd> <b>fail</b></span>
  <span class="k-inc"><kbd>3</kbd> <b>inconclusive</b></span>
  <span class="k-dup"><kbd>4</kbd> <b>duplicate</b></span>
  <span><kbd>u</kbd> undo</span>
  <span><kbd>&larr;</kbd> <kbd>&rarr;</kbd> move</span>
  <span><kbd>n</kbd> note</span>
  <span id="msg" class="msg"></span>
</footer>

<script>
(() => {
  "use strict";

  const ACTIONS = { "1": "promoted", "2": "rejected", "3": "inconclusive", "4": "duplicate" };
  const el = (id) => document.getElementById(id);

  const state = {
    items: [],
    idx: 0,
    total: 0,
    graded: 0,
    // Only the last grade is undoable. A deeper stack would let the operator
    // undo past items they have since scrolled away from and can no longer see,
    // which turns undo from a correction into a source of new mistakes.
    lastGraded: null,
    // "queue" = ungraded work. "inconclusive" = the come-back-to-these pass the
    // operator asked for by name; entered only from the offer below.
    mode: "queue",
    busy: false,
    offeredInconclusive: false,
    pendingNote: "",
  };

  function say(text, kind) {
    const m = el("msg");
    m.textContent = text || "";
    m.className = "msg" + (kind ? " " + kind : "");
  }

  function fmtPct(rate) {
    return rate === null || rate === undefined ? "n/a" : Math.round(rate * 100) + "%";
  }

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
    var ma = s.machine_agreement;
    if (ma.compared === 0) {
      el("agree").textContent = "n/a";
      el("agree").title = "no candidate has both a human and a machine grade yet";
    } else if (ma.distinct_machine_grades <= 1) {
      el("agree").textContent = fmtPct(ma.rate) + " (" + ma.compared +
        ", machine is constant -- not a trust signal)";
      el("agree").title =
        "REM emitted only one distinct grade, so this rate measures your own " +
        "action mix, not whether the machine can be trusted. The missing " +
        "one-off rule is an open design hole (dream-design.md:817-821).";
    } else {
      el("agree").textContent = fmtPct(ma.rate) + " (" + ma.compared + ")";
      el("agree").title = ma.distinct_machine_grades + " distinct machine grades compared";
    }
    return s;
  }

  async function loadPage(mode) {
    state.mode = mode || state.mode;
    const path = state.mode === "inconclusive" ? "/api/inconclusive" : "/api/queue";
    const data = await api(path + "?limit=50");
    state.items = data.items;
    state.total = data.total;
    state.idx = 0;
    state.pendingNote = "";
    el("mode-label").textContent =
      state.mode === "inconclusive" ? "reviewing INCONCLUSIVE items" : "";
    await refreshStats();
    render();
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

  function tag(text, cls) {
    const s = document.createElement("span");
    s.className = "tag" + (cls ? " " + cls : "");
    s.textContent = text;
    return s;
  }

  function renderEmpty() {
    const stage = el("stage");
    stage.textContent = "";
    const card = document.createElement("div");
    card.className = "card";
    const h = document.createElement("div");
    h.style.fontSize = "16px";
    h.textContent = state.mode === "inconclusive"
      ? "No inconclusive items left."
      : "Queue is empty -- every candidate in this namespace has been graded.";
    card.append(h);
    stage.append(card);
    el("pos").textContent = "0 of 0";
    maybeOfferInconclusive();
  }

  // The operator's verbatim ask: "inconclusive should go through, and then there
  // should be a thing asking me, would you like to grade all of these
  // inconclusive things". Offered when the main queue is exhausted -- never as
  // an interruption mid-run, because interrupting the slog is what ends it.
  async function maybeOfferInconclusive() {
    if (state.mode === "inconclusive" || state.offeredInconclusive) return;
    const s = await refreshStats();
    const n = s.by_action.inconclusive;
    if (!n) return;
    state.offeredInconclusive = true;
    const b = el("banner");
    b.textContent = "";
    const text = document.createElement("span");
    text.textContent = "You marked " + n + " item" + (n === 1 ? "" : "s") +
      " inconclusive. Grade them now?";
    const yes = document.createElement("button");
    yes.textContent = "Yes, review them";
    yes.onclick = async () => { b.hidden = true; await loadPage("inconclusive"); };
    const no = document.createElement("button");
    no.textContent = "Not now";
    no.onclick = () => { b.hidden = true; };
    b.append(text, yes, no);
    b.hidden = false;
  }

  function render() {
    const stage = el("stage");
    stage.textContent = "";

    if (state.items.length === 0) { renderEmpty(); return; }
    if (state.idx >= state.items.length) {
      // The loaded page is done but the server may hold more. Pull the next one
      // rather than telling the operator they are finished when they are not.
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
    if (it.uncertain) row.append(tag("uncertain", "uncertain"));
    if (it.authority_tier) row.append(tag(it.authority_tier));
    if (it.model) row.append(tag(it.model));
    if (it.machine_grade) {
      row.append(tag("machine says: " + it.machine_grade, "machine"));
    }
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
      why.textContent = "why doubted: " + it.uncertainty_reason;
      card.append(why);
    }

    const note = document.createElement("input");
    note.className = "note";
    note.id = "note";
    note.placeholder = "optional note (press n to focus, Esc to leave)";
    note.value = state.pendingNote;
    note.oninput = () => { state.pendingNote = note.value; };
    note.onkeydown = (e) => {
      if (e.key === "Escape") { note.blur(); e.stopPropagation(); }
    };
    card.append(note);
    stage.append(card);

    // A candidate with no visible source is ungradeable, and saying so is more
    // honest than presenting a bare claim for judgement.
    if (!it.context || it.context.length === 0) {
      const w = document.createElement("div");
      w.className = "warn";
      w.style.marginTop = "16px";
      w.textContent = "No source turns found for this candidate (" +
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

  async function grade(action) {
    if (state.busy) return;
    const it = state.items[state.idx];
    if (!it) return;
    state.busy = true;
    say("saving " + action + "...");
    try {
      const res = await api("/api/grade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: it.id, action, note: state.pendingNote || undefined }),
      });
      state.lastGraded = it.id;
      state.pendingNote = "";
      let line = action;
      if (res.agreed === true) line += " (machine agreed)";
      else if (res.agreed === false) line += " (machine said " + res.machine_grade + ")";
      say(line, "ok");
      // Advance ONLY after a confirmed write. See the module header.
      state.items.splice(state.idx, 1);
      state.total = Math.max(0, state.total - 1);
      state.graded += 1;
      refreshStats().catch(() => {});
      render();
    } catch (e) {
      // Stay on the item. A failed write must not look like a recorded grade.
      say("NOT saved: " + e.message, "err");
    } finally {
      state.busy = false;
    }
  }

  async function undo() {
    if (state.busy || !state.lastGraded) { say("nothing to undo"); return; }
    state.busy = true;
    try {
      await api("/api/ungrade", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: state.lastGraded }),
      });
      state.lastGraded = null;
      say("undone -- reloading queue", "ok");
      await loadPage();
    } catch (e) {
      say("undo failed: " + e.message, "err");
    } finally {
      state.busy = false;
    }
  }

  document.addEventListener("keydown", (e) => {
    // Never steal a key from a field the operator is typing in.
    const t = e.target;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (ACTIONS[e.key]) { e.preventDefault(); grade(ACTIONS[e.key]); return; }
    if (e.key === "u") { e.preventDefault(); undo(); return; }
    if (e.key === "n") {
      e.preventDefault();
      const n = el("note");
      if (n) n.focus();
      return;
    }
    if (e.key === "ArrowRight" || e.key === "j") {
      e.preventDefault();
      // Explicit navigation, not auto-advance: the item stays ungraded and
      // comes back on the next page load.
      if (state.idx < state.items.length - 1) { state.idx++; state.pendingNote = ""; render(); }
      else say("end of this page -- grade an item to pull more");
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "k") {
      e.preventDefault();
      if (state.idx > 0) { state.idx--; state.pendingNote = ""; render(); }
      return;
    }
  });

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
