/**
 * Does it actually predict?
 *
 * The other suites check that the pieces behave: that the lexer splits what it says it
 * splits, that an incremental update lands on the same index a rebuild would, that a
 * session never disagrees with a fresh Completer. All of that can be true of a thing that
 * predicts nothing — an index kept perfectly in sync with a corpus it cannot use is still
 * a ranking of noise.
 *
 * So this suite asks the question directly, in two halves.
 *
 * The first half pins the arithmetic underneath every suggestion: that `predict` returns
 * a real distribution rather than a bag of scores, that context is used and then
 * correctly forgotten past the model's order, that Witten-Bell actually distrusts a
 * context with many continuations, and that the blend is exactly the two numbers it
 * claims to be.
 *
 * The second half holds a file out of this repository, indexes the rest, and predicts
 * every seventh token of the file it never saw. It is scored against three controls, and
 * the controls are the point: an accuracy on its own is not evidence, because completion
 * accuracy is large everywhere. What is asserted is that the trained index beats an index
 * of the same shape built from unrelated prose, and that the blend beats each of its own
 * arms — the claim the README leads with, checked against this repo rather than quoted.
 *
 * Every measurement here is gated the way tools/measure.mjs gates its own: too few
 * positions, or a scorer that never produced both a hit and a miss, fails the test rather
 * than reporting a clean number from an instrument that could not have failed.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { lex, isWord } from "../src/lex.js";
import { CountModel } from "../src/count-model.js";
import { CacheModel } from "../src/cache-model.js";
import { Completer } from "../src/completer.js";
import { collectFiles } from "../src/build.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "src");

/** Build a finalized index from source strings. */
function indexOf(...sources) {
  const m = new CountModel(5);
  for (const s of sources) m.addFileTokens(lex(s));
  return m.finalize();
}

/** The sum of every score `predict` handed back. */
function totalMass(scores) {
  let sum = 0;
  for (const v of scores.values()) sum += v;
  return sum;
}

