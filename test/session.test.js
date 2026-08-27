/**
 * The session's whole claim is that it is the SAME answer as a fresh Completer, reached
 * without redoing the work. So almost every test here is a parity test: type text in one
 * character at a time and assert the session and a from-scratch Completer never disagree,
 * at any cursor, at any blend.
 *
 * A faster ranking that quietly drifts from the slow one would be worse than no session
 * at all, because the drift would only show up as slightly wrong suggestions in somebody's
 * editor, months later, with nothing to point at.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lex, splitAtCursor, trailingWordStart } from "../src/lex.js";
import { CountModel } from "../src/count-model.js";
import { CacheModel } from "../src/cache-model.js";
import { Completer } from "../src/completer.js";
import { BufferSession } from "../src/session.js";

function indexOf(...sources) {
  const m = new CountModel(5);
  for (const s of sources) m.addFileTokens(lex(s));
  return m.finalize();
}

const REPO = [
  "export function renderWidget(widget) { return widget.name; }",
  "const config = loadConfig(); config.enabled = true;",
  "import { renderWidget } from './widget.js'; renderWidget(config);",
  "function loadConfig() { return { enabled: false, retries: 3 }; }",
  "for (const item of items) { console.log(item.id, item.name); }",
];

/** Type `text` in one character at a time; the two paths must never disagree. */
function typeAndCompare(t, index, text, { beta = 0.5, k = 5 } = {}) {
  const session = new Completer(index, { cacheBeta: beta }).session();
  for (let i = 1; i <= text.length; i++) {
    const soFar = text.slice(0, i);
    const fresh = new Completer(index, { cacheBeta: beta }).complete(soFar, { k });
    const live = session.complete(soFar, { k });
    assert.deepEqual(live, fresh, `disagreed at ${JSON.stringify(soFar)}`);

    // The session's own state must also be exactly what the one-shot lexer would say.
    const { prev, prefix } = splitAtCursor(soFar);
    assert.deepEqual(session.tokens, prev, `tokens drifted at ${JSON.stringify(soFar)}`);
    assert.equal(session.prefix, prefix, `prefix drifted at ${JSON.stringify(soFar)}`);
    if (session.cache) {
      assert.deepEqual(session.cache.tokens, session.tokens, `cache drifted at ${JSON.stringify(soFar)}`);
    }
  }
}

describe("trailingWordStart", () => {
  test("finds where the run of word characters at the end begins", () => {
    assert.equal(trailingWordStart("const conf"), 6);
    assert.equal(trailingWordStart("const "), 6, "no run at all means the end of the text");
    assert.equal(trailingWordStart("foo."), 4);
    assert.equal(trailingWordStart("abc"), 0, "the whole text can be the run");
    assert.equal(trailingWordStart(""), 0);
    assert.equal(trailingWordStart("x = 12"), 4, "digits are word characters and can still grow");
    assert.equal(trailingWordStart("a_b1"), 0);
  });
});

describe("CacheModel.truncate", () => {
  test("undoes exactly the adds that put those tokens there", () => {
    const dump = (c) => {
      const parts = [c.tokens.join("|")];
      for (const tab of c.tabs) {
        parts.push([...tab].map(([ctx, m]) => ctx + ">" + [...m].sort().join(",")).sort().join("/"));
      }
      return parts.join("##");
    };
    const base = CacheModel.fromTokens(lex("const alpha = 1; beta(alpha);"));
    const before = dump(base);

    base.add(lex("gamma(delta); epsilon = 2;"));
    base.truncate(before.split("##")[0].split("|").length);

    assert.equal(dump(base), before, "add then truncate must leave no residue");
  });

  test("truncating past the end is a no-op, and truncating to zero empties it", () => {
    const c = CacheModel.fromTokens(lex("a b c"));
    c.truncate(99);
    assert.equal(c.n, 3);
    c.truncate(0);
    assert.equal(c.n, 0);
    assert.equal(c.vocab().size, 0);
    for (const tab of c.tabs) assert.equal(tab.size, 0);
  });
});

