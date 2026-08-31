/**
 * The open documents, as an index that follows them.
 *
 * `buildIndex` walks a directory, which is the wrong shape for a page: a CodeMirror or
 * Monaco embedding has no file system and no repository, only the documents somebody
 * currently has open. This is the same index over that set, kept current by the same
 * incremental path a language server uses — one document's counts subtracted and its
 * replacement added, rather than a rebuild per keystroke.
 *
 * THE ACTIVE DOCUMENT IS NOT IN THE INDEX, and that is the one decision here worth
 * arguing with. It is not an oversight and it is not a privacy measure: the buffer is
 * already served, better, by the cache half of the blend, which reads the text above the
 * cursor and nothing below it. Indexing the active document as well would feed the
 * completer the rest of the file — including the continuation it is being asked to
 * predict — and every accuracy number this package publishes was measured with the
 * edited document held out. An index that quietly saw the answer would report a number
 * nobody could reproduce from the harness.
 *
 * So `activate(id)` moves one document out of the index and the previous one back in.
 * That costs a document rather than a corpus, which is the same trade `updateIndexFile`
 * makes: 4 ms against 585 ms on a 400-file corpus.
 *
 * What this reaches is measured in the README's *Where no language server runs*. The
 * short version, because it decides how much of this is worth wiring up: with one
 * document open the cache carries the whole result and this class contributes nothing,
 * and from the first OTHER open document the index starts paying.
 */

import { lex } from "./lex.js";
import { CountModel } from "./count-model.js";
import { Completer } from "./completer.js";

export class DocumentSet {
  /**
   * @param {{order?: number}} [options] n-gram order, matching `buildIndex`'s default
   */
  constructor({ order = 5 } = {}) {
    /** The index over every open document except the active one. Mutated in place. */
    this.index = new CountModel(order).finalize();
    /** id -> that document's tokens, the active one included. */
    this.tokens = new Map();
    /** The document holding the cursor, or null. */
    this.activeId = null;
  }

  /** How many documents are open, the active one included. */
  get size() {
    return this.tokens.size;
  }

  /**
   * Add a document, or replace one already open with its new text.
   *
   * Safe to call on every save, or on a debounce while typing. It costs this document,
   * not the set. Calling it for the active document stores the tokens without indexing
   * them, so that switching away later has something to put in.
   */
  open(id, text) {
    const next = lex(text);
    const held = this.tokens.get(id);
    this.tokens.set(id, next);
    if (id !== this.activeId) {
      this.index.replaceFileTokens(held && held.length ? held : null, next.length ? next : null);
    }
    return this;
  }

  /** Close a document: its counts leave the index with it. */
  close(id) {
    const held = this.tokens.get(id);
    if (held === undefined) return this;
    this.tokens.delete(id);
    if (id === this.activeId) {
      // It was never in the index, so there is nothing to subtract.
      this.activeId = null;
      return this;
    }
    this.index.replaceFileTokens(held.length ? held : null, null);
    return this;
  }

  /**
   * Move the cursor to a document. The one it leaves joins the index; the one it enters
   * leaves, for the reason at the top of this file.
   *
   * `activate(null)` puts everything back in, which is what a page with no focused editor
   * wants. An id that is not open is allowed: an editor usually knows which document has
   * the cursor before it has handed over the text.
   */
  activate(id) {
    if (id === this.activeId) return this;
    const leaving = this.activeId === null ? undefined : this.tokens.get(this.activeId);
    const entering = id === null ? undefined : this.tokens.get(id);
    this.activeId = id;

    // One reopen/finalize for both halves rather than two, since finalize() rebuilds the
    // context totals and doing it twice for one cursor move is pure waste.
    this.index.reopen();
    if (entering && entering.length) this.index.removeFileTokens(entering);
    if (leaving && leaving.length) this.index.addFileTokens(leaving);
    this.index.finalize();
    return this;
  }

  /** A `Completer` over the current index. It tracks later edits: the index is one object. */
  completer(options) {
    return new Completer(this.index, options);
  }

  /**
   * A `BufferSession` over the current index — the one to hold on to in an editor, since
   * it re-lexes what was typed rather than the file. It stays correct across `open`,
   * `close` and `activate`, because those mutate the index this session already points at.
   */
  session(options) {
    return this.completer(options).session();
  }

  /**
   * How often a four-token context from `text` is already in the index: the number the
   * README's first table turns on, for the documents this page happens to have open.
   *
   * Worth surfacing rather than hiding. It is the honest predictor of whether any of this
   * is helping, it moves as tabs open and close, and `recitalBand` says what it means.
   */
  recital(text) {
    return this.index.recitalRate(lex(text));
  }
}