describe("CountModel.predict — the arithmetic every suggestion rests on", () => {
  // The scores are documented as "comparable to each other, and that is all they are
  // promised to be", which is the right promise to make to a caller. It is not the right
  // promise to test against: the interpolation is only correct if the mass it spreads over
  // the vocabulary adds up, and a backoff weight applied to the wrong denominator would
  // still produce a plausible-looking ranking. Below the top-unigram cap every candidate
  // is returned, so the total is checkable exactly.
  test("the scores for a small vocabulary are a distribution, not a bag of numbers", () => {
    const m = indexOf(
      "const alpha = 1; const beta = 2; const alpha = 3;",
      "function run(alpha) { return alpha + beta; }"
    );
    assert.ok(m.uni.size < 200, "this corpus must stay under the top-unigram cap for the sum to be total");

    for (const prev of [[], ["const"], ["const", "alpha"], ["return", "alpha", "+"], ["never", "seen", "here"]]) {
      const scores = m.predict(prev);
      assert.equal(scores.size, m.uni.size, `predict dropped candidates at ${JSON.stringify(prev)}`);
      assert.ok(
        Math.abs(totalMass(scores) - 1) < 1e-9,
        `mass was ${totalMass(scores)} at ${JSON.stringify(prev)}`
      );
    }
  });

  // The zero-order floor is what makes the vocabulary unbounded in practice: a name seen
  // once, in a context nothing matches, is still rankable rather than silently absent.
  test("every token the index holds is rankable, even from a context nothing matches", () => {
    const m = indexOf("const alpha = 1; let rarelyUsedName = 2;");
    const scores = m.predict(["nothing", "like", "this"]);
    assert.ok(scores.get("rarelyUsedName") > 0, "a name seen once must still carry mass");
    for (const [w, v] of scores) assert.ok(v > 0, `${w} scored ${v}, which makes it unreachable`);
  });

  test("context beyond the model's order is not used, and everything within it is", () => {
    const m = indexOf("q w e a b c d target ; z x a b c d target ;");
    const four = m.predict(["a", "b", "c", "d"]);

    // Order 5 means contexts of at most 4. Anything before that must not change the answer.
    for (const junk of [["q", "w", "e"], ["ZZ", "YY"], []]) {
      const longer = m.predict([...junk, "a", "b", "c", "d"]);
      assert.deepEqual([...longer].sort(), [...four].sort(), `context of length ${junk.length + 4} disagreed`);
    }

    // ...and the four tokens that DO count are load-bearing: change one and the answer moves.
    const different = m.predict(["a", "b", "c", "zzz"]);
    assert.notDeepEqual([...different].sort(), [...four].sort());
  });

  test("an unseen long context backs off to the longest suffix that was seen", () => {
    const m = indexOf("open close ; ".repeat(20) + "alpha beta open shut ; ".repeat(20));
    const best = (prev) => [...m.predict(prev).entries()].sort((p, q) => q[1] - p[1])[0][0];

    // "alpha beta open" was seen and says shut; nothing has ever preceded it with "zz",
    // so the order-4 lookup misses and the order-3 one decides.
    assert.equal(best(["alpha", "beta", "open"]), "shut");
    assert.equal(best(["zz", "alpha", "beta", "open"]), "shut");
    // Break the seen part too and it falls all the way to the bare "open", which says close.
    assert.equal(best(["zz", "yy", "xx", "open"]), "close");
  });

  // lambda = N / (N + T): a context seen many times with ONE continuation is trusted, one
  // seen equally often with many DIFFERENT continuations is not, and the mass it does not
  // keep falls through to the shorter context. T is the whole of what separates the two,
  // so the test has to hold N fixed and vary only T — otherwise a model that ignored T
  // entirely (lambda = N / (N + 1)) would pass, which is exactly what an earlier version
  // of this test did.
  test("a context that could be followed by anything is not trusted with the answer", () => {
    const m = new CountModel(5);
    let promiscuous = "";
    for (let i = 0; i < 20; i++) promiscuous += `cc dd v${i} ; `;
    m.addFileTokens(lex(promiscuous));                       // "cc dd": N=20, T=20
    m.addFileTokens(lex("xx dd backstop ; ".repeat(50)));    // "dd" alone: usually backstop
    m.addFileTokens(lex("aa dd steady ; ".repeat(20)));      // "aa dd": N=20, T=1
    m.finalize();

    // Twenty different tokens have followed "cc dd" and each of them exactly once, so half
    // the mass falls through to "dd" — and what usually follows "dd" beats all twenty,
    // despite never once having followed "cc dd".
    const loose = m.predict(["cc", "dd"]);
    for (let i = 0; i < 20; i++) {
      assert.ok(
        loose.get("backstop") > loose.get(`v${i}`),
        `v${i} scored ${loose.get(`v${i}`)} against backstop's ${loose.get("backstop")}`
      );
    }

    // Seen the same 20 times with one continuation, the context keeps nearly everything
    // and the popular token below it gets almost none of the mass.
    const tight = m.predict(["aa", "dd"]);
    assert.ok(tight.get("steady") > 0.9, `a context with one continuation kept only ${tight.get("steady")}`);
    assert.ok(tight.get("steady") > 10 * tight.get("backstop"));
  });

  // Interpolation, not winner-take-all: every order that matched contributes, weighted.
  // A model that stopped at the longest match would give the same top-1 here and be wrong
  // about everything underneath it.
  test("a shorter context keeps contributing even when a longer one matched", () => {
    const m = new CountModel(5);
    m.addFileTokens(lex("p q r once ; "));                    // "p q r" seen exactly once
    m.addFileTokens(lex("zz q r common ; ".repeat(50)));      // "q r" seen fifty times
    m.finalize();

    const scores = m.predict(["p", "q", "r"]);
    const once = scores.get("once");
    const common = scores.get("common");

    // The exact match still wins — it is the longest context and it was seen — but only
    // just, because a context seen a single time keeps only half the mass and the rest
    // falls to "q r", which has seen `common` fifty times.
    assert.ok(once > common, "the longest matching context must still lead");
    assert.ok(
      common > 0.9 * once,
      `the shorter order barely contributed: common ${common} against once ${once}`
    );
  });

  test("seeing a continuation more often ranks it higher, all else equal", () => {
    const m = indexOf("go left ; ".repeat(9) + "go right ; ");
    const scores = m.predict(["go"]);
    assert.ok(scores.get("left") > scores.get("right"));

    // And the ordering follows the counts rather than merely differing from them.
    const flipped = indexOf("go left ; " + "go right ; ".repeat(9));
    assert.ok(flipped.predict(["go"]).get("right") > flipped.predict(["go"]).get("left"));
  });
});

