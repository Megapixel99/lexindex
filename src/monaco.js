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
 * @param {{monaco?: any, kind?: number, k?: number, cacheBeta?: number, minPrefix?: number}} [options]
 *   `monaco` the namespace, read only for `languages.CompletionItemKind.Text`; `kind` that
 *   value directly, if you would rather pass it than the namespace; `k` how many to offer;
 *   `cacheBeta` the blend; `minPrefix` how many characters before this answers at all.
 * @returns {{provideCompletionItems: (model: any, position: any) => {suggestions: object[], incomplete: boolean}}}
 */
export function completionProvider(
  docs,
  { monaco = null, kind = undefined, k = 5, cacheBeta = 0.5, minPrefix = 1 } = {}
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

      const words = topWords(session, before, k);
      if (words.length === 0) return empty();

      // Monaco columns are 1-based, and the item replaces the partial word rather than
      // being inserted beside it.
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: position.column - (prefix === null ? 0 : prefix.length),
        endColumn: position.column,
      };

      return {
        // `incomplete` is this editor's spelling of the decision the CodeMirror source
        // makes by omitting `validFor`: without it Monaco keeps the list and filters it
        // client-side as more characters arrive, which is cheaper and wrong. The ranking
        // is conditioned on the token before the cursor, so another keystroke can reorder
        // it and bring in candidates that were never in the list.
        incomplete: true,
        suggestions: words.map((entry, i) => {
          const item = {
            label: entry.token,
            insertText: entry.token,
            filterText: entry.token,
            range,
            // Monaco re-sorts what it is handed, so an ordering not expressed in sortText
            // is an ordering thrown away — the same reason lexindex-lsp sets it. Zero
            // padded so that "10" sorts after "9" rather than before it.
            sortText: String(i).padStart(4, "0"),
            detail: "lexindex",
          };
          // Absent rather than guessed. See the header.
          if (itemKind !== undefined) item.kind = itemKind;
          return item;
        }),
      };
    },
  };
}

function empty() {
  return { suggestions: [], incomplete: false };
}
