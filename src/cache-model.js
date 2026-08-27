/**
 * The buffer cache: a second, tiny n-gram model over the tokens above the cursor.
 *
 * A file you are editing repeats itself far more than the repo does, and it repeats
 * things the repo has never seen — the local variable you named forty seconds ago, the
 * helper you are part-way through writing. The cache is what makes a name predictable the
 * *second* time it is typed, with no training of any kind.
 *
 * Measured, this is not the half that always carries the mechanism. On a repo that
 * repeats itself heavily the repo index dominates and the cache adds little; below about
 * 40% context reuse it inverts, the repo index alone becomes statistically NULL against
 * an ordinary word list, and only the blend wins. Neither arm is the tool. The blend is.
 *
 * Order 3 rather than the index's 5: there is not enough text above a cursor to estimate
 * a longer context, and asking for one just returns nothing.
 */

const SEP = " ";

export class CacheModel {
  constructor(order = 3) {
    this.order = order;
    this.tabs = [];
    for (let i = 0; i < order; i++) this.tabs.push(new Map());
    this.tokens = [];
    this.n = 0;
    this._uni = null;
  }

  static fromTokens(tokens, order = 3) {
    const m = new CacheModel(order);
    m.add(tokens);
    return m;
  }

  /** Append tokens. Incremental, so extending a buffer does not rebuild it. */
  add(tokens) {
    const base = this.tokens.length;
    for (const t of tokens) this.tokens.push(t);
    const s = this.tokens;

    for (let t = base; t < s.length; t++) {
      const w = s[t];
      for (let L = 0; L < this.order; L++) {
        if (t < L) continue;
        const ctx = L === 0 ? "" : s.slice(t - L, t).join(SEP);
        let counts = this.tabs[L].get(ctx);
        if (!counts) {
          counts = new Map();
          this.tabs[L].set(ctx, counts);
        }
        counts.set(w, (counts.get(w) || 0) + 1);
      }
    }

    this.n = s.length;
    this._uni = null;
  }

  _unigram() {
    if (this._uni === null) {
      const uni = this.tabs[0].get("") || new Map();
      let total = 0;
      for (const v of uni.values()) total += v;
      total = total || 1;
      const lam = total / (total + Math.max(uni.size, 1));
      this._uni = [uni, total, lam, new Set(uni.keys())];
    }
    return this._uni;
  }

  /** Every distinct token seen in the buffer. */
  vocab() {
    return this._unigram()[3];
  }

  /**
   * Score only the tokens in `candidates`. The cache never proposes candidates on its
   * own — it re-weights a set the caller already has, which keeps a one-off typo in the
   * buffer from outranking the repo's real vocabulary.
   */
  predict(prev, candidates) {
    if (this.n === 0) return new Map();

    const weights = [];
    let residual = 1.0;
    for (let L = this.order - 1; L >= 1; L--) {
      if (prev.length < L) continue;
      const ctx = prev.slice(prev.length - L).join(SEP);
      const counts = this.tabs[L].get(ctx);
      if (!counts) continue;
      let total = 0;
      for (const v of counts.values()) total += v;
      const lam = total / (total + counts.size); // Witten-Bell again
      weights.push([counts, residual * lam, total]);
      residual *= 1 - lam;
    }

    const [uni, uniTotal, lamU] = this._unigram();
    const out = new Map();
    for (const w of candidates) {
      const c = uni.get(w) || 0;
      if (c) out.set(w, (residual * lamU * c) / uniTotal);
    }
    for (const [counts, coef, total] of weights) {
      for (const [w, c] of counts) {
        if (candidates.has(w)) out.set(w, (out.get(w) || 0) + (coef * c) / total);
      }
    }
    return out;
  }
}