describe("the blend — score = beta * P_cache + (1 - beta) * P_repo", () => {
  const CORPUS = "const alpha = 1; const beta = 2; function run(alpha) { return alpha + beta; }";

  // The blend is one line of the completer and the whole of its thesis, so it is worth
  // recomputing from the two models by hand rather than trusting that the line still says
  // what the comment above it says.
  test("the score is exactly the two models, weighted, and nothing else", () => {
    const m = indexOf(CORPUS);
    const buffer = lex("const gizmo = 3; gizmo + alpha;");

    for (const beta of [0, 0.25, 0.5, 0.75, 1]) {
      const c = new Completer(m, { cacheBeta: beta });
      c.setBuffer(buffer);
      const scored = c.suggestScored(buffer, { k: 8 });

      const repo = m.predict(buffer);
      const cache = CacheModel.fromTokens(buffer);
      const candidates = new Set(repo.keys());
      for (const w of cache.vocab()) candidates.add(w);
      const cacheP = beta > 0 ? cache.predict(buffer, candidates) : new Map();
      // The completer drops the cache arm entirely when the cache scored nothing, so an
      // empty buffer at beta=1 is the repo's ranking rather than an empty one.
      const effective = cacheP.size ? beta : 0;

      for (const { token, score } of scored) {
        const expected = effective * (cacheP.get(token) || 0) + (1 - effective) * (repo.get(token) || 0);
        assert.ok(
          Math.abs(score - expected) < 1e-12,
          `beta=${beta} ${token}: got ${score}, expected ${expected}`
        );
      }
    }
  });

  test("beta = 1 with nothing in the buffer is the repo's ranking, not an empty one", () => {
    const m = indexOf(CORPUS);
    const bufferOnly = new Completer(m, { cacheBeta: 1 });
    bufferOnly.setBuffer([]);
    assert.equal(bufferOnly.cache, null);
    assert.deepEqual(
      bufferOnly.suggest(["const"], { k: 3 }),
      new Completer(m, { cacheBeta: 0 }).suggest(["const"], { k: 3 }),
      "an editor that opens an empty file must still get the repo's suggestions"
    );
  });

  test("raising beta moves weight from the repo to the buffer, monotonically", () => {
    const m = indexOf("const alpha = 1; ".repeat(30));
    const buffer = lex("const gizmoTotal = 0; gizmoTotal += 1; gizmoTotal");

    let previousLocal = -1;
    let previousRepo = Infinity;
    for (const beta of [0, 0.25, 0.5, 0.75, 1]) {
      const c = new Completer(m, { cacheBeta: beta });
      c.setBuffer(buffer);
      const scores = c.scoreCandidates(buffer, ["gizmoTotal", "alpha"]);
      const local = scores.get("gizmoTotal");
      const repo = scores.get("alpha");
      assert.ok(local > previousLocal, `beta=${beta}: the buffer-local name did not gain`);
      assert.ok(repo < previousRepo, `beta=${beta}: the repo name did not give way`);
      previousLocal = local;
      previousRepo = repo;
    }
    assert.equal(new Completer(m, { cacheBeta: 0 }).scoreCandidates(buffer, ["gizmoTotal"]).get("gizmoTotal"), 0);
  });
});

// A live buffer produces on the order of a thousand candidates and the completer prunes
// the repo side to 500 before scoring. Pruning is a speed decision that is only free if
// it never removes the answer, and it runs on exactly the repos big enough that nobody
// checks it by hand.
describe("prediction with more candidates than the prune cap", () => {
  /** A corpus whose single context is followed by 700 distinct tokens, one of them often. */
  function wideCorpus() {
    let src = "";
    for (let i = 0; i < 700; i++) src += `head n${i} ; `;
    for (let i = 0; i < 40; i++) src += "head n7 ; ";
    const m = new CountModel(5);
    m.addFileTokens(lex(src));
    return m.finalize();
  }

  test("the well-predicted continuation survives the prune", () => {
    const m = wideCorpus();
    assert.ok(m.predict(["head"]).size > 500, "this corpus must exceed the cap for the test to mean anything");
    const out = new Completer(m, { cacheBeta: 0 }).suggest(["head"], { k: 5, prefix: "n" });
    assert.equal(out[0], "n7", `got ${JSON.stringify(out)}`);
  });

  test("pruning keeps the highest-scoring candidates, not an arbitrary 500", () => {
    const m = wideCorpus();
    const scores = m.predict(["head"]);
    const kept = new Set(
      [...scores.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? 1 : -1))
        .slice(0, 500)
        .map((e) => e[0])
    );
    const out = new Completer(m, { cacheBeta: 0 }).suggest(["head"], { k: 10 });
    for (const w of out) assert.ok(kept.has(w), `${w} was returned but is not in the top 500 by score`);
  });

  test("a buffer-local name is not pruned away by a large repo vocabulary", () => {
    const m = wideCorpus();
    const c = new Completer(m, { cacheBeta: 0.5 });
    const out = c.complete("head localWidget ; head localWidget ; head localWid", { k: 5 });
    assert.ok(out.includes("localWidget"), `got ${JSON.stringify(out)}`);
  });

  test("the pruned path is still deterministic across calls and across completers", () => {
    const m = wideCorpus();
    const a = new Completer(m, { cacheBeta: 0 });
    const first = a.suggest(["head"], { k: 5 });
    assert.deepEqual(a.suggest(["head"], { k: 5 }), first);
    assert.deepEqual(new Completer(m, { cacheBeta: 0 }).suggest(["head"], { k: 5 }), first);
  });
});

