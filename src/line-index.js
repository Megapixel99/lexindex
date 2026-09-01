/**
 * Whole lines, retrieved rather than generated.
 *
 * The completer predicts one token. Asked for a line, the obvious move is to run it
 * repeatedly on its own output, and that does not work: measured over 883 positions on a
 * corpus of seven sibling services, greedy top-1 extension is exact 43.0% of the time at
 * one token, 19.7% at three, and **3.1% at ten** — about the length of a line. The decay
 * is close to geometric because an order-5 model conditions on four tokens, so after a
 * few self-generated steps the context is mostly its own output. No weighting fixes that.
 *
 * So this does not generate. It remembers: for each four-token context, the lines that
 * actually followed it somewhere in the corpus, and hands back the most frequent one with
 * the file and line it came from. On the same corpus that is exact 24.7% of the time when
 * it answers, and it answers on 53.8% of line positions.
 *
 * **The abstention is the feature, not a shortfall.** A line predictor that always
 * produces something produces plausible code that was never written, which is the one
 * thing an index over your own repository should never do. When the context has not been
 * seen, this returns null and the caller says so.
 *
 * **Provenance for the same reason.** Every hit carries `file` and `line`, so a suggestion
 * is checkable rather than merely convincing: it is a pointer to code that exists.
 *
 * What it is good at is what a repository repeats — in the corpus above the exact hits
 * were almost all declarative boilerplate (`schema: { type: 'string' },`, `in: 'query',`).
 * Worth knowing rather than hiding: a high hit rate here means "you have written this
 * before", which is a fact about the corpus and not always a compliment to it.
 */

import { lex } from "./lex.js";

/** Tokens of context used as the key. Four, to match the completer's order-5 model. */
export const LINE_CONTEXT = 4;

/**
 * How many DISTINCT following lines are kept per context.
 *
 * Unbounded, a context that precedes a long run of unique lines stores every one of them
 * and the table grows with the corpus rather than with its repetition. The cap costs only
 * the tail of a distribution whose head is the answer: the entry returned is the most
 * frequent, and a line that never repeats was never going to be it.
 */
export const MAX_PER_CONTEXT = 16;

/** The trimmed text of every non-blank line, with its 1-based number. */
function linesOf(text) {
  const out = [];
  const raw = text.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const trimmed = raw[i].trim();
    if (trimmed.length === 0) continue;
    const toks = lex(trimmed);
    if (toks.length === 0) continue;
    out.push({ text: trimmed, tokens: toks, line: i + 1 });
  }
  return out;
}

/**
 * Context -> the lines observed after it, best first.
 *
 * Build with `addFile` per file, then `finalize`. `lookup` answers or returns null.
 */
export class LineIndex {
  constructor({ context = LINE_CONTEXT, maxPerContext = MAX_PER_CONTEXT } = {}) {
    this.context = context;
    this.maxPerContext = maxPerContext;
    /** @type {Map<string, Map<string, {count: number, file: string, line: number}>>} */
    this.table = new Map();
    this.nFiles = 0;
    this.nLines = 0;
    this.finalized = false;
  }

  /**
   * Index one file's lines.
   *
   * The key is the last `context` tokens BEFORE a line begins, which is what an editor
   * has at the moment it would offer the line — the tail of what is already written,
   * spanning the newline, because a line break is not a token and the model never saw one.
   */
  addFile(file, text) {
    const lines = linesOf(text);
    if (lines.length === 0) return;
    this.nFiles++;
    let before = [];
    for (const l of lines) {
      if (before.length >= this.context) {
        const key = before.slice(-this.context).join(" ");
        let seen = this.table.get(key);
        if (!seen) this.table.set(key, (seen = new Map()));
        const prior = seen.get(l.text);
        if (prior) prior.count++;
        else if (seen.size < this.maxPerContext) {
          seen.set(l.text, { count: 1, file, line: l.line });
        }
        this.nLines++;
      }
      before = before.concat(l.tokens);
      // Only the tail is ever read; keeping the whole file would make this O(tokens^2).
      if (before.length > this.context * 4) before = before.slice(-this.context * 4);
    }
  }

  /** Order each context's candidates by frequency, so `lookup` is a read. */
  finalize() {
    for (const [key, seen] of this.table) {
      const sorted = [...seen.entries()].sort((a, b) => b[1].count - a[1].count);
      this.table.set(key, new Map(sorted));
    }
    this.finalized = true;
    return this;
  }

  /**
   * The line most often seen after this text, or null when the context is new.
   *
   * Returning null is the honest answer and the caller must say so rather than fall back
   * to something invented; `total` and `count` are reported so a reader can weigh a hit
   * seen once against one seen forty times.
   *
   * @param {string} textBefore everything above the cursor
   * @returns {{text: string, file: string, line: number, count: number, total: number, alternatives: number}|null}
   */
  lookup(textBefore) {
    const toks = lex(textBefore);
    if (toks.length < this.context) return null;
    const seen = this.table.get(toks.slice(-this.context).join(" "));
    if (!seen || seen.size === 0) return null;
    let best = null;
    let total = 0;
    for (const [text, meta] of seen) {
      total += meta.count;
      if (!best) best = { text, ...meta };
    }
    return { ...best, total, alternatives: seen.size };
  }

  /** What the table holds, for `--stats`. */
  stats() {
    return { contexts: this.table.size, files: this.nFiles, lines: this.nLines };
  }
}
