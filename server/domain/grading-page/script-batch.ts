/**
 * Browser script, part 3: the pending batch list, staging, and sending.
 *
 * One section of the page template, carried across unchanged in the grading-page
 * decomposition (issue 864). `index.ts` rejoins the parts with a newline between
 * each, so the composed page is byte-identical to the pre-split constant.
 */

export const GRADING_PAGE_SCRIPT_BATCH = String.raw`  function renderBatch() {
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
      ...(BLIND_MODE ? {} : {
        reasonCode: g.reasonCode || undefined,
        agentBehavior: g.agentBehavior || undefined,
      }),
    }));
    const envelope = { grades: payload };
    if (BLIND_MODE) envelope.snapshotSha256 = SNAPSHOT_SHA256;
    try {
      const res = await api("/api/grade-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const n = BLIND_MODE ? res.savedCount : res.results.length;
      state.sent += n;
      state.batch = [];
      persist();
      if (!BLIND_MODE) rememberLastBatch(res.batch_id, n);
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
`;