describe("asking for k suggestions", () => {
  test("a k larger than the vocabulary returns what exists rather than padding", () => {
    const m = indexOf("const alpha = 1;");
    const out = new Completer(m, { cacheBeta: 0 }).suggest(["const"], { k: 100 });
    assert.equal(out.length, m.uni.size);
    assert.equal(new Set(out).size, out.length, "the same token must not be offered twice");
  });

  test("a prefix nothing matches is an empty list, not a wrong list", () => {
    const m = indexOf("const alpha = 1;");
    assert.deepEqual(new Completer(m, { cacheBeta: 0 }).suggest(["const"], { k: 5, prefix: "zzzz" }), []);
  });

  test("k = 0 asks for nothing and gets nothing", () => {
    const m = indexOf("const alpha = 1;");
    assert.deepEqual(new Completer(m, { cacheBeta: 0 }).suggest(["const"], { k: 0 }), []);
  });

  test("the first k of a larger request is the answer to the smaller one", () => {
    const m = indexOf("const alpha = 1; const beta = 2; const alpha = 3; function run() {}");
    const c = new Completer(m, { cacheBeta: 0 });
    const five = c.suggest(["const"], { k: 5 });
    for (let k = 1; k <= 5; k++) assert.deepEqual(c.suggest(["const"], { k }), five.slice(0, k));
  });
});

/**
 * The end-to-end question, on real code, against controls.
 *
 * One file of this repository is held out, the rest are indexed, and every seventh token
 * of the held-out file is predicted from the tokens above it — the same shape of
 * measurement tools/measure.mjs makes, small enough to run in the suite.
 *
 * The absolute accuracies are deliberately NOT asserted tightly. They move whenever the
 * source moves, and an accuracy with nothing beside it is not evidence anyway. What is
 * asserted is the comparisons, which are stable because both arms see the same positions:
 * the trained index must beat an index built from unrelated prose, and the blend must
 * beat each of the two arms it is made of.
 */
