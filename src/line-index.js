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
 * So this does not generate. It remembers: for each context, the lines that actually
 * followed it, and hands back the most likely one with the file and line it came from.
 *
 * **The abstention is the feature, not a shortfall.** A line predictor that always
 * produces something produces plausible code that was never written, which is the one
 * thing an index over your own repository should never do. Here abstention is a
 * *confidence* judgement rather than an accident of a missing table entry — see
 * `DEFAULT_MIN_CONFIDENCE`.
 *
 * **Provenance for the same reason.** Every hit carries `file` and `line`, so a suggestion
 * is checkable rather than merely convincing: it is a pointer to code that exists.
 *
 * ## How the ranking was chosen
 *
 * Measured on a corpus anybody can clone, because a number whose corpus cannot be fetched
 * cannot be checked: nine sibling middleware packages from the express family indexed and
 * two disjoint ones predicted (2,955 positions), then the halves swapped (5,134). Both arms
 * run this class — the earlier behaviour is exactly `{widths: [4]}` with no local model and
 * no floor — and coverage is held fixed, because "answers more often" is not "is right more
 * often". At the old arm's own coverage this ranking is exact 30.1% and 33.6% against 15.9%
 * and 19.3%, and agrees with about 16 points more of the true line's prefix.
 *
 * Coverage is what a corpus decides. Here the context has never been seen at 63% of line
 * positions; on a private estate of fifteen services generated from one template that fell
 * to a quarter, and the same comparison ran +8.6 rather than +14. The more a codebase
 * repeats itself the more often this answers, and the less each answer is worth.
 *
 * `npm run measure:line -- <corpus-dir>... -- <held-out-dir>...` re-derives all of it, and
 * refuses to run when the two sides of the split overlap.
 *
 * Two things earned their place:
 *
 * 1. **Every width at once, not the longest that matches.** Backing off from a six-token
 *    context to a five- to a four- discards the evidence that the shorter contexts agreed.
 *    Summing a candidate's share across all widths, weighted by width, beats backoff.
 * 2. **The file being edited is a corpus too.** Lines above the cursor are worth 4.3 and
 *    4.0 points of overall accuracy, and lift coverage from 19% to 30% — code repeats
 *    locally far more than globally, and the buffer is the one corpus the index never has,
 *    which counts for most on a corpus that repeats itself least. They are
 *    weighted *equally* with the repository: boosting them above it was measured at
 *    1 > 2 > 3 > 6 monotonically, so there is no knob here.
 *
 * Three things did not, recorded so they are not retried:
 *
 * - **Templating identifiers into holes** (`const ID = NUM;`) lifts coverage to 97% and
 *   costs 6.2 points of overall accuracy. Contexts that match only after their names are
 *   erased are usually not the same context.
 * - **Recency weighting** on the local model changes nothing at any decay constant tried
 *   (half-lives of 20, 60 and 200 lines all landed within noise).
 * - **Matching indentation** actively hurts — 28.2% against 40.5% — and that was measured
 *   with oracle access to the true line's indent, so no cleverer estimate of it can help.
 *   A candidate's indentation is a fact about the file it came from, not the one it is
 *   going to.
 *
 * What it is good at is what a repository repeats — in the corpus above the exact hits
 * were largely declarative boilerplate (`schema: { type: 'string' },`, `in: 'query',`).
 * Worth knowing rather than hiding: a high hit rate here means "you have written this
 * before", which is a fact about the corpus and not always a compliment to it.
 */

import { lex } from "./lex.js";

/**
 * Context widths that vote, in tokens.
 *
 * Starts at the completer's own four-token window and widens: a six-token agreement is
 * strong evidence and a four-token one is ordinary evidence, and the scoring wants both
 * rather than only whichever happens to be longest.
 *
 * Narrower widths were measured and dropped. A two-token tail is usually punctuation like
 * `) ;`, which matches nearly any line ever written, so including widths 2 and 3 takes the
 * share of positions where this index can honestly say it has never seen the context from
 * 63-64% down to 26-27%. A refusal that almost never fires is not a refusal. That was the
 * whole of the argument on a private estate, where exactness moved less than a point either
 * way; on the public corpus above, dropping them also RAISES exactness (26.4% to 29.1%,
 * 26.5% to 30.2%), so the trade has no cost to weigh. Widening past six does nothing.
 */
export const LINE_WIDTHS = [4, 5, 6];

/** The width the completer's order-5 model itself conditions on; the narrowest that votes. */
export const LINE_CONTEXT = 4;

