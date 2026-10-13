/**
 * Browser script, part 2: the grading form, reason buttons, and card render.
 *
 * One section of the page template, carried across unchanged in the grading-page
 * decomposition (issue 864). `index.ts` rejoins the parts with a newline between
 * each, so the composed page is byte-identical to the pre-split constant.
 */

export const GRADING_PAGE_SCRIPT_FORM = String.raw`    note.value = state.form.note;
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
    if (!BLIND_MODE) wrap.append(behavior);

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
    if (!BLIND_MODE && it.model) row.append(tag(it.model));
    if (!BLIND_MODE && it.machine_grade) {
      row.append(tag("machine prediction: " + it.machine_grade, "machine"));
    }
    if (it.reinforcement && it.reinforcement.session_count > 1) {
      // gbrain-style receipt (dream-design.md:709-712): the count with its dates,
      // computed live from content_occurrences, never a stored number.
      const r = it.reinforcement;
      const first = r.first_seen ? new Date(r.first_seen).toLocaleDateString() : "?";
      const last = r.last_seen ? new Date(r.last_seen).toLocaleDateString() : "?";
      const noFrozenDates = BLIND_MODE && !r.first_seen && !r.last_seen;
      const dates = noFrozenDates ? "" : ", " + first + " to " + last;
      row.append(tag("seen " + r.occurrence_count + "x across " + r.session_count +
        " sessions" + dates, "reinforced"));
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
      // AUQ IS BADGED, NOT MERGED (migration 043). Operator, verbatim: "with the
      // exception of maybe AskUserQuestions sections, that's kind of a hybrid
      // and should be treated more like it came from me i think, with that note
      // that it is AUQ". So it renders in the operator position -- it IS him
      // deciding -- but says on its face that the options were the agent's,
      // because a menu choice is bounded by what was offered and a typed
      // sentence is not. One chip, in the header row where every other
      // provenance marker already lives, so it is unmissable without adding a
      // second visual language to the card.
      const auq = it.anchor_kind === "askuserquestion";
      if (auq) {
        row.append(tag("AUQ -- chose from options I offered", "auq"));
      }
      const lead = document.createElement("div");
      lead.className = "op-lead" + (auq ? " auq" : "");
      const who = document.createElement("div");
      who.className = "who";
      who.textContent = auq
        ? "you answered an AskUserQuestion -- your choice, the agent's options"
        : "you asked";
      const body = document.createElement("div");
      body.className = "body";
      body.textContent = it.operator_text;
      lead.append(who, body);
      card.append(lead);
    } else if (!BLIND_MODE && it.unit_kind === "exchange") {
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
    if (BLIND_MODE && (!it.context || it.context.length === 0)) {
      const frozen = document.createElement("div");
      frozen.className = "empty";
      frozen.style.marginTop = "14px";
      frozen.textContent = "Frozen candidate input";
      stage.append(frozen);
      return;
    }
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
`;
