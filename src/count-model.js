/**
 * The repo index: interpolated n-gram counts over every token in the tree.
 *
 * Witten-Bell interpolation, which is the part that makes counting work at all. For each
 * context length L from longest to shortest, the weight given to that order is
 *
 *     lambda = N / (N + T)
 *
 * where N is how many times the context was seen and T is how many DISTINCT tokens
 * followed it. A context seen many times with few distinct continuations is trusted; one
 * seen many times with many different continuations is not, and the residual mass falls
 * through to the shorter context. There is no tuned constant anywhere in it.
 *
 * The vocabulary is unbounded and the keys are the token strings themselves. Nothing is
 * embedded, hashed or truncated, so a name that appears once in your repo is predictable
 * the second time it appears — which is the whole reason a per-repo index beats a
 * pretrained one.
 *
 * WHAT THIS IS NOT. It has no idea what a variable is, whether a member exists on an
 * object, or what is in scope. Where a language server runs, the language server is
 * better at the questions it can answer. See the README's Limits.
 */

import { isWord } from "./lex.js";

const SEP = " ";
const TOP_UNIGRAM_CANDIDATES = 200;

export class CountModel {
  /** @param {number} order highest context length + 1. Order 5 means contexts of 0..4. */
  constructor(order = 5) {
    this.order = order;
    /** tabs[L] : Map<contextString, Map<token, count>> */
    this.tabs = [];
    for (let i = 0; i < order; i++) this.tabs.push(new Map());
    this.nTokens = 0;
    this.nFiles = 0;
    this.finalized = false;
  }

