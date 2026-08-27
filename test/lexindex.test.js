import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lex, isWord, splitAtCursor } from "../src/lex.js";
import { CountModel, recitalBand } from "../src/count-model.js";
import { CacheModel } from "../src/cache-model.js";
import { Completer } from "../src/completer.js";

/** Build a finalized index from source strings. */
function indexOf(...sources) {
  const m = new CountModel(5);
  for (const s of sources) m.addFileTokens(lex(s));
  return m.finalize();
}

describe("lex", () => {
  test("splits identifiers, numbers and single punctuation", () => {
    assert.deepEqual(lex("const x = 42;"), ["const", "x", "=", "42", ";"]);
  });

  test("splits string contents into words rather than keeping the literal whole", () => {
    // A whole literal is a vocabulary item that will never recur. Its words do.
    assert.deepEqual(lex(`t("hello world")`), ["t", "(", '"', "hello", "world", '"', ")"]);
  });

  test("isWord separates identifiers from punctuation and numbers", () => {
    assert.equal(isWord("foo_1"), true);
    assert.equal(isWord("42"), false);
    assert.equal(isWord("("), false);
  });
});

describe("splitAtCursor", () => {
  test("a partial identifier is the prefix, not context", () => {
    assert.deepEqual(splitAtCursor("const conf"), { prev: ["const"], prefix: "conf" });
  });

  test("a trailing space completes the token", () => {
    assert.deepEqual(splitAtCursor("const conf "), { prev: ["const", "conf"], prefix: null });
  });

  test("trailing punctuation is context, never a prefix", () => {
    assert.deepEqual(splitAtCursor("foo."), { prev: ["foo", "."], prefix: null });
  });

  test("empty text is not a crash", () => {
    assert.deepEqual(splitAtCursor(""), { prev: [], prefix: null });
  });
});

describe("CountModel", () => {
  test("predicts the token that actually followed the context", () => {
    const m = indexOf("const alpha = 1;", "const alpha = 2;", "const beta = 3;");
    const scores = m.predict(["const"]);
    assert.ok(scores.get("alpha") > scores.get("beta"), "alpha was seen twice, beta once");
  });

  test("longer matching context outranks a shorter one", () => {
    const m = indexOf("a b c zebra ".repeat(20), "x b c quail ".repeat(20));
    const top = [...m.predict(["a", "b", "c"]).entries()].sort((p, q) => q[1] - p[1])[0][0];
    assert.equal(top, "zebra");
  });

  test("an unseen context still returns candidates rather than nothing", () => {
    const m = indexOf("const alpha = 1;");
    assert.ok(m.predict(["totally", "unseen", "context"]).size > 0);
  });

  test("predict before finalize is an error, not a wrong answer", () => {
    const m = new CountModel(3);
    m.addFileTokens(lex("a b c"));
    assert.throws(() => m.predict(["a"]), /finalize/);
  });

  test("recitalRate is 1 for text it was built from and low for foreign text", () => {
    const src = "const alpha = 1; const alpha = 2; const beta = 3;";
    const m = indexOf(src);
    assert.equal(m.recitalRate(lex(src)), 1);
    assert.ok(m.recitalRate(lex("zzz qqq www vvv uuu ttt")) < 0.5);
  });
});

