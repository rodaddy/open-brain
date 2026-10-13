/**
 * Browser script, part 1a: the <script> opening and the reason-vocabulary comment. Ends immediately before the one interpolated line, which index.ts supplies.
 *
 * One section of the page template, carried across unchanged in the grading-page
 * decomposition (issue 864). `index.ts` rejoins the parts with a newline between
 * each, so the composed page is byte-identical to the pre-split constant.
 */

export const GRADING_PAGE_SCRIPT_OPEN = String.raw`<script>
(() => {
  "use strict";

  // Keys select a grade in the form. They do NOT stage and they do NOT send --
  // that separation is the entire rebuild.
  const ACTIONS = { "1": "promoted", "2": "rejected", "3": "inconclusive", "4": "duplicate" };
  const ORDER = ["promoted", "rejected", "inconclusive", "duplicate"];
  const LABELS = { promoted: "pass", rejected: "fail", inconclusive: "inconclusive", duplicate: "duplicate" };
  // The canned reasons and the behavior vocabulary, inlined from
  // server/domain/grading-reasons.ts at build time. ONE definition shared with the server,
  // so this page cannot offer a code the write path rejects at SEND.`;