describe("held-out prediction on this repository", () => {
  const files = collectFiles(SRC);
  const FOREIGN =
    "The quick brown fox jumps over the lazy dog. Whether or not the weather is fine, " +
    "we shall walk to the market and buy bread, cheese and apples for the week ahead. ";

  /** Predict every seventh token of `tokens`, and report what was right. */
  function score(model, tokens, beta) {
    const c = new Completer(model, { cacheBeta: beta });
    c.cache = null;
    const r = { n: 0, top1: 0, top5: 0, identN: 0, identTop1: 0 };
    for (let t = 4; t < tokens.length; t += 7) {
      const prev = tokens.slice(0, t);
      const truth = tokens[t];
      c.setBuffer(prev);

      const list = c.suggest(prev, { k: 5 });
      r.n++;
      if (list[0] === truth) r.top1++;
      if (list.includes(truth)) r.top5++;

      // `ident+1char`: an identifier, after its first character has been typed. It is the
      // number a user actually feels; the aggregate is mostly punctuation.
      if (isWord(truth)) {
        r.identN++;
        if (c.suggest(prev, { k: 5, prefix: truth[0] })[0] === truth) r.identTop1++;
      }
    }
    return r;
  }

  const add = (a, b) => {
    for (const key of Object.keys(a)) a[key] += b[key];
    return a;
  };

  test("the corpus is big enough to hold a file out of", () => {
    assert.ok(files.length >= 4, `only ${files.length} indexable files under src/`);
  });

  test("an index of this repo beats an index of unrelated prose, on every held-out file", () => {
    const foreign = indexOf(FOREIGN.repeat(40));
    let checked = 0;

    for (const held of files) {
      const trained = new CountModel(5);
      for (const f of files) {
        if (f !== held) trained.addFileTokens(lex(fs.readFileSync(f, "utf8")));
      }
      trained.finalize();

      const tokens = lex(fs.readFileSync(held, "utf8"));
      if (tokens.length < 200) continue; // too short to measure anything on
      checked++;

      const real = score(trained, tokens, 0.5);
      const control = score(foreign, tokens, 0.5);
      assert.equal(real.n, control.n, "the two arms must be scored on identical positions");
      assert.ok(
        real.top5 > control.top5,
        `${path.basename(held)}: trained ${real.top5}/${real.n} did not beat prose ${control.top5}/${control.n}`
      );
      // The control must be a real instrument: one that scored zero, or everything, would
      // make the comparison above vacuous.
      assert.ok(control.top5 > 0 && control.top5 < control.n, "the control neither hit nor missed");
    }

    assert.ok(checked >= 4, `only ${checked} files were long enough to score`);
  });

  test("the blend beats both of the arms it is made of", () => {
    const pooled = {
      hybrid: { n: 0, top1: 0, top5: 0, identN: 0, identTop1: 0 },
      repoOnly: { n: 0, top1: 0, top5: 0, identN: 0, identTop1: 0 },
      bufferOnly: { n: 0, top1: 0, top5: 0, identN: 0, identTop1: 0 },
    };

    for (const held of files) {
      const trained = new CountModel(5);
      for (const f of files) {
        if (f !== held) trained.addFileTokens(lex(fs.readFileSync(f, "utf8")));
      }
      trained.finalize();

      const tokens = lex(fs.readFileSync(held, "utf8"));
      if (tokens.length < 200) continue;
      add(pooled.hybrid, score(trained, tokens, 0.5));
      add(pooled.repoOnly, score(trained, tokens, 0));
      add(pooled.bufferOnly, score(trained, tokens, 1));
    }

    // Gates, before any of the numbers below are allowed to mean anything.
    assert.ok(pooled.hybrid.n >= 200, `only ${pooled.hybrid.n} scored positions`);
    assert.ok(pooled.hybrid.identN >= 100, `only ${pooled.hybrid.identN} identifier positions`);
    for (const [name, r] of Object.entries(pooled)) {
      assert.ok(r.top5 > 0 && r.top5 < r.n, `${name} never produced both a hit and a miss`);
    }

    // Neither arm is the tool. The blend is — which is a claim, and this is the check.
    assert.ok(
      pooled.hybrid.top5 > pooled.repoOnly.top5,
      `hybrid ${pooled.hybrid.top5} vs repo-only ${pooled.repoOnly.top5} of ${pooled.hybrid.n}`
    );
    assert.ok(
      pooled.hybrid.top5 > pooled.bufferOnly.top5,
      `hybrid ${pooled.hybrid.top5} vs buffer-only ${pooled.bufferOnly.top5} of ${pooled.hybrid.n}`
    );
    assert.ok(
      pooled.hybrid.identTop1 > pooled.repoOnly.identTop1,
      `hybrid ${pooled.hybrid.identTop1} vs repo-only ${pooled.repoOnly.identTop1} of ${pooled.hybrid.identN}`
    );
    assert.ok(
      pooled.hybrid.identTop1 > pooled.bufferOnly.identTop1,
      `hybrid ${pooled.hybrid.identTop1} vs buffer-only ${pooled.bufferOnly.identTop1} of ${pooled.hybrid.identN}`
    );

    // A floor, set far below what is measured (~0.44 on this repo at the time of writing)
    // and deliberately loose: it is here to catch prediction breaking outright, not to
    // pin a number that moves whenever src/ moves.
    const identAccuracy = pooled.hybrid.identTop1 / pooled.hybrid.identN;
    assert.ok(identAccuracy > 0.2, `ident+1char top-1 fell to ${identAccuracy.toFixed(3)}`);
  });

  // The recital rate is the number the README asks people to check before installing
  // anything, and it is what predicts whether the comparisons above hold on a stranger's
  // repo. It has to be measured against held-out text to mean that.
  test("the recital rate on a held-out file is a real fraction, not 0 or 1", () => {
    let measured = 0;
    for (const held of files) {
      const trained = new CountModel(5);
      for (const f of files) {
        if (f !== held) trained.addFileTokens(lex(fs.readFileSync(f, "utf8")));
      }
      trained.finalize();

      const tokens = lex(fs.readFileSync(held, "utf8"));
      if (tokens.length < 200) continue;
      const rate = trained.recitalRate(tokens);
      assert.ok(rate > 0 && rate < 1, `${path.basename(held)} recited at ${rate}`);
      measured++;
    }
    assert.ok(measured >= 4);
  });
});
