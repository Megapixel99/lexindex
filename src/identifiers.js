/**
 * The one thing every editor integration here does identically, in one place.
 *
 * A completion popup offering `;` is noise. The measurements score punctuation because a
 * fair benchmark has to — aggregate top-1 is mostly punctuation for every engine including
 * this one — but a popup is not a benchmark, so every adapter keeps the identifier-shaped
 * suggestions and drops the rest.
 *
 * Which means asking for `k` and filtering is wrong: it returns fewer than `k` whenever
 * punctuation ranks highly, which at a `(` or a `,` is most of the time. Ask wide and stop
 * at `k`, which is what `lexindex-lsp` has always done and what the CodeMirror source
 * should have been doing.
 */

import { isWord } from "./lex.js";

/** How much wider to ask. Four was the language server's number and is kept deliberately. */
const OVERSHOOT = 4;

/**
 * Up to `k` identifier-shaped suggestions, best first, with their scores.
 *
 * @param {{completeScored: (text: string, opts: {k: number}) => {token: string, score: number}[]}} source
 *   anything that scores completions -- a `BufferSession` in an editor, a `Completer` in the CLI
 * @param {string} textBeforeCursor everything above the cursor
 * @param {number} k how many to keep
 * @returns {{token: string, score: number}[]}
 */
export function topWords(source, textBeforeCursor, k) {
  const scored = source.completeScored(textBeforeCursor, { k: k * OVERSHOOT });
  const out = [];
  for (const entry of scored) {
    if (!isWord(entry.token)) continue;
    out.push(entry);
    if (out.length >= k) break;
  }
  return out;
}
