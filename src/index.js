/**
 * lexindex — per-repo statistical code completion.
 *
 *   import { buildIndex, Completer } from "lexindex";
 *
 *   const { index } = buildIndex("./src");
 *   const completer = new Completer(index);
 *   completer.complete("const conf");     // -> ["config", "configure", ...]
 *
 * Read the README's Limits before trusting a number from it. In particular: this is not
 * type-aware, and where a language server runs the language server is better.
 */
export { lex, isWord, splitAtCursor, trailingWordStart } from "./lex.js";
export { CountModel, recitalBand } from "./count-model.js";
export {
  LineIndex,
  localIndex,
  localIndexFor,
  atLineStart,
  LOCAL_TAIL_LINES,
  LINE_WIDTHS,
  LINE_CONTEXT,
  MAX_PER_CONTEXT,
  DEFAULT_MIN_CONFIDENCE,
} from "./line-index.js";
export { CacheModel } from "./cache-model.js";
export { Completer } from "./completer.js";
export { BufferSession } from "./session.js";
export { DocumentSet } from "./documents.js";
export { buildIndex, updateIndexFile, collectFiles } from "./build.js";
export { LANGUAGES, LANGUAGE_NAMES, resolveLanguages } from "./languages.js";
export { isLikelyGenerated } from "./generated.js";
