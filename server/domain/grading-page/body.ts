/**
 * Page body markup for the grading page.
 *
 * Split out of the single-file grading page for issue #864. The template text
 * is unchanged; `index.ts` rejoins the parts with a newline between each, so the
 * composed page is byte-identical to the single-file original.
 */

export const GRADING_PAGE_BODY = String.raw`<body>
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
  <span class="stat" id="agent-behavior-stats" title="The second axis: how the agent behaved, counted over live grades only.">agent good <b id="b-good">0</b> / bad <b id="b-bad">0</b>
        / neutral <b id="b-neutral">0</b></span>
  <span class="stat" id="head-kind-stats" title="Ungraded rows by how the operator authored the head (043). AUQ counts the AskUserQuestion answers -- before 043 every one of them headed nothing.">heads typed <b id="k-typed">0</b> / AUQ <b id="k-auq">0</b>
        / orphan <b id="k-orphan">0</b> / fragment <b id="k-fragment">0</b></span>
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

    <div class="card" id="post-send-tools">
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
  <span id="reason-keys"><kbd>q</kbd><kbd>w</kbd><kbd>e</kbd><kbd>r</kbd> quick reason</span>
  <span id="behavior-keys"><kbd>g</kbd><kbd>b</kbd><kbd>v</kbd> agent good/bad/neutral</span>
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
`;
