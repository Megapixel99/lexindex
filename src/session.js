/**
 * A cursor that stays put between keystrokes.
 *
 * `Completer.complete(text)` and `.rerank(list, text)` take the whole text above the
 * cursor, so they lex the whole thing again on every call. That is the shape an editor
 * reaches for, and it costs the file rather than the edit: on a 175 KB buffer one
 * `complete()` measured 5.43 ms against 0.16 ms for the ranking underneath it, and one
 * `rerank()` 2.99 ms. The work is nearly all re-lexing text that did not change.
 *
 * A session keeps the tokens and the buffer cache between calls and re-lexes only from
 * the last settled point in the text, so typing another character costs that character.
 * The methods take the same arguments and return the same things as the Completer's, so
 * it is a drop-in swap:
 *
 *   const session = completer.session();
 *   session.complete(textBeforeCursor);            // was completer.complete(...)
 *   session.rerank(candidates, textBeforeCursor);  // was completer.rerank(...)
 *
 * IT IS THE SAME ANSWER. Not an approximation of one, and not a faster ranking that
 * drifts as the file grows: the suite types a real file in character by character and
 * asserts the session's list is identical to a freshly built Completer's at every single
 * cursor. If that ever stops being true the session is a bug, not a trade-off.
 *
 * What makes it safe is a property of the lexer rather than any bookkeeping here. A token
 * is an identifier, a number, or one non-word character, so no token spans a non-word
 * character; any position whose preceding character is a non-word character therefore has
 * everything before it already settled, whatever is typed next. The session re-lexes from
 * the latest such position and reuses the rest.
 */

import { CacheModel } from "./cache-model.js";
import { lex, isWord, splitAtCursor, trailingWordStart } from "./lex.js";

export class BufferSession {
  /** @param {import("./completer.js").Completer} completer */
  constructor(completer) {
    this.completer = completer;
    /** The completed tokens above the cursor: exactly `splitAtCursor(text).prev`. */
    this.tokens = [];
    /** The partial identifier being typed, if any. */
    this.prefix = null;
    this.cache = null;

    this.text = null;
    // text.slice(0, stableOffset) lexes to exactly the first stableCount tokens, and
    // stableOffset is settled: no later keystroke can change how that part tokenizes.
    this.stableOffset = 0;
    this.stableCount = 0;
  }

  /**
   * Point the session at `textBeforeCursor`, reusing whatever survived the edit.
   * Called for you by `complete`, `completeScored` and `rerank`.
   * @returns {{prev: string[], prefix: string|null}}
   */
  update(textBeforeCursor) {
    const extended =
      this.text !== null &&
      textBeforeCursor.length >= this.text.length &&
      textBeforeCursor.startsWith(this.text);

    if (extended) this._extend(textBeforeCursor);
    else this._rebuild(textBeforeCursor);

    this.text = textBeforeCursor;
    this.completer.cache = this.cache;
    return { prev: this.tokens, prefix: this.prefix };
  }

  /** The cursor moved somewhere unrelated, or this is the first call: start over. */
  _rebuild(text) {
    const { prev, prefix } = splitAtCursor(text);
    this.tokens = prev;
    this.prefix = prefix;
    this.cache =
      this.completer.cacheBeta > 0 && prev.length ? CacheModel.fromTokens(prev) : null;
    this._mark(text);
  }

  /** Text was typed onto the end: re-lex from the last settled point and no further. */
  _extend(text) {
    const tail = text.slice(this.stableOffset);
    const tailTokens = lex(tail);

    let prefix = null;
    let count = tailTokens.length;
    if (count > 0) {
      const last = tailTokens[count - 1];
      // splitAtCursor's rule, applied to the tail: the same answer, because a token
      // cannot begin before stableOffset and end at the cursor.
      if (tail.endsWith(last) && isWord(last)) {
        prefix = last;
        count -= 1;
      }
    }

    this.tokens.length = this.stableCount;
    for (let i = 0; i < count; i++) this.tokens.push(tailTokens[i]);
    this.prefix = prefix;

    if (this.completer.cacheBeta > 0) {
      if (!this.cache) {
        if (this.tokens.length) this.cache = CacheModel.fromTokens(this.tokens);
      } else {
        this.cache.truncate(this.stableCount);
        if (count > 0) this.cache.add(this.tokens.slice(this.stableCount));
      }
    } else {
      this.cache = null;
    }

    this._mark(text);
  }

  /**
   * Move the settled point up to the run of word characters the cursor is sitting in.
   *
   * The run is re-lexed on the next keystroke because that is exactly the text a
   * keystroke can change — `12` becoming `123` is one token, not two, and a checkpoint
   * placed after `12` would split it. The run can hold more than one token (`12ab`), so
   * what it holds is counted rather than assumed.
   */
  _mark(text) {
    const p = trailingWordStart(text);
    const all = this.tokens.length + (this.prefix === null ? 0 : 1);
    const inRun = p === text.length ? 0 : lex(text.slice(p)).length;
    this.stableOffset = p;
    this.stableCount = all - inRun;
    if (this.stableCount < 0) this.stableCount = 0;
  }

  /** As `Completer.complete`, reusing the buffer instead of re-reading it. */
  complete(textBeforeCursor, { k = 5 } = {}) {
    this.update(textBeforeCursor);
    return this.completer.suggest(this.tokens, { k, prefix: this.prefix });
  }

  /** As `Completer.completeScored`. */
  completeScored(textBeforeCursor, { k = 5 } = {}) {
    this.update(textBeforeCursor);
    return this.completer.suggestScored(this.tokens, { k, prefix: this.prefix });
  }

  /** As `Completer.rerank`: a permutation of `candidates`, nothing added or dropped. */
  rerank(candidates, textBeforeCursor) {
    const names = [...candidates];
    if (names.length < 2) return names;
    this.update(textBeforeCursor);
    return this.completer.rerankTokens(names, this.tokens);
  }
}
