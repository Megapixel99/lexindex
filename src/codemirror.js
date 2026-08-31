/**
 * A completion source for CodeMirror 6.
 *
 *   import { DocumentSet } from "lexindex/browser";
 *   import { completionSource } from "lexindex/codemirror";
 *
 *   const docs = new DocumentSet();
 *   autocompletion({ override: [completionSource(docs)] })
 *
 * IT IMPORTS NOTHING FROM CODEMIRROR, and that is deliberate rather than clever. A
 * completion source is a function from a context to a result; both are plain objects, and
 * the only things this reads are `pos`, `explicit` and `state.doc.sliceString`. Importing
 * `@codemirror/autocomplete` to get a type would put a dependency in a package whose
 * README opens by saying it has none and inviting the reader to check package.json. The
 * suite asserts the surface instead, with a context that throws on any other property.
 *
 * What it replaces is `completeAnyWord`, which offers the words already in the document
 * with no ordering worth the name. Against that baseline the measurements are in the
 * README's *Where no language server runs*; read the two-line version there before wiring
 * this up, because with a single document open it is the cache doing the work and the
 * `DocumentSet` contributes nothing.
 */

import { splitAtCursor } from "./lex.js";
import { topWords } from "./identifiers.js";

/**
 * Build a CodeMirror 6 `CompletionSource` over an open-document set.
 *
 * @param {import("./documents.js").DocumentSet} docs the open documents
 * @param {{k?: number, cacheBeta?: number, minPrefix?: number}} [options]
 *   `k` how many to offer; `cacheBeta` the blend, 0.5 unless you have measured otherwise;
 *   `minPrefix` how many characters must be typed before the popup appears unaided.
 * @returns {(context: any) => ({from: number, options: object[]}|null)}
 */
export function completionSource(docs, { k = 5, cacheBeta = 0.5, minPrefix = 1 } = {}) {
  // One session for the life of the source. It re-lexes what was typed rather than the
  // whole document, which is 3.26 ms to 1.14 ms per keystroke on a 175 KB buffer, and it
  // survives every edit to the document set because the index it points at is mutated in
  // place rather than replaced.
  const session = docs.session({ cacheBeta });

  return function lexindexCompletions(context) {
    const before = context.state.doc.sliceString(0, context.pos);
    const { prefix } = splitAtCursor(before);

    // Nothing typed yet: only answer if the user asked for the popup explicitly. A source
    // that fires on every space turns into a popup that will not go away.
    if (prefix === null) {
      if (!context.explicit) return null;
    } else if (prefix.length < minPrefix && !context.explicit) {
      return null;
    }

    // Identifier-shaped only, and asked for wide enough to still return `k` of them when
    // punctuation ranks highly -- see identifiers.js.
    const words = topWords(session, before, k);
    if (words.length === 0) return null;

    return {
      from: prefix === null ? context.pos : context.pos - prefix.length,
      options: words.map((e, i) => ({
        label: e.token,
        // CodeMirror re-ranks what it is handed, so an ordering that is not expressed as
        // `boost` is an ordering thrown away — the same trap the language server's
        // `sortText` exists to avoid. Descending from 99 keeps this list's order, which
        // is the only thing this source contributes.
        boost: 99 - i,
      })),
      // No `validFor`. It would let CodeMirror filter this list as more characters arrive
      // instead of asking again, which is cheaper and wrong: the ranking is conditioned on
      // the token before the cursor, so the next keystroke does not merely narrow the list,
      // it can reorder it and bring in candidates that were never in it. The session is
      // what makes asking again affordable.
    };
  };
}

/**
 * `type` is deliberately absent from every option above.
 *
 * It draws CodeMirror's little icon — variable, function, class — and this package has no
 * idea which is right. It is not type-aware, has no notion of scope, and the first entry
 * in the README's *What it cannot do* says so. Guessing "variable" for everything would
 * put a confident wrong icon beside every suggestion, which is worse than no icon.
 */