describe("BufferSession — the same answer, without redoing the work", () => {
  const index = indexOf(...REPO);

  test("typing a line in agrees with a fresh Completer at every character", (t) => {
    typeAndCompare(t, index, "import { renderWidget } from './widget.js';\nconst config = loadConfig();\nrenderWidget(config);");
  });

  test("it agrees at every blend, including the two ends", (t) => {
    for (const beta of [0, 0.5, 1]) {
      typeAndCompare(t, index, "const configValue = loadConfig(); configValue.enabled;", { beta });
    }
  });

  // These are the shapes that break an incremental lexer if it checkpoints carelessly.
  test("it agrees on text designed to trip the checkpoint", (t) => {
    for (const nasty of [
      "x = 12",          // a trailing number can still grow: 12 -> 123, one token not two
      "x = 123456",
      "12ab",            // one run of word characters, but two tokens
      "abc",             // the whole text is one partial word
      "a.b.c",
      "_x1",
      "a  b   c",
      "foo(",
      "s = 'hello world'",
      "x=1;y=2;",
      "a__b",
      "n = 1e5",
      "//comment\nreal",
      "\t\tconst  ",
    ]) {
      typeAndCompare(t, index, nasty);
    }
  });

  test("a cursor that jumps backwards is rebuilt rather than extended", () => {
    const text = "const config = loadConfig(); renderWidget(config); const other = 1;";
    const session = new Completer(index).session();
    // Walk forward, then jump back and forth. Shrinking is never an extension.
    for (const cut of [66, 20, 45, 5, 60, 12, 66, 1, 40]) {
      const soFar = text.slice(0, cut);
      assert.deepEqual(
        session.complete(soFar, { k: 5 }),
        new Completer(index).complete(soFar, { k: 5 }),
        `disagreed after jumping to ${cut}`
      );
    }
  });

  test("backspacing mid-word agrees too", () => {
    const base = "const config = loadConf";
    const session = new Completer(index).session();
    for (const text of [base, base.slice(0, -1), base.slice(0, -2), base, base + "ig", base.slice(0, -4)]) {
      assert.deepEqual(
        session.complete(text, { k: 5 }),
        new Completer(index).complete(text, { k: 5 }),
        `disagreed at ${JSON.stringify(text)}`
      );
    }
  });

  test("rerank through a session is the same permutation", () => {
    const candidates = ["renderWidget", "loadConfig", "config", "neverSeenHere", "item"];
    const text = "import { renderWidget } from './widget.js';\nconst config = loadConfig();\nrender";
    const session = new Completer(index).session();
    for (let i = 20; i <= text.length; i++) {
      const soFar = text.slice(0, i);
      assert.deepEqual(
        session.rerank(candidates.slice(), soFar),
        new Completer(index).rerank(candidates.slice(), soFar),
        `disagreed at ${JSON.stringify(soFar)}`
      );
    }
  });

  test("completeScored agrees on both the tokens and the scores", () => {
    const text = "const config = loadConfig(); config.en";
    const session = new Completer(index).session();
    assert.deepEqual(
      session.completeScored(text, { k: 5 }),
      new Completer(index).completeScored(text, { k: 5 })
    );
  });

  test("completer.session() hands back a session bound to that completer", () => {
    const c = new Completer(index, { cacheBeta: 0.25 });
    const s = c.session();
    assert.ok(s instanceof BufferSession);
    assert.equal(s.completer, c);
    assert.equal(s.completer.cacheBeta, 0.25);
  });

  test("an empty index and an empty buffer do not throw", () => {
    const s = new Completer(new CountModel(5).finalize()).session();
    assert.doesNotThrow(() => s.complete("", { k: 5 }));
    assert.doesNotThrow(() => s.complete("const x", { k: 5 }));
  });

  test("one candidate or none is returned untouched, as with the Completer", () => {
    const s = new Completer(index).session();
    assert.deepEqual(s.rerank(["only"], "const "), ["only"]);
    assert.deepEqual(s.rerank([], "const "), []);
  });
});

describe("top-k selection", () => {
  // suggest() takes the best k without ordering the rest. That is only allowed to be
  // faster, never different, so every case is checked against the full ordering of the
  // same candidate set — which is what `k` larger than the candidate count produces.
  //
  // A comparison that cannot fail is worth nothing, so these corpora are built to make
  // ties common: that is where a selection and a sort are most likely to part company.
  test("selecting the best k is identical to the full ordering, over many tie-heavy sets", () => {
    let seed = 20260826;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    let compared = 0;
    let sawShortfall = false;
    for (let trial = 0; trial < 60; trial++) {
      // Many names repeated a few times each: lots of equal counts, so lots of ties.
      const words = [];
      for (let i = 0; i < 120; i++) words.push(`name${Math.floor(rnd() * 30)}`);
      const m = indexOf(...REPO, words.join(" ; "));
      const c = new Completer(m, { cacheBeta: rnd() < 0.5 ? 0 : 0.5 });
      const context = rnd() < 0.5 ? [] : ["const"];
      c.setBuffer(context);

      const full = c.suggestScored(context, { k: 1e9 });
      assert.ok(full.length > 5, "the fixture must offer more candidates than k");
      for (const k of [1, 2, 5, 13, full.length, full.length + 3]) {
        assert.deepEqual(c.suggestScored(context, { k }), full.slice(0, k), `k=${k}, trial ${trial}`);
        compared++;
        if (k > full.length) sawShortfall = true;
      }
    }
    assert.ok(compared >= 300, `only ${compared} comparisons ran`);
    assert.ok(sawShortfall, "a k larger than the candidate list was never exercised");
  });

  test("suggest returns the same list a full sort of its candidates would", () => {
    const m = indexOf(...REPO, "const a1 = 1; const a2 = 2; const a3 = 3; const a4 = 4; const a5 = 5;");
    const c = new Completer(m, { cacheBeta: 0 });
    for (const k of [1, 2, 3, 5, 10, 50]) {
      const scored = c.suggestScored([], { k });
      const all = c.suggestScored([], { k: 100000 });
      assert.deepEqual(scored, all.slice(0, k), `k=${k} disagreed with the full ordering`);
    }
  });

  test("the ordering stays deterministic across repeated calls", () => {
    const m = indexOf("a b c d e f g h a b c x y z");
    const runs = [];
    for (let i = 0; i < 5; i++) runs.push(new Completer(m).suggest(["a", "b"], { k: 5 }));
    for (const r of runs) assert.deepEqual(r, runs[0]);
  });
});
