/**
 * Browser script, part 1b: element handles, state, storage, and the API helper.
 *
 * One section of the page template, carried across unchanged in the grading-page
 * decomposition (issue 864). `index.ts` rejoins the parts with a newline between
 * each, so the composed page is byte-identical to the pre-split constant.
 */

export const GRADING_PAGE_SCRIPT_STATE = String.raw`  const REASONS = BLIND_MODE ? [] : VOCAB.reasons;
  const BEHAVIORS = BLIND_MODE ? [] : VOCAB.behaviors;
  const BEHAVIOR_LABELS = VOCAB.behaviorLabels;
  // Positional accelerators for the reason row (index into the OFFERED list,
  // which depends on the selected grade) and fixed ones for the behavior axis.
  // Chosen to sit under the left hand while 1-4 pick the grade, and to avoid
  // the existing bindings: n (note), j/k (move).
  const REASON_KEYS = { q: 0, w: 1, e: 2, r: 3, t: 4, y: 5 };
  const BEHAVIOR_KEYS = BLIND_MODE ? {} : { g: "good", b: "bad", v: "neutral" };
  // Versioned so a future shape change discards an incompatible saved batch
  // instead of half-reading it into the form.
  const STORE_KEY = BLIND_MODE
    ? "ob.grading.batch.blind." + SNAPSHOT_SHA256 + ".v1"
    : "ob.grading.batch.v1";
  const LAST_BATCH_KEY = "ob.grading.lastBatch.v1";

  const el = (id) => document.getElementById(id);

  if (BLIND_MODE) {
    el("agree").closest(".stat").remove();
    el("agent-behavior-stats").hidden = true;
    el("head-kind-stats").hidden = true;
    el("post-send-tools").hidden = true;
    el("reason-keys").remove();
    el("behavior-keys").remove();
  }

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

  // Every failure below is announced. The batch "is not a cache" (see the file
  // header): staged judgement across 1,104 items is the expensive thing, and a
  // silent return here made losing it look exactly like a first run.
  function restore() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORE_KEY);
    } catch (e) {
      // Private mode or a storage-blocking policy. persist() fails the same way
      // and warns -- but only once something is staged. Said up front instead.
      console.warn("grading: local storage unreadable", e);
      say("local storage unavailable -- staged work will not survive a reload", "err");
      return;
    }
    if (!raw) return;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error("grading: stored batch is not valid JSON", e);
      say("saved batch could not be read and was not restored -- it is still in storage, not overwritten", "err");
      return;
    }
    if (!Array.isArray(parsed)) {
      console.error("grading: stored batch is not an array");
      say("saved batch had an unexpected shape and was not restored", "err");
      return;
    }
    // Re-validate rather than trusting storage: a stale or hand-edited entry
    // must not be able to put an action the server will reject into a batch the
    // operator then sends as a unit.
    state.batch = parsed.filter((g) =>
      g && typeof g.candidateId === "string" && ORDER.indexOf(g.action) >= 0);
    if (state.batch.length < parsed.length) {
      // The dropped entries are the operator's own staged decisions. Rejecting
      // them is right; dropping them without a word is not.
      const dropped = parsed.length - state.batch.length;
      console.warn("grading: dropped " + dropped + " unrestorable staged entries");
      say(dropped + " saved item(s) could not be restored and were dropped", "err");
    }
    if (BLIND_MODE) return;
    try {
      const lb = JSON.parse(localStorage.getItem(LAST_BATCH_KEY) || "null");
      if (lb && typeof lb.batch_id === "string") {
        state.lastBatchId = lb.batch_id;
        state.lastBatchSize = lb.size || 0;
      }
    } catch (e) {
      // No last batch is the normal first-run case, so this is not operator
      // facing -- but a corrupt value means undo silently will not be offered.
      console.warn("grading: last-batch marker unreadable, undo unavailable", e);
    }
  }

  function rememberLastBatch(id, size) {
    if (BLIND_MODE) return;
    state.lastBatchId = id;
    state.lastBatchSize = size;
    try {
      localStorage.setItem(LAST_BATCH_KEY,
        id === null ? "null" : JSON.stringify({ batch_id: id, size: size }));
    } catch (e) {
      // Undo still works this session without it; it will not survive a reload.
      console.warn("grading: could not persist last-batch marker", e);
    }
  }

  // ---- server ---------------------------------------------------------------

  async function api(path, options) {
    const res = await fetch(path, options);
    let body = null;
    try {
      body = await res.json();
    } catch (e) {
      // A non-JSON error page is still an error, and the throw below reports
      // the status. But a 200 whose body will not parse is a different bug --
      // the caller gets null and behaves as if the server said nothing.
      console.warn("grading: response body was not JSON (HTTP " + res.status + ")", e);
    }
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
    // Ungraded, not total: the header counts what is still in front of the
    // operator. Same rolling-restart fallback as the behavior counters -- an
    // older /api/stats has no by_anchor_kind and must not blank the readout.
    const ak = s.by_anchor_kind || {};
    const akn = (k) => (ak[k] && ak[k].ungraded) || 0;
    setText("k-typed", akn("typed"));
    setText("k-auq", akn("askuserquestion"));
    setText("k-orphan", akn("orphan"));
    setText("k-fragment", akn("fragment"));
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
    if (!BLIND_MODE) await refreshStats();
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
    if (!BLIND_MODE) wrap.append(reasons);

    const note = document.createElement("textarea");
    note.className = "note";
    note.id = "note";
    note.placeholder = BLIND_MODE
      ? "Optional note"
      : "note (optional) -- your own words, or click a reason above to start one; goes to candidate_grade.note, never over the distiller's reason";`;
