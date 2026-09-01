/**
 * The browser entry point: everything here, minus the file walker.
 *
 *   import { DocumentSet, Completer } from "lexindex/browser";
 *
 * `src/index.js` exports `buildIndex`, which imports `node:fs` and `node:path`. Nothing
 * else in this package touches a node builtin — the mechanism never needed one, since the
 * lexer takes a string and the index takes token arrays — but a bundler following the main
 * entry has no way to know that, and pulls `fs` into a page that will never call it.
 * Depending on the bundler that is either a wasted shim or a hard resolution error, and
 * neither is the user's fault.
 *
 * So this is the same package with the one node-shaped thing left out. It is a second
 * export rather than a second implementation: every name below is the same object the
 * main entry exports, and the suite asserts that this file's whole import graph is free of
 * node builtins rather than trusting the list to stay correct.
 *
 * In a page, `DocumentSet` is what replaces `buildIndex`: the index is built from the
 * documents somebody has open rather than from a directory. There is no prebuilt corpus to
 * ship and shipping one would be worse than nothing — see the last row of *Seven things it
 * deliberately does not do*.
 */
export { lex, isWord, splitAtCursor, trailingWordStart } from "./lex.js";
export { CountModel, recitalBand } from "./count-model.js";
// No I/O: the line table is handed text, never a path, so the browser build keeps it.
export { LineIndex, LINE_CONTEXT, MAX_PER_CONTEXT } from "./line-index.js";
export { CacheModel } from "./cache-model.js";
export { Completer } from "./completer.js";
export { BufferSession } from "./session.js";
export { DocumentSet } from "./documents.js";
export { LANGUAGES, LANGUAGE_NAMES, resolveLanguages } from "./languages.js";
export { isLikelyGenerated } from "./generated.js";
