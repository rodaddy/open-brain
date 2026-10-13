/**
 * Browser script, part 4: grading history, regrade, and keyboard navigation.
 *
 * One section of the page template, carried across unchanged in the grading-page
 * decomposition (issue 864). `index.ts` rejoins the parts with a newline between
 * each, so the composed page is byte-identical to the pre-split constant.
 */

export const GRADING_PAGE_SCRIPT_HISTORY = String.raw`  async function openHistory() {
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
          m.textContent = "machine prediction: " + g.machine_grade;
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
