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
 * IT KEEPS THE SAME CORPUS HYGIENE THE FILE WALKER DOES, for the same reason and with the
 * same defaults. `collectFiles` skips a file over 400 KB, because minified bundles and
 * generated dumps repeat themselves enormously and repetition is exactly what this
 * measures — point 3 of the README's *What it cannot do*. A page has no `stat` to consult,
 * but it has the string, and a tab holding a vendored bundle would otherwise walk straight
 * into the index and quietly make every suggestion worse. Generated code is flagged on the
 * same terms as the CLI's: counted and reported always, excluded only if you ask.
 *
 * And it will say what it is doing, which is the posture the whole project takes about its
 * own weaknesses. `onRecital` is the browser's answer to the line `lexindex-lsp` writes to
 * the editor's log as each document opens — a page has no log, so the caller is handed the
 * number instead of it being dropped. `onExcluded` fires when a document is present but
 * not indexed, because a silently unindexed tab is the one thing here that would look
 * exactly like the tool simply not helping much.
 *
 * What this reaches is measured in the README's *Where no language server runs*. The
 * short version, because it decides how much of this is worth wiring up: with one
 * document open the cache carries the whole result and this class contributes nothing,
 * and from the first OTHER open document the index starts paying.
 */

import { lex } from "./lex.js";
import { CountModel, recitalBand } from "./count-model.js";
import { Completer } from "./completer.js";
import { isLikelyGenerated } from "./generated.js";

/**
 * The file walker's ceiling, in characters rather than bytes.
 *
 * `collectFiles` measures 400 KB on disk with `stat`; a page holds a string and counting
 * its UTF-8 bytes would mean encoding every document to decide whether to read it. For the
 * content this exists to keep out — minified bundles, generated dumps — the two numbers
 * are the same to within the width of the threshold, and the alternative is a ceiling
 * nobody applies because it costs too much to check.
 */
const DEFAULT_MAX_LENGTH = 400_000;

export class DocumentSet {
  /**
   * @param {{order?: number, maxLength?: number, skipGenerated?: boolean,
   *          onRecital?: ((e: {id: any, rate: number, band: string, reason: string}) => void)|null,
   *          onExcluded?: ((e: {id: any, reason: string, length: number}) => void)|null}} [options]
   */
  constructor({
    order = 5,
    maxLength = DEFAULT_MAX_LENGTH,
    skipGenerated = false,
    onRecital = null,
    onExcluded = null,
  } = {}) {
    /** The index over every open document except the active one and the excluded ones. */
    this.index = new CountModel(order).finalize();
    /** id -> that document's tokens. Empty for a document too long to be worth lexing. */
    this.tokens = new Map();
    /**
     * Exactly what the index holds: id -> the token array that was added for it. Keeping
     * the array rather than a flag is what makes every transition decidable by identity —
     * an edit changes the array, so "already indexed" and "indexed with the old text" are
     * not the same state and cannot be confused.
     */
    this.indexed = new Map();
    /** id -> "size" | "generated", for documents that are open but deliberately not indexed. */
    this.excluded = new Map();
    /** Documents that look generated, whether or not they were excluded for it. */
    this.generated = new Set();
    /** The document holding the cursor, or null. */
    this.activeId = null;

    this.maxLength = maxLength;
    this.skipGenerated = skipGenerated;
    this.onRecital = onRecital;
    this.onExcluded = onExcluded;
  }

  /** How many documents are open, the active and excluded ones included. */
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
    const isNew = !this.tokens.has(id);
    this.excluded.delete(id);
    this.generated.delete(id);

    let reason = null;
    if (text.length > this.maxLength) {
      reason = "size";
    } else if (isLikelyGenerated(text, typeof id === "string" ? id : "")) {
      this.generated.add(id);
      if (this.skipGenerated) reason = "generated";
    }

    // A document kept out on length is not lexed either. Lexing a five-megabyte bundle to
    // then throw the tokens away is the cost this ceiling exists to avoid.
    this.tokens.set(id, reason === "size" ? [] : lex(text));
    if (reason) {
      this.excluded.set(id, reason);
      if (this.onExcluded) this.onExcluded({ id, reason, length: text.length });
    }

    this._apply([id]);
    if (isNew) this._reportRecital(id, "open");
    return this;
  }

  /** Close a document: its counts leave the index with it. */
  close(id) {
    if (!this.tokens.has(id)) return this;
    this.tokens.delete(id);
    this.excluded.delete(id);
    this.generated.delete(id);
    if (id === this.activeId) this.activeId = null;
    this._apply([id]);
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
    const previous = this.activeId;
    this.activeId = id;
    this._apply([previous, id]);
    if (id !== null) this._reportRecital(id, "activate");
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

  /** What the index should hold for `id` right now, or null if it should hold nothing. */
  _wanted(id) {
    if (id === null || id === this.activeId) return null;
    if (this.excluded.has(id)) return null;
    const tokens = this.tokens.get(id);
    return tokens && tokens.length ? tokens : null;
  }

  /**
   * Bring the index into line for these documents, in one reopen/finalize.
   *
   * `finalize()` rebuilds the context totals, and doing it twice for one cursor move is
   * pure waste — so a move, which changes two documents, costs one.
   */
  _apply(ids) {
    const changes = [];
    for (const id of new Set(ids)) {
      const wanted = this._wanted(id);
      const current = this.indexed.get(id) || null;
      if (wanted === current) continue;
      changes.push({ id, current, wanted });
    }
    if (changes.length === 0) return;

    this.index.reopen();
    for (const { current } of changes) if (current) this.index.removeFileTokens(current);
    for (const { id, wanted } of changes) {
      if (wanted) {
        this.index.addFileTokens(wanted);
        this.indexed.set(id, wanted);
      } else {
        this.indexed.delete(id);
      }
    }
    this.index.finalize();
  }

  /**
   * Say what this document's recital rate is, the way `lexindex-lsp` says it to the log.
   *
   * Only when there is something to say: a document shorter than the context is scored on
   * no positions at all, and `recitalRate` answers 0 for it. Reporting that 0 would be
   * reporting the tool as useless on the strength of a four-token file.
   */
  _reportRecital(id, reason) {
    if (!this.onRecital) return;
    const tokens = this.tokens.get(id);
    if (!tokens || tokens.length <= 4) return;
    const rate = this.index.recitalRate(tokens);
    this.onRecital({ id, rate, band: recitalBand(rate), reason });
  }
}