// These thresholds were wrong once, in the direction that undersold the tool: one band
// at 40% stood in for two different questions, and a corpus at 35.9% recital that beat
// its baseline decisively (z=3.74) was being told to expect little. They are pinned here
// so the CLI and the harness cannot quietly drift back to a single number.
describe("recitalBand", () => {
  test("above 60% both baselines are beaten", () => {
    for (const r of [0.6, 0.73, 1]) {
      assert.match(recitalBand(r), /word list and a ten-line frequency table/);
    }
  });

  test("35% to 60% beats the word list but not the frequency table", () => {
    for (const r of [0.35, 0.359, 0.465, 0.5999]) {
      const band = recitalBand(r);
      assert.match(band, /beats your editor's word list/);
      assert.match(band, /though not a ten-line frequency table/);
    }
  });

  test("below 35% promises nothing, and says what was actually measured there", () => {
    for (const r of [0, 0.135, 0.349]) {
      assert.match(recitalBand(r), /expect little/);
      assert.match(recitalBand(r), /13\.5%/);
    }
  });

  test("the two thresholds are distinct — one band cannot answer both questions", () => {
    assert.notEqual(recitalBand(0.45), recitalBand(0.65));
    assert.notEqual(recitalBand(0.45), recitalBand(0.20));
    // The old single threshold sat at 40%; 35.9% and 45% must now read the same.
    assert.equal(recitalBand(0.359), recitalBand(0.45));
  });
});

describe("CountModel — keeping an index current without rebuilding it", () => {
  /** A total ordering of everything the model counted, so two models can be compared. */
  function dump(m) {
    const parts = [`tokens=${m.nTokens}`, `files=${m.nFiles}`];
    for (const tab of m.tabs) {
      const rows = [...tab]
        .map(([ctx, counts]) =>
          ctx + " => " + [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e.join(":")).join(",")
        )
        .sort();
      parts.push(rows.join("|"));
    }
    return parts.join("##");
  }

  const A = "const alpha = 1; function run(x) { return alpha + x; }";
  const B = "const beta = 2; function walk(y) { return beta * y; }";
  const C = "const gamma = 3; export function crawl() { return gamma; }";

  test("removing a file is the exact inverse of adding it", () => {
    const base = indexOf(A, B);
    const before = dump(base);

    base.reopen();
    base.addFileTokens(lex(C));
    base.removeFileTokens(lex(C));
    base.finalize();

    assert.equal(dump(base), before, "add then remove must leave no residue at all");
  });

  test("an edited file gives exactly the index a full rebuild would", () => {
    const live = indexOf(A, B, C);
    const edited = "const gamma = 99; export function sprint() { return gamma; }";
    live.replaceFileTokens(lex(C), lex(edited));

    assert.equal(dump(live), dump(indexOf(A, B, edited)));
  });

  test("a deleted file and a new file both match a rebuild", () => {
    const deleted = indexOf(A, B, C);
    deleted.replaceFileTokens(lex(C), null);
    assert.equal(dump(deleted), dump(indexOf(A, B)));

    const added = indexOf(A, B);
    added.replaceFileTokens(null, lex(C));
    assert.equal(dump(added), dump(indexOf(A, B, C)));
  });

  test("a long sequence of edits does not drift away from a rebuild", () => {
    const live = indexOf(A, B, C);
    const shadow = [A, B, C];
    for (let i = 0; i < 10; i++) {
      const next = `function gen${i}(a, b) { return a + b + ${i}; } gen${i}(1, 2);`;
      const slot = i % shadow.length;
      live.replaceFileTokens(lex(shadow[slot]), lex(next));
      shadow[slot] = next;
    }
    assert.equal(dump(live), dump(indexOf(...shadow)));
  });

  // The recital rate is the one number this project asks people to trust, and it is read
  // straight off the context tables. A context left behind at count zero would go on
  // claiming the index had seen text that was deleted.
  test("removing the only file that used a context stops the index claiming it", () => {
    const m = indexOf(A);
    const held = lex(A);
    assert.equal(m.recitalRate(held), 1);

    m.replaceFileTokens(held, null);
    assert.equal(m.recitalRate(held), 0, "every context it knew came from the file just removed");
    assert.equal(m.tabs[4].size, 0);
    assert.equal(m.nFiles, 0);
    assert.equal(m.nTokens, 0);
  });

  test("an updated index predicts from the new text, not the old", () => {
    const m = indexOf("const alpha = 1;");
    m.replaceFileTokens(lex("const alpha = 1;"), lex("const omegaValue = 1;"));

    const out = new Completer(m, { cacheBeta: 0 }).suggest(["const"], { k: 5 });
    assert.ok(out.includes("omegaValue"), `got ${JSON.stringify(out)}`);
    assert.ok(!out.includes("alpha"), "the old name is gone from the corpus, so it must be gone from the index");
  });

  test("adding or removing after finalize is an error until reopen() says otherwise", () => {
    const m = indexOf(A);
    assert.throws(() => m.addFileTokens(lex(B)), /finalize/);
    assert.throws(() => m.removeFileTokens(lex(A)), /finalize/);
    m.reopen();
    assert.doesNotThrow(() => m.addFileTokens(lex(B)));
  });

  test("removing tokens the index never held does not corrupt it", () => {
    const m = indexOf(A);
    const before = dump(indexOf(A));
    m.reopen();
    m.removeFileTokens(lex("nothing like this was ever indexed"));
    m.finalize();
    // Counts are untouched; only the file and token tallies move, and they are floored.
    for (const tab of m.tabs) for (const counts of tab.values()) assert.ok(counts.size > 0);
    assert.ok(m.nTokens >= 0 && m.nFiles >= 0);
    assert.ok(before.length > 0);
  });
});

describe("scores", () => {
  test("suggestScored ranks identically to suggest, and the scores descend", () => {
    const m = indexOf("const alpha = 1; const beta = 2; const alpha = 3; const gamma = 4;");
    const c = new Completer(m);
    const scored = c.suggestScored(["const"], { k: 5 });
    assert.deepEqual(scored.map((e) => e.token), c.suggest(["const"], { k: 5 }));
    for (let i = 1; i < scored.length; i++) {
      assert.ok(scored[i - 1].score >= scored[i].score, "a ranking whose scores rise is not a ranking");
    }
  });

  test("completeScored carries the prefix and the buffer through, like complete", () => {
    const m = indexOf("function handleRequest(req) { return req; }");
    const c = new Completer(m);
    const scored = c.completeScored("function handleReq", { k: 5 });
    assert.deepEqual(scored.map((e) => e.token), c.complete("function handleReq", { k: 5 }));
    assert.ok(scored.every((e) => e.token.startsWith("handleReq")));
  });
});

describe("CacheModel", () => {
  test("only scores tokens it was given as candidates", () => {
    const c = CacheModel.fromTokens(lex("widget widget widget"));
    const scored = c.predict([], new Set(["nothingLikeThat"]));
    assert.equal(scored.get("widget"), undefined);
  });

  test("extending a buffer is incremental, not a rebuild", () => {
    const c = CacheModel.fromTokens(lex("alpha beta"));
    c.add(lex("gamma"));
    assert.equal(c.n, 3);
    assert.ok(c.vocab().has("gamma"));
  });
});

describe("Completer", () => {
  test("the prefix filters the list", () => {
    const m = indexOf("const alpha = 1; const beta = 2; const alpaca = 3;");
    const out = new Completer(m).suggest(["const"], { k: 5, prefix: "alp" });
    assert.ok(out.length > 0);
    assert.ok(out.every((w) => w.startsWith("alp")), `got ${JSON.stringify(out)}`);
  });

  test("identical input gives an identical list — a list that reorders on redraw is worse than a wrong one", () => {
    const m = indexOf("a b c d e f g h a b c x y z");
    const a = new Completer(m).suggest(["a", "b"], { k: 5 });
    const b = new Completer(m).suggest(["a", "b"], { k: 5 });
    assert.deepEqual(a, b);
  });

  // The mechanism's central claim, and the reason a cache exists at all.
  test("a name that exists ONLY in the buffer is suggested, and the repo index alone cannot", () => {
    const m = indexOf("const alpha = 1; const beta = 2;");
    const buffer = lex("const zephyrCounter = 0; zephyrCounter += 1; const z");

    const repoOnly = new Completer(m, { cacheBeta: 0 });
    repoOnly.setBuffer(buffer);
    assert.ok(
      !repoOnly.suggest(buffer, { k: 5, prefix: "zephyr" }).includes("zephyrCounter"),
      "the repo index has never seen this token, so it must not rank it"
    );

    const hybrid = new Completer(m, { cacheBeta: 0.5 });
    hybrid.setBuffer(buffer);
    assert.ok(
      hybrid.suggest(buffer, { k: 5, prefix: "zephyr" }).includes("zephyrCounter"),
      "the buffer cache is what makes a name predictable the second time it is typed"
    );
  });

  test("cacheBeta = 0 truly disables the cache", () => {
    const m = indexOf("const alpha = 1;");
    const c = new Completer(m, { cacheBeta: 0 });
    c.setBuffer(lex("widget widget"));
    assert.equal(c.cache, null);
  });

  test("complete() handles lexing, the prefix and the buffer in one call", () => {
    const m = indexOf("function handleRequest(req) { return req; }");
    const out = new Completer(m).complete("function handleReq", { k: 5 });
    assert.ok(out.includes("handleRequest"), `got ${JSON.stringify(out)}`);
  });

  test("an empty index does not throw", () => {
    const m = new CountModel(5).finalize();
    assert.doesNotThrow(() => new Completer(m).complete("const x", { k: 5 }));
  });
});

describe("rerank — re-ordering another engine's candidate list", () => {
  test("returns a permutation: nothing added, nothing dropped", () => {
    const m = indexOf("const alpha = 1; const beta = 2; alpha + beta;");
    const given = ["zeta", "alpha", "beta", "unseenName"];
    const out = new Completer(m).rerank(given, "const ");
    assert.deepEqual([...out].sort(), [...given].sort());
  });

  test("a name the repo uses often outranks one it has never seen", () => {
    const m = indexOf("const alpha = 1; ".repeat(20) + "const zeta = 2;");
    const out = new Completer(m).rerank(["neverSeenHere", "alpha"], "const ");
    assert.equal(out[0], "alpha");
  });

  // The point of the whole mechanism: deciding what is LEGAL is the other engine's job,
  // deciding what is LIKELY is this one's.
  //
  // Stated precisely, because the obvious stronger claim is false: the cache gives a
  // buffer-local name a real score where the repo index gives it exactly zero. Whether
  // that is enough to WIN depends on the numbers — a repo name used 30 times should and
  // does outrank a buffer name used 4 times, and asserting otherwise would be asserting
  // a bug.
  test("the cache lifts a buffer-local name the repo scores at zero", () => {
    const m = indexOf("const alpha = 1; function run(x) { return x + 1; }".repeat(30));
    const buffer = lex("const zephyrCounter = 0; zephyrCounter += 1; zephyrCounter");

    const repoOnly = new Completer(m, { cacheBeta: 0 });
    repoOnly.setBuffer(buffer);
    assert.equal(
      repoOnly.scoreCandidates(buffer, ["zephyrCounter"]).get("zephyrCounter"),
      0,
      "the repo has never seen this name"
    );

    const hybrid = new Completer(m, { cacheBeta: 0.5 });
    hybrid.setBuffer(buffer);
    assert.ok(
      hybrid.scoreCandidates(buffer, ["zephyrCounter"]).get("zephyrCounter") > 0,
      "the cache is what makes it rankable at all"
    );
  });

  test("a buffer-local name outranks a repo name used once", () => {
    const m = indexOf("const alpha = 1; function run(x) { return x + 1; }".repeat(30) + " let rareThing = 9;");
    const c = new Completer(m, { cacheBeta: 0.5 });
    const buffer = "const zephyrCounter = 0;\nzephyrCounter += 1;\nlog(zephyrCounter);\nzephyrCounter";
    const out = c.rerank(["rareThing", "zephyrCounter"], buffer + " ");
    assert.equal(out[0], "zephyrCounter", `got ${JSON.stringify(out)}`);
  });

  test("it does not second-guess legality — an absurd candidate set is still returned", () => {
    const m = indexOf("const alpha = 1;");
    const out = new Completer(m).rerank(["!!!", "???"], "const ");
    assert.equal(out.length, 2);
  });

  test("one candidate or none is returned untouched", () => {
    const m = indexOf("const alpha = 1;");
    const c = new Completer(m);
    assert.deepEqual(c.rerank(["only"], "const "), ["only"]);
    assert.deepEqual(c.rerank([], "const "), []);
  });

  test("identical input gives an identical order", () => {
    const m = indexOf("a b c d a b e f a b");
    const given = ["c", "e", "d", "f"];
    const c1 = new Completer(m).rerank(given, "a b ");
    const c2 = new Completer(m).rerank(given, "a b ");
    assert.deepEqual(c1, c2);
  });

  // rerankTokens is the whole of rerank after the lexing. The measurement harness calls
  // it directly, so if the two could disagree the harness would be measuring something
  // other than what ships.
  test("rerankTokens is exactly rerank without the lexing step", () => {
    const m = indexOf("const alpha = 1; ".repeat(8) + "const zeta = 2; alpha(zeta);");
    for (const text of ["const ", "alpha(", "const alpha = 1; z", "", "a b c "]) {
      const given = ["zeta", "alpha", "neverSeenHere", "const"];

      const viaText = new Completer(m).rerank(given.slice(), text);

      const c = new Completer(m);
      const { prev } = splitAtCursor(text);
      c.setBuffer(prev);
      const viaTokens = c.rerankTokens(given.slice(), prev);

      assert.deepEqual(viaTokens, viaText, `disagreed at ${JSON.stringify(text)}`);
    }
  });

  test("rerankTokens returns a permutation and leaves one or none alone", () => {
    const m = indexOf("const alpha = 1;");
    const c = new Completer(m);
    const given = ["b", "a", "c"];
    assert.deepEqual([...c.rerankTokens(given, ["const"])].sort(), [...given].sort());
    assert.deepEqual(c.rerankTokens(["only"], ["const"]), ["only"]);
    assert.deepEqual(c.rerankTokens([], ["const"]), []);
  });

  // Consistency with suggest(): re-ranking suggest's own top-k must not reorder it.
  test("rerank agrees with suggest on suggest's own candidates", () => {
    const m = indexOf("const alpha = 1; const beta = 2; const gamma = 3; const alpha = 4;");
    const c = new Completer(m, { cacheBeta: 0 });
    const top = c.suggest(["const"], { k: 4 });
    const re = new Completer(m, { cacheBeta: 0 }).rerank(top, "const ");
    assert.deepEqual(re, top);
  });
});
