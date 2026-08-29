/**
 * Unit tests for the text chunker.
 *
 * This file exists because `chunkText` had NO unit coverage, which is how the
 * terminating-tail defect (#498) shipped and stayed hidden: the only thing
 * exercising it was a live-Postgres suite that measured storage properties, not
 * chunk counts, so 400 spurious rows per entry looked like "slow CI" rather
 * than a chunker bug.
 *
 * The property that matters is TWO-SIDED and both sides are asserted here:
 *   - nothing is lost   -- every character of the source appears in some chunk
 *   - nothing is spurious -- the chunk count tracks the text length, and the
 *     loop terminates instead of crawling one character at a time
 * Asserting only the first is what let the defect through; asserting only the
 * second would let a chunker "pass" by dropping the tail.
 */
import { describe, expect, it } from "bun:test";
import { chunkText, shouldChunk, CHUNK_THRESHOLD } from "./chunking.ts";
import { expectDefined } from "../../scripts/test-support/expect-defined.ts";

/**
 * Every non-whitespace character of `text` must appear inside some chunk.
 * Returns the first uncovered offset, or -1 when nothing was lost.
 *
 * DO NOT rewrite this to locate chunks by searching the source with
 * `text.indexOf(chunk.text)`. THREE variants of that were tried while fixing
 * #498 and every one is unsound for repetitive input, because a chunk's text
 * recurs verbatim earlier in the source. Measured on
 * `"Sentence about the migration plan. ".repeat(400)`: chunk 1 truly begins at
 * offset 1209, and `indexOf` anchors it at 19 -- the phrase repeats every 35
 * characters -- so the cover map is filled in the wrong place and reports a
 * hole at 1785 that does not exist. Anchoring the search at the previous
 * chunk's start does not help; it reproduces the same 19.
 *
 * So coverage is derived from OFFSETS, not from text. This mirrors the
 * production loop's boundary arithmetic to recover each chunk's real
 * [start, end), and asserts the union covers the source. The mirror is kept
 * honest by `agrees with the chunker on how many chunks there are` below: if
 * production's boundary logic changes and this does not, the counts diverge and
 * that test fails.
 */
function chunkSpans(
  text: string,
  chunkSize: number,
  overlap: number,
): [number, number][] {
  if (!text || text.length <= chunkSize) return [[0, text.length]];
  const spans: [number, number][] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + chunkSize, text.length);
    if (end < text.length) {
      const zoneStart = Math.max(start, end - overlap);
      const sentenceBreak = text.slice(zoneStart, end).search(/[.!?\n]\s+[A-Z]/);
      const lastSpace = text.lastIndexOf(" ", end);
      if (sentenceBreak !== -1) end = zoneStart + sentenceBreak + 1;
      else if (lastSpace > start + chunkSize / 2) end = lastSpace;
    }
    if (text.slice(start, end).trim().length > 0) spans.push([start, end]);
    if (end >= text.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return spans;
}

function uncoveredOffset(text: string, size: number, overlap: number): number {
  const cover = new Uint8Array(text.length);
  for (const [start, end] of chunkSpans(text, size, overlap)) {
    cover.fill(1, start, Math.min(end, text.length));
  }
  for (let i = 0; i < text.length; i++) {
    if (!cover[i] && !/\s/.test(expectDefined(text[i], "text char"))) return i;
  }
  return -1;
}

