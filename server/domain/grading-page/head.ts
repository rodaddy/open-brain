/**
 * Document head and stylesheet for the grading page.
 *
 * Split out of the single-file grading page for issue #864. The template text
 * is unchanged; `index.ts` rejoins the parts with a newline between each, so the
 * composed page is byte-identical to the single-file original.
 */

export const GRADING_PAGE_HEAD = String.raw`<!doctype html>
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
  /* The AskUserQuestion chip (043). Filled rather than outlined, because it is
     the one tag that changes how the operator should READ the head above it --
     the others describe the row, this one qualifies his own authorship. Amber,
     which is already the page's "hedge this" colour (uncertain, inconclusive),
     rather than a seventh hue nobody has a meaning for. */
  .tag.auq {
    color: #ffd98a; border-color: #7a5f1c; background: #2a2312; font-weight: 600;
  }
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
  /* An AUQ head keeps the operator's block -- it IS him deciding -- but recolours
     its edge to the hedge amber so the qualification is visible at a glance even
     with the chip scrolled out of view. Deliberately a re-tint of the SAME block
     rather than a different one: demoting it visually would contradict the
     operator's own "treated more like it came from me". */
  .op-lead.auq { border-color: #7a5f1c; border-left-color: #d9a520; background: #241f14; }
  .op-lead.auq .who { color: #ffd98a; }
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
</head>`;
