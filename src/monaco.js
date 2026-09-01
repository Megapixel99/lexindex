/**
 * A completion item provider for Monaco.
 *
 *   import { DocumentSet } from "lexindex/browser";
 *   import { completionProvider } from "lexindex/monaco";
 *
 *   const docs = new DocumentSet();
 *   monaco.languages.registerCompletionItemProvider("javascript", completionProvider(docs, { monaco }));
 *
 * Like the CodeMirror source, it imports nothing from the editor. A provider is an object
 * with a `provideCompletionItems` method; the only things it reads are
 * `model.getValueInRange`, `position.lineNumber` and `position.column`, all of which are
 * plain data. Importing `monaco-editor` would put a dependency in a package whose first
 * paragraph invites the reader to check that it has none.
 *
 * WHY IT ASKS FOR `monaco` ANYWAY, unlike the CodeMirror source. A Monaco completion item
 * carries a `kind`, and the value is a member of Monaco's own `CompletionItemKind` enum —
 * a TypeScript enum belonging to that package, not a number fixed by a wire protocol the
 * way `lexindex-lsp`'s `kind: 1` is fixed by LSP. Writing a literal here would be
 * committing to a number this repository cannot check at build time and that nothing would
 * catch when it drifted. So the constant is read off the namespace the caller has already
 * imported, or supplied directly as `kind`, or left off entirely — but never guessed.
 *
 * There are no `triggerCharacters`, and their absence is a decision. Registering `.` would
 * put this in front of member completions, and the first entry in the README's *What it
 * cannot do* is that it has no idea what is in scope and loses outright at a `foo.`
 * position. Where a real language service is registered too, Monaco merges both providers'
 * suggestions, which is the intended arrangement.
 */

import { splitAtCursor } from "./lex.js";
import { topWords } from "./identifiers.js";

/**
 * Build a Monaco `CompletionItemProvider` over an open-document set.
 *
 * @param {import("./documents.js").DocumentSet} docs the open documents
 * @param {{monaco?: any, kind?: number, k?: number, cacheBeta?: number, minPrefix?: number,
 *          lines?: boolean, lineLimit?: number, minConfidence?: number}} [options]
 *   `monaco` the namespace, read only for `languages.CompletionItemKind.Text`; `kind` that
 *   value directly, if you would rather pass it than the namespace; `k` how many to offer;
 *   `cacheBeta` the blend; `minPrefix` how many characters before this answers at all;
 *   `lines` whether to offer whole lines at a line start, on when the set was built with
 *   `lineIndex: true`; `lineLimit` how many; `minConfidence` the floor they must clear.
 * @returns {{provideCompletionItems: (model: any, position: any) => {suggestions: object[], incomplete: boolean}}}
 */
export function completionProvider(
  docs,
  {
    monaco = null,
    kind = undefined,
    k = 5,
    cacheBeta = 0.5,
    minPrefix = 1,
    lines = true,
    lineLimit = 3,
    minConfidence = undefined,
  } = {}
) {
  const itemKind =
    kind !== undefined
      ? kind
      : monaco && monaco.languages && monaco.languages.CompletionItemKind
        ? monaco.languages.CompletionItemKind.Text
        : undefined;

  // One session for the life of the provider: it re-lexes what was typed rather than the
  // document, and it stays correct as documents open and close because the index it points
  // at is mutated in place rather than replaced.
  const session = docs.session({ cacheBeta });

  return {
    provideCompletionItems(model, position) {
      const before = model.getValueInRange({
        startLineNumber: 1,
        startColumn: 1,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      });

      const { prefix } = splitAtCursor(before);
      if (prefix !== null && prefix.length < minPrefix) return empty();

      // Whole lines first, and only at a line start. The gate lives on DocumentSet so this
      // and the CodeMirror source cannot come to disagree about it.
      //
      // Unlike CodeMirror there is no `explicit` flag to consult, and none is needed:
      // Monaco does not auto-trigger where there is no word being typed, so at a line
      // start this provider is reached because somebody asked for it.
      const lineItems = lines ? docs.lineSuggestions(before, { limit: lineLimit, minConfidence }) : [];

      const words = topWords(session, before, k);
      if (words.length === 0 && lineItems.length === 0) return empty();

      // Monaco columns are 1-based, and the item replaces the partial word rather than
      // being inserted beside it.
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - (prefix === null ? 0 : prefix.length),
        endColumn: position.column,
      };

      // One ascending run across both kinds, so lines sort above tokens. Zero padded so
      // that "10" sorts after "9" rather than before it.
      let rank = 0;
      const order = () => String(rank++).padStart(4, "0");

      return {
        // `incomplete` is this editor's spelling of the decision the CodeMirror source
        // makes by omitting `validFor`: without it Monaco keeps the list and filters it
        // client-side as more characters arrive, which is cheaper and wrong. The ranking
        // is conditioned on the token before the cursor, so another keystroke can reorder
        // it and bring in candidates that were never in the list.
        incomplete: true,
        suggestions: [
          ...lineItems.map((c) => {
            const item = {
              label: c.text,
              insertText: c.text,
              filterText: c.text,
              range,
              sortText: order(),
              // Provenance, which is what makes a retrieved line checkable rather than
              // merely convincing. Monaco shows `detail` beside the label and
              // `documentation` in the panel next to it.
              detail: `lexindex line \u00b7 ${(c.confidence * 100).toFixed(0)}%`,
              documentation: `${c.file}:${c.line} \u2014 seen ${c.count} time(s)`,
            };
            if (itemKind !== undefined) item.kind = itemKind;
            return item;
          }),
          ...words.map((entry) => {
            const item = {
              label: entry.token,
              insertText: entry.token,
              filterText: entry.token,
              range,
              // Monaco re-sorts what it is handed, so an ordering not expressed in sortText
              // is an ordering thrown away -- the same reason lexindex-lsp sets it.
              sortText: order(),
              detail: "lexindex",
            };
            // Absent rather than guessed. See the header.
            if (itemKind !== undefined) item.kind = itemKind;
            return item;
          }),
        ],
      };
    },
  };
}

function empty() {
  return { suggestions: [], incomplete: false };
}