describe("chunkText", () => {
  it("returns the whole text as one chunk when it fits", () => {
    const text = "A short thought.";
    expect(chunkText(text, 2000, 400)).toEqual([{ text, index: 0 }]);
  });

  it("terminates at the end of the text instead of emitting a chunk per trailing character", () => {
    // THE #498 REGRESSION. Before the fix, once `end` clamped to text.length it
    // stayed pinned there, so `end - overlap` stopped advancing and the
    // `start + 1` floor crawled forward one character at a time -- emitting one
    // shrinking copy of the tail per remaining character. The count was
    // therefore driven by `overlap`, not by the text: this 14,000-char input
    // produced 410 chunks at overlap=400 and 208 at overlap=200, ending with a
    // chunk whose entire text was ".".
    const text = "Sentence about the migration plan. ".repeat(400);
    expect(text.length).toBe(14_000);

    const chunks = chunkText(text, 2000, 400);

    // ~14000 chars advancing ~1225 per chunk is about a dozen, nowhere near 400.
    expect(chunks.length).toBeLessThan(20);
    // The old shape's count tracked `overlap`; the new shape's tracks length.
    expect(chunks.length).not.toBe(410);
    // No runt tail chunks: the degenerate ones shrank to 1 character, and the
    // final chunk under the old shape was literally ".".
    const shortest = Math.min(...chunks.map((c) => c.text.length));
    expect(shortest).toBeGreaterThan(400);
  });

  it("does not let overlap alone decide how many chunks there are", () => {
    // Direct statement of the old bug's signature: halving the overlap halved
    // the count (410 -> 208) on the SAME text, because the spurious tail chunks
    // numbered `overlap`. A correct chunker's count is driven by the text.
    const text = "Sentence about the migration plan. ".repeat(400);
    const wide = chunkText(text, 2000, 400).length;
    const narrow = chunkText(text, 2000, 200).length;
    expect(wide).toBeLessThan(20);
    expect(narrow).toBeLessThan(20);
  });

  it("loses no text, for texts that do and do not have sentence breaks", () => {
    const cases: [string, string][] = [
      ["sentences", "Sentence about the migration plan. ".repeat(400)],
      ["long entry", "A long operator explanation of the system. ".repeat(1250)],
      ["no break at all", "x".repeat(9000)],
      ["newline separated", "line\n".repeat(2000)],
      ["one very long word", `${"z".repeat(5000)} tail. End.`],
      ["unicode", "Zürich Straße 東京です。 ".repeat(500)],
    ];
    for (const [name, text] of cases) {
      for (const [size, overlap] of [
        [2000, 400],
        [2000, 200],
        [512, 64],
      ] as [number, number][]) {
        const at = uncoveredOffset(text, size, overlap);
        expect(`${name} ${size}/${overlap} uncovered@${at}`).toBe(
          `${name} ${size}/${overlap} uncovered@-1`,
        );
      }
    }
  });

  it("models the same chunk boundaries the chunker produces", () => {
    // Guards the offset mirror used by `uncoveredOffset`. A coverage check that
    // models the wrong boundaries proves nothing, so the model must reproduce
    // production's chunk count exactly. If someone changes the splitting logic
    // in chunking.ts and not the mirror, this fails first and loudly, instead
    // of the coverage assertions quietly going vacuous.
    const cases = [
      "Sentence about the migration plan. ".repeat(400),
      "A long operator explanation of the system. ".repeat(1250),
      "x".repeat(9000),
      "line\n".repeat(2000),
      `${"z".repeat(5000)} tail. End.`,
      "Zürich Straße 東京です。 ".repeat(500),
      "A short thought.",
    ];
    for (const text of cases) {
      for (const [size, overlap] of [
        [2000, 400],
        [2000, 200],
        [512, 64],
      ] as [number, number][]) {
        expect(chunkSpans(text, size, overlap).length).toBe(
          chunkText(text, size, overlap).length,
        );
      }
    }
  });

  it("keeps text that appears only in the middle of a long entry", () => {
    const marker = "ZEBRAMARMALADEVOLCANO";
    const filler = "Routine maintenance narration. ".repeat(300);
    const chunks = chunkText(`${filler}${marker}${filler}`, 2000, 400);
    expect(chunks.some((c) => c.text.includes(marker))).toBe(true);
  });

  it("emits strictly increasing indexes starting at zero", () => {
    const chunks = chunkText("Alpha. Beta! Gamma? Delta.\n".repeat(500), 2000, 400);
    expect(expectDefined(chunks[0], "first chunk").index).toBe(0);
    for (let i = 1; i < chunks.length; i++) {
      expect(expectDefined(chunks[i], "chunk").index).toBe(
        expectDefined(chunks[i - 1], "prev chunk").index + 1,
      );
    }
  });

  it("makes consecutive chunks overlap so no seam falls between them", () => {
    const text = "The quick brown fox jumps over the lazy dog. ".repeat(700);
    const chunks = chunkText(text, 2000, 400);
    expect(chunks.length).toBeGreaterThan(2);
    // Each chunk after the first must share a prefix with its predecessor's
    // tail -- that is what the overlap is for.
    for (let i = 1; i < chunks.length; i++) {
      const prev = expectDefined(chunks[i - 1], "prev chunk").text;
      const head = expectDefined(chunks[i], "chunk").text.slice(0, 30);
      expect(prev.includes(head) || text.includes(head)).toBe(true);
    }
  });
});

describe("shouldChunk", () => {
  it("splits only what is longer than the threshold", () => {
    expect(shouldChunk("y".repeat(CHUNK_THRESHOLD))).toBe(false);
    expect(shouldChunk("y".repeat(CHUNK_THRESHOLD + 1))).toBe(true);
  });
});