  /**
   * Add one file's tokens. Cheap to call many times; call finalize() when done.
   *
   * The context keys are built by rolling one token onto the front of the previous
   * order's key rather than by `slice().join()` per order, which is the same string with
   * one concatenation instead of an array allocation and a join. Counting dominates build
   * time by an order of magnitude over lexing, so this loop is the build.
   */
  addFileTokens(tokens) {
    if (this.finalized) throw new Error("CountModel: cannot add after finalize()");

    const uni = this._unigrams();
    for (const w of tokens) uni.set(w, (uni.get(w) || 0) + 1);

    const n = tokens.length;
    for (let t = 1; t < n; t++) {
      const w = tokens[t];
      const maxL = Math.min(this.order - 1, t);
      let ctx = "";
      for (let L = 1; L <= maxL; L++) {
        ctx = L === 1 ? tokens[t - 1] : tokens[t - L] + SEP + ctx;
        const tab = this.tabs[L];
        let counts = tab.get(ctx);
        if (!counts) {
          counts = new Map();
          tab.set(ctx, counts);
        }
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }

    this.nTokens += n;
    this.nFiles += 1;
  }

  /**
   * The exact inverse of `addFileTokens`: subtract one file's contribution.
   *
   * This is what makes the index maintainable in a long-lived process. An editor that
   * rebuilt from scratch on every save would pay the whole build cost per keystroke-ish
   * event; removing one file's counts and adding the new ones costs a few milliseconds.
   *
   * Counts that reach zero are DELETED rather than left at 0. A context left behind with
   * an empty count map would still answer `recitalRate` — the index would go on claiming
   * to have seen text that has been deleted, which is the one number this project asks
   * people to trust.
   */
  removeFileTokens(tokens) {
    if (this.finalized) throw new Error("CountModel: cannot remove after finalize()");

    const uni = this._unigrams();
    for (const w of tokens) {
      const c = uni.get(w);
      if (c === undefined) continue;
      if (c <= 1) uni.delete(w);
      else uni.set(w, c - 1);
    }

    const n = tokens.length;
    for (let t = 1; t < n; t++) {
      const w = tokens[t];
      const maxL = Math.min(this.order - 1, t);
      let ctx = "";
      for (let L = 1; L <= maxL; L++) {
        ctx = L === 1 ? tokens[t - 1] : tokens[t - L] + SEP + ctx;
        const tab = this.tabs[L];
        const counts = tab.get(ctx);
        if (!counts) continue;
        const c = counts.get(w);
        if (c === undefined) continue;
        if (c <= 1) {
          counts.delete(w);
          if (counts.size === 0) tab.delete(ctx);
        } else {
          counts.set(w, c - 1);
        }
      }
    }

    this.nTokens -= n;
    this.nFiles -= 1;
    if (this.nFiles < 0) this.nFiles = 0;
    if (this.nTokens < 0) this.nTokens = 0;
  }

  /**
   * Swap one file's contribution for another's and re-finalize, in one call.
   *
   * `replaceFileTokens(old, next)` is an edit, `replaceFileTokens(null, next)` is a new
   * file, and `replaceFileTokens(old, null)` is a deletion. This is the whole API a file
   * watcher or a language server needs.
   */
  replaceFileTokens(oldTokens, newTokens) {
    this.reopen();
    if (oldTokens && oldTokens.length) this.removeFileTokens(oldTokens);
    if (newTokens && newTokens.length) this.addFileTokens(newTokens);
    return this.finalize();
  }

  /** Undo `finalize()` so the index can be added to or subtracted from again. */
  reopen() {
    this.finalized = false;
    return this;
  }

  _unigrams() {
    let uni = this.tabs[0].get("");
    if (!uni) {
      uni = new Map();
      this.tabs[0].set("", uni);
    }
    return uni;
  }

  /** Precompute what prediction needs. Must be called before predict(). */
  finalize() {
    this.uni = this.tabs[0].get("") || new Map();
    this.uniTotal = 0;
    for (const v of this.uni.values()) this.uniTotal += v;

    const types = this.uni.size;
    this.lamUni = this.uniTotal / (this.uniTotal + types);

    const sorted = [...this.uni.entries()].sort((a, b) => b[1] - a[1]).map((e) => e[0]);
    // A small always-considered candidate set, so a context nobody has seen still returns
    // something plausible rather than nothing.
    this.topUnigrams = sorted.slice(0, TOP_UNIGRAM_CANDIDATES);
    this.wordsByFrequency = sorted.filter(isWord);

    // Context totals are memoized on first use rather than swept eagerly. A prediction
    // touches at most `order - 1` contexts, so summing them on demand costs nothing
    // measurable, while the eager sweep was proportional to the whole table — and it ran
    // again on every finalize(), which is what an incremental update calls per file save.
    // Dropping the memo here is also the cache invalidation: counts that just changed
    // cannot leave a stale total behind.
    this.ctxTotals = [];
    for (let L = 0; L < this.order; L++) this.ctxTotals.push(new Map());
    this.ctxTotals[0].set("", this.uniTotal);

    this.finalized = true;
    return this;
  }

  /** How many times context `ctx` was seen at order L. Summed once, then remembered. */
  _ctxTotal(L, ctx, counts) {
    const memo = this.ctxTotals[L];
    let n = memo.get(ctx);
    if (n === undefined) {
      n = 0;
      for (const v of counts.values()) n += v;
      memo.set(ctx, n);
    }
    return n;
  }

  /**
   * Probability-ish score for every candidate token given the preceding tokens.
   * Returns Map<token, score>. Scores are comparable to each other, and that is all they
   * are promised to be.
   */
  predict(prev) {
    if (!this.finalized) throw new Error("CountModel: call finalize() before predict()");

    const weights = [];
    let residual = 1.0;

    for (let L = this.order - 1; L >= 1; L--) {
      if (prev.length < L) continue;
      const ctx = prev.slice(prev.length - L).join(SEP);
      const counts = this.tabs[L].get(ctx);
      if (!counts) continue;
      const n = this._ctxTotal(L, ctx, counts);
      const lam = n / (n + counts.size); // Witten-Bell
      weights.push([counts, residual * lam, n]);
      residual *= 1 - lam;
    }

    const wUni = (residual * this.lamUni) / Math.max(this.uniTotal, 1);
    const wZero = (residual * (1 - this.lamUni)) / Math.max(this.uni.size, 1);

    const scores = new Map();
    for (const [counts, coef, n] of weights) {
      for (const [w, c] of counts) scores.set(w, (scores.get(w) || 0) + (coef * c) / n);
    }

    const candidates = new Set(scores.keys());
    for (const w of this.topUnigrams) candidates.add(w);

    const out = new Map();
    for (const w of candidates) {
      out.set(w, (scores.get(w) || 0) + wUni * (this.uni.get(w) || 0) + wZero);
    }
    return out;
  }

  /**
   * How much does this index repeat itself? The share of positions whose 4-token context
   * has been seen before.
   *
   * This is the honest predictor of whether the tool is worth anything on a given repo.
   * Measured across eight corpora it ran from 72.9% (a tree of near-identical rule files)
   * down to 13.5% — and at 13.5% the advantage over an ordinary word list was NULL.
   * Report it; do not bury it.
   */
  recitalRate(tokens, contextLength = 4) {
    if (!this.finalized) throw new Error("CountModel: call finalize() before recitalRate()");
    const L = Math.min(contextLength, this.order - 1);
    let seen = 0;
    let total = 0;
    for (let t = L; t < tokens.length; t++) {
      total++;
      const ctx = tokens.slice(t - L, t).join(SEP);
      if (this.tabs[L].has(ctx)) seen++;
    }
    return total ? seen / total : 0;
  }
}
