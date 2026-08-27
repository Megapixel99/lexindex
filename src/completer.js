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
 *   - a bundled pretrained corpus — 57x the corpus was worth +0.000 at a warm buffer and
 *     +0.016 once the buffer empties, a poor trade either way
 *
 * The last one is the load-bearing product decision: THE ONLY CORPUS THAT PAYS IS THE ONE
 * ALREADY ON THE USER'S DISK. Two caveats on that figure, since it is the one most likely
 * to be quoted: +0.000 is the warm-buffer case and the same measurement gives +0.016 once
 * the buffer empties, with its own write-up calling the thesis bounded rather than
 * absolute; and it was taken with a small transformer present, which this package does not
 * have, so it is evidence about the trade rather than a number measured on this
 * architecture.
 */

import { CacheModel } from "./cache-model.js";
import { BufferSession } from "./session.js";
import { splitAtCursor } from "./lex.js";

/** Cap on how many repo candidates get re-weighted, so a huge context stays fast. */
const PRUNE = 500;

/**
 * The best `k` by `cmp`, without sorting the rest.
 *
 * Ranking five suggestions out of the ~1,700 candidates a live buffer produces spent most
 * of its time ordering the 1,695 nobody was going to see. The comparator is a total order
 * here — candidates are Map keys, so no two entries share a token, and score-then-token
 * separates every pair — which is what makes selecting the top k give byte-identical
 * output to sorting and slicing, rather than merely equivalent output.
 */
function topK(items, k, cmp) {
  if (k <= 0) return [];
  if (k >= items.length) return items.sort(cmp);
  const best = [];
  for (const it of items) {
    if (best.length === k && cmp(it, best[k - 1]) >= 0) continue;
    let i = best.length < k ? best.length : k - 1;
    while (i > 0 && cmp(it, best[i - 1]) < 0) {
      best[i] = best[i - 1];
      i--;
    }
    best[i] = it;
  }
  return best;
}

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
    return this.suggestScored(prev, { k, prefix }).map((e) => e.token);
  }

  /**
   * `suggest`, with the score that produced each ranking.
   *
   * The scores are comparable to each other within one call and are nothing more than
   * that: they are not calibrated probabilities, and they do not mean the same thing
   * between two different cursors. Read them to show a bar, to merge this ranking with
   * another engine's, or to break your own ties — not as a confidence to cut on.
   * Gating on confidence is one of the seven things listed above: it was measured three
   * separate times and was "dominated on both axes" every time.
   *
   * @returns {{token: string, score: number}[]} up to k entries, best first
   */
  suggestScored(prev, { k = 5, prefix = null } = {}) {
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
    const best = topK(scored, k, (x, y) => y[0] - x[0] || (x[1] < y[1] ? 1 : x[1] > y[1] ? -1 : 0));
    return best.map(([score, token]) => ({ token, score }));
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
   * A cursor that keeps its buffer between keystrokes.
   *
   * `complete` and `rerank` take the whole text above the cursor and so re-lex all of it
   * every call, which costs the file rather than the edit. A session takes the same
   * arguments, returns the same answers, and re-lexes only what changed. If you are
   * calling this per keystroke in an editor, call it on a session.
   *
   * @returns {BufferSession}
   */
  session() {
    return new BufferSession(this);
  }

  /** `complete`, returning `{token, score}` entries. See `suggestScored` on the scores. */
  completeScored(textBeforeCursor, { k = 5 } = {}) {
    const { prev, prefix } = splitAtCursor(textBeforeCursor);
    this.setBuffer(prev);
    return this.suggestScored(prev, { k, prefix });
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
    return this.rerankTokens(names, prev);
  }

  /**
   * `rerank` for a caller that already holds the tokens — a language server that lexed
   * the buffer once, or the measurement harness.
   *
   * This is the whole of `rerank` after the lexing, so anything measured through here is
   * measuring the shipped path rather than a copy of it that might drift from it.
   *
   * @param {Iterable<string>} candidates names from the other engine
   * @param {string[]} prev the completed tokens before the cursor
   * @returns {string[]} the same names, reordered
   */
  rerankTokens(candidates, prev) {
    const names = [...candidates];
    if (names.length < 2) return names;
    const scores = this.scoreCandidates(prev, names);
    // Ties break exactly as `suggest` breaks them, so the two orderings never disagree
    // about the same candidates. The direction looks odd on its own and is inherited
    // from the reference implementation, where it is pinned by a parity check.
    return names.sort(
      (a, b) => (scores.get(b) - scores.get(a)) || (a < b ? 1 : a > b ? -1 : 0)
    );
  }
}