/**
 * How many DISTINCT following lines are kept per context.
 *
 * Unbounded, a context that precedes a long run of unique lines stores every one of them
 * and the table grows with the corpus rather than with its repetition. The cap costs only
 * the tail of a distribution whose head is the answer: the entry returned is the most
 * likely, and a line that never repeats was never going to be it.
 */
export const MAX_PER_CONTEXT = 16;

/**
 * How confident the best candidate must be before it is offered at all.
 *
 * `confidence` is a share of the evidence times how much evidence there is — see
 * `candidates` for the Witten-Bell factor — so 0.15 is not as low as it looks: a lone
 * sighting of a context with one continuation scores 0.5 before the share is applied.
 *
 * At 0.15 the ranking answers on 30.4% and 30.0% of positions across the two public splits
 * and is exact on 29.0% and 30.2%, which is what the plain share did at its own default.
 * The value changed because the scale did, not because the behaviour did.
 *
 * Turning it UP is what the plain share could not do. At 0.6 this answers on 4.7% of
 * positions and is exact on 62.9% and 74.9%; at 0.8, on 2.3% at 82.1% and 79.5%. A share
 * alone saturated: 37.6% of its answers sat at exactly 1.0, so even `--min-confidence 1`
 * still answered on 13.9% of positions and could not be made more exact than 42.5%.
 */
export const DEFAULT_MIN_CONFIDENCE = 0.15;

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
 * Context -> the lines observed after it, at several widths at once.
 *
 * Build with `addFile` per file, then `finalize`. `lookup` answers or returns null.
 * The same class serves as the local model: index the text above the cursor into one and
 * pass it as `local`.
 */
export class LineIndex {
  constructor({ widths = LINE_WIDTHS, maxPerContext = MAX_PER_CONTEXT } = {}) {
    this.widths = [...widths].sort((a, b) => a - b);
    this.longest = this.widths[this.widths.length - 1];
    this.maxPerContext = maxPerContext;
    /** @type {Map<number, Map<string, Map<string, {count: number, file: string, line: number}>>>} */
    this.tables = new Map(this.widths.map((w) => [w, new Map()]));
    this.nFiles = 0;
    this.nLines = 0;
    this.finalized = false;
  }

  /**
   * Index one file's lines.
   *
   * The key is the last N tokens BEFORE a line begins, which is what an editor has at the
   * moment it would offer the line — the tail of what is already written, spanning the
   * newline, because a line break is not a token and the model never saw one.
   */
  addFile(file, text) {
    const lines = linesOf(text);
    if (lines.length === 0) return this;
    this.nFiles++;
    let before = [];
    for (const l of lines) {
      for (const w of this.widths) {
        if (before.length < w) continue;
        const table = this.tables.get(w);
        const key = before.slice(-w).join(" ");
        let seen = table.get(key);
        if (!seen) table.set(key, (seen = new Map()));
        const prior = seen.get(l.text);
        if (prior) prior.count++;
        else if (seen.size < this.maxPerContext) {
          seen.set(l.text, { count: 1, file, line: l.line });
        }
      }
      if (before.length >= this.widths[0]) this.nLines++;
      before = before.concat(l.tokens);
      // Only the tail is ever read; keeping the whole file would make this O(tokens^2).
      if (before.length > this.longest * 4) before = before.slice(-this.longest * 4);
    }
    return this;
  }

  /** No per-context sorting needed — scoring reorders anyway — but keep the call honest. */
  finalize() {
    this.finalized = true;
    return this;
  }

