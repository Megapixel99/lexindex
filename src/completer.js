/**
 * The blend, and the seven things it deliberately does not do.
 *
 * score = beta * P_cache + (1 - beta) * P_repo,  beta = 0.5, fixed.
 *
 * Every one of the following was tried in the research this derives from, measured, and
 * REJECTED. They are absent on purpose, and re-adding one without re-running the
 * measurement would be undoing a result:
 *
 *   - confidence gating (switch arms by certainty) — "dominated on both axes", three times
 *   - within-document retrieval instead of a cache — lost three times
 *   - recency decay on cache counts — "a clean negative; aggressive decay actively hurts"
 *   - right-context / suffix conditioning — the default never moved
 *   - degeneracy suppression — filtering repetition removes the BEST suggestions
 *     (0.352 exact vs 0.122 overall)
 *   - whole-line or multi-token generation — right about 1 in 10 mid-line, never past
 *     ~10 tokens
 *   - a bundled pretrained corpus — 57x the corpus was worth +0.000 in the configuration
 *     a user actually runs
 *
 * The last one is the load-bearing product decision: THE ONLY CORPUS THAT PAYS IS THE ONE
 * ALREADY ON THE USER'S DISK.
 */

import { CacheModel } from "./cache-model.js";
import { splitAtCursor } from "./lex.js";

/** Cap on how many repo candidates get re-weighted, so a huge context stays fast. */
const PRUNE = 500;

export class Completer {
  /**
   * @param {import("./count-model.js").CountModel} index a finalized repo index
   * @param {{cacheBeta?: number}} [options] cacheBeta 0 = repo only, 1 = buffer only
   */
  constructor(index, { cacheBeta = 0.5 } = {}) {
    this.index = index;
    this.cacheBeta = cacheBeta;
    this.cache = null;
  }

  /**
   * Set the tokens above the cursor. Extending the previous buffer reuses the existing
   * cache instead of rebuilding it, which is what keeps per-keystroke cost flat.
   */
  setBuffer(tokens) {
    if (this.cacheBeta <= 0 || !tokens.length) {
      this.cache = null;
      return;
    }
    const c = this.cache;
    if (c) {
      const held = c.tokens.length;
      if (held <= tokens.length) {
        let same = true;
        for (let i = 0; i < held; i++) {
          if (c.tokens[i] !== tokens[i]) {
            same = false;
            break;
          }
        }
        if (same) {
          if (held < tokens.length) c.add(tokens.slice(held));
          return;
        }
      }
    }
    this.cache = CacheModel.fromTokens(tokens);
  }

  /**
   * Rank candidates for the token after `prev`.
   * @param {string[]} prev completed tokens before the cursor
   * @param {{k?: number, prefix?: string|null}} [options]
   * @returns {string[]} up to k tokens, best first
   */
  suggest(prev, { k = 5, prefix = null } = {}) {
    let repo = this.index.predict(prev);

    let local = new Set();
    if (this.cache) {
      local = this.cache.vocab();
      if (prefix) {
        const filtered = new Set();
        for (const w of local) if (w.startsWith(prefix)) filtered.add(w);
        local = filtered;
      }
    }

    if (repo.size > PRUNE) {
      const arr = [...repo.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0))
        .slice(0, PRUNE);
      repo = new Map(arr);
    }

    let cacheP = new Map();
    if (this.cache) {
      const candidates = new Set(repo.keys());
      for (const w of local) candidates.add(w);
      cacheP = this.cache.predict(prev, candidates);
      // A name that exists only in this buffer still deserves to be ranked.
      for (const w of local) if (!repo.has(w)) repo.set(w, 0.0);
    }

    const beta = cacheP.size ? this.cacheBeta : 0.0;

    let items = [...repo.entries()];
    if (prefix) items = items.filter(([w]) => w.startsWith(prefix));

    const scored = items.map(([w, p]) => [beta * (cacheP.get(w) || 0) + (1 - beta) * p, w]);
    // Ties break on the token, deterministically, so the same input always gives the same
    // list — a completion UI that reorders on redraw is worse than a wrong one.
    scored.sort((x, y) => y[0] - x[0] || (x[1] < y[1] ? 1 : x[1] > y[1] ? -1 : 0));
    return scored.slice(0, k).map(([, w]) => w);
  }

  /**
   * The ergonomic entry point: hand it the text above the cursor and get tokens back.
   * Handles lexing, partial-identifier detection and buffer bookkeeping.
   */
  complete(textBeforeCursor, { k = 5 } = {}) {
    const { prev, prefix } = splitAtCursor(textBeforeCursor);
    this.setBuffer(prev);
    return this.suggest(prev, { k, prefix });
  }

  /**
   * Score a supplied candidate set, using the same blend as `suggest`. Returns
   * Map<candidate, score>. Candidates the index has never seen score 0 from the repo
   * side and are still ranked by the cache, which is how a name you typed a minute ago
   * outranks one the repo has never used.
   */
  scoreCandidates(prev, candidates) {
    const names = [...candidates];
    const repo = this.index.predict(prev);
    const wanted = new Set(names);

    let cacheP = new Map();
    if (this.cache) cacheP = this.cache.predict(prev, wanted);

    const beta = cacheP.size ? this.cacheBeta : 0.0;
    const out = new Map();
    for (const w of names) {
      out.set(w, beta * (cacheP.get(w) || 0) + (1 - beta) * (repo.get(w) || 0));
    }
    return out;
  }

  /**
   * Re-order somebody else's candidate list — a language server's, a framework's, any
   * list that already knows what is legal here — by this index's statistics.
   *
   * This is the measured use. A TypeScript language server knows what is in scope but
   * ranks by static category buckets with no frequency signal; over three TypeScript
   * corpora and 1,596 positions, re-ranking its own list went from 47.7% top-1 to 89.4%,
   * and 64.5% for a VS Code-like recency baseline.
   *
   * READ THE README BEFORE QUOTING THAT. About half the win is keyword positions, the
   * `sortText` tie rate is ~89% so the incumbent ordering is largely alphabetical, and
   * against a plain frequency table on real identifiers the advantage only holds on repos
   * whose recital rate is above roughly 60%.
   *
   * Nothing is added and nothing is dropped: the returned array is a permutation of the
   * input. Deciding what is legal at a cursor is the language server's job and this does
   * not second-guess it.
   *
   * @param {Iterable<string>} candidates names from the other engine
   * @param {string} textBeforeCursor
   * @returns {string[]} the same names, reordered
   */
  rerank(candidates, textBeforeCursor) {
    const names = [...candidates];
    if (names.length < 2) return names;
    const { prev } = splitAtCursor(textBeforeCursor);
    this.setBuffer(prev);
    const scores = this.scoreCandidates(prev, names);
    // Ties break exactly as `suggest` breaks them, so the two orderings never disagree
    // about the same candidates. The direction looks odd on its own and is inherited
    // from the reference implementation, where it is pinned by a parity check.
    return names.sort(
      (a, b) => (scores.get(b) - scores.get(a)) || (a < b ? 1 : a > b ? -1 : 0)
    );
  }
}