  /**
   * Add one width's evidence for `before` into `acc`.
   *
   * A candidate contributes its share of the observations at that width, scaled by the
   * width, so a six-token agreement outweighs a two-token one without silencing it.
   */
  #vote(acc, before, weightScale) {
    for (const w of this.widths) {
      if (before.length < w) continue;
      const seen = this.tables.get(w).get(before.slice(-w).join(" "));
      if (!seen || seen.size === 0) continue;
      let total = 0;
      for (const [, m] of seen) total += m.count;
      const distinct = seen.size;
      for (const [text, m] of seen) {
        const add = weightScale * w * (m.count / total);
        const prior = acc.get(text);
        if (prior) {
          prior.score += add;
          // The evidence reported is the evidence of the context that argued hardest for
          // this line, so `support` and `distinct` describe one real context rather than
          // being maxima taken from two different widths that never agreed.
          if (add > prior.best) {
            Object.assign(prior, { best: add, support: total, distinct, count: m.count, file: m.file, line: m.line });
          }
        } else {
          acc.set(text, {
            text, score: add, best: add,
            support: total, distinct, count: m.count, file: m.file, line: m.line,
          });
        }
      }
    }
  }

  /**
   * Every candidate line for this context, best first, each with its share of the score.
   *
   * Exposed because an editor wants a list — top-3 contains the right line 44.7% of the
   * time against 35.9% for the previous top-1, so a picker is worth more than a printer.
   *
   * @param {string} textBefore everything above the cursor
   * @param {{local?: LineIndex|null}} [options] `local` is an index over the current
   *   buffer above the cursor; it votes with the same weight as the corpus.
   */
  candidates(textBefore, { local = null } = {}) {
    const toks = lex(textBefore);
    if (toks.length < this.widths[0]) return [];
    const acc = new Map();
    this.#vote(acc, toks, 1);
    if (local) local.#vote(acc, toks, 1);
    const out = [...acc.values()].sort((a, b) => b.score - a.score);
    const sum = out.reduce((s, c) => s + c.score, 0);
    for (const c of out) {
      const share = sum > 0 ? c.score / sum : 0;
      // Witten-Bell, the same `N / (N + T)` the count model uses one directory over: times
      // seen over distinct continuations. A share alone answers "what fraction of the
      // evidence points here" and says nothing about how much evidence there is, so a
      // context seen exactly once scored a flat 1.0 — maximum confidence from one sighting.
      c.reliability = c.support / (c.support + c.distinct);
      c.confidence = share * c.reliability;
    }
    return out;
  }

  /**
   * The most likely line after this text, or null when nothing clears the bar.
   *
   * Returning null is the honest answer and the caller must say so rather than fall back
   * to something invented. `confidence` is the share of the total score this candidate
   * holds, so a reader can weigh a lone sighting against a unanimous one.
   *
   * @param {string} textBefore everything above the cursor
   * @param {{local?: LineIndex|null, minConfidence?: number}} [options]
   * @returns {{text: string, file: string, line: number, count: number,
   *   confidence: number, alternatives: number}|null}
   */
  lookup(textBefore, { local = null, minConfidence = DEFAULT_MIN_CONFIDENCE } = {}) {
    const ranked = this.candidates(textBefore, { local });
    if (ranked.length === 0) return null;
    const best = ranked[0];
    if (best.confidence < minConfidence) return null;
    return {
      text: best.text,
      file: best.file,
      line: best.line,
      count: best.count,
      support: best.support,
      confidence: best.confidence,
      alternatives: ranked.length,
    };
  }

  /** What the table holds, for `--stats`. */
  stats() {
    let contexts = 0;
    for (const [, t] of this.tables) contexts += t.size;
    return { contexts, files: this.nFiles, lines: this.nLines, widths: this.widths.length };
  }
}

/**
 * How many lines above the cursor the local model reads.
 *
 * Bounded for two reasons. A language server rebuilds this on every completion request,
 * and an unbounded one would re-lex the whole file per keystroke on exactly the large
 * files where that hurts. And this is the window every published number was measured
 * through, so a caller that used a different one would be reporting a different feature.
 * Forty lines is far more than the six tokens the widest context can reach through; the
 * slack is there because blank and comment lines do not count toward a context.
 */
export const LOCAL_TAIL_LINES = 40;

/**
 * A local model over the text above the cursor.
 *
 * The buffer being edited is not in the corpus and is the most useful single source of
 * candidates, so the caller builds one of these per lookup and passes it in. It is the
 * same class: a corpus of one file.
 */
export function localIndex(text, file = "<buffer>") {
  return new LineIndex().addFile(file, text).finalize();
}

/**
 * The local model for a cursor, over the bounded tail — what every caller should use.
 *
 * Extracted so the CLI, the language server and `tools/measure-line.mjs` cannot quietly
 * disagree about what "the buffer above the cursor" means. They did: the CLI read the
 * whole of stdin while the measurement read the last forty lines, which is a small
 * difference that would have made the published numbers describe a slightly different
 * program than the one that ships.
 *
 * @param {string} textBefore everything above the cursor
 */
export function localIndexFor(textBefore) {
  if (!textBefore || !textBefore.trim()) return null;
  const lines = textBefore.split("\n");
  return localIndex(lines.slice(-LOCAL_TAIL_LINES).join("\n"));
}

/**
 * Is the cursor at the start of a line, where a whole-line suggestion means anything?
 *
 * The table answers "what line came after this context", so it is only the right answer
 * where a new line is actually beginning. Half way through `renderWidg|` the useful
 * suggestion is a token, and offering a whole line there would replace what is already
 * typed with something that does not continue it.
 *
 * @param {string} textBefore everything above the cursor
 */
export function atLineStart(textBefore) {
  const nl = textBefore.lastIndexOf("\n");
  return textBefore.slice(nl + 1).trim() === "";
}
