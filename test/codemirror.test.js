/**
 * The completion source, tested without CodeMirror installed.
 *
 * That is not a shortcut around a missing dependency — it is the point. This package's
 * README opens by saying `dependencies` and `devDependencies` are both empty and inviting
 * the reader to check, so the adapter is written against the shape of a CodeMirror
 * completion context rather than against its package. A test that installed
 * `@codemirror/autocomplete` to prove the adapter works would disprove the thing the
 * adapter is careful about.
 *
 * So the context here is a Proxy that THROWS on any property the source is not supposed
 * to touch. If somebody later reaches for `context.state.selection` or
 * `context.matchBefore`, these tests fail with the name of the property, and whoever wrote
 * it finds out at that moment rather than when a page fails to build.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isWord } from "../src/lex.js";
import { Completer } from "../src/completer.js";
import { DocumentSet } from "../src/documents.js";
import { completionSource } from "../src/codemirror.js";

/**
 * A CompletionContext holding exactly what CodeMirror gives one, and nothing the source
 * is allowed to want. Reading anything else throws with the property's name.
 */
function contextAt(text, { explicit = false, pos = text.length } = {}) {
  const read = [];
  const guard = (target, label, allowed) =>
    new Proxy(target, {
      get(t, prop) {
        if (typeof prop === "symbol") return t[prop];
        if (!allowed.includes(prop)) {
          throw new Error(
            `the completion source read ${label}.${prop}, which CodeMirror is not being ` +
              `asked for here. Widening the surface means widening what the adapter assumes.`
          );
        }
        read.push(`${label}.${prop}`);
        return t[prop];
      },
    });

  const doc = guard({ sliceString: (from, to) => text.slice(from, to) }, "doc", ["sliceString"]);
  const state = guard({ doc }, "state", ["doc"]);
  const ctx = guard({ pos, explicit, state }, "context", ["pos", "explicit", "state"]);
  return { ctx, read };
}

const A = "export function renderWidget(widget) { return widget.name; }";
const B = "const config = loadConfig(); config.enabled = true; config.retries = 3;";
const C = "function loadConfig() { return { enabled: false, retries: 3 }; }";

function setOf(...texts) {
  const docs = new DocumentSet();
  texts.forEach((t, i) => docs.open(`doc${i}.js`, t));
  return docs;
}

describe("the CodeMirror source — what it offers", () => {
  test("a typed prefix produces options anchored at the start of the word", () => {
    const source = completionSource(setOf(A, B, C));
    const { ctx } = contextAt("const conf");
    const result = source(ctx);
    assert.ok(result, "expected a result");
    assert.equal(result.from, "const ".length, "from must sit at the start of `conf`");
    assert.ok(result.options.length > 0);
    for (const o of result.options) assert.ok(o.label.startsWith("conf"), o.label);
  });

  test("the labels are this index's ranking, in this index's order", () => {
    const docs = setOf(A, B, C);
    const source = completionSource(docs);
    const { ctx } = contextAt("const conf");
    const expected = new Completer(docs.index).complete("const conf", { k: 5 }).filter(isWord);
    assert.deepEqual(
      source(ctx).options.map((o) => o.label),
      expected
    );
  });

  test("boost descends, because an ordering CodeMirror re-sorts is an ordering thrown away", () => {
    const source = completionSource(setOf(A, B, C));
    const { ctx } = contextAt("const c");
    const boosts = source(ctx).options.map((o) => o.boost);
    assert.ok(boosts.length > 1, "need at least two options to check an order");
    for (let i = 1; i < boosts.length; i++) {
      assert.ok(boosts[i] < boosts[i - 1], `boost did not descend: ${boosts.join(", ")}`);
    }
  });

  test("the order it asks for is not the order CodeMirror would have picked alone", () => {
    // A positive control for `boost` carrying information. `configuration` sorts first
    // alphabetically and is the rarest thing here; the index should not lead with it.
    const docs = setOf(
      "const config = 1; config.a; config.b; config.c;",
      "const configuration = 2;",
      "const config = 3; const config2 = 4; config.d;"
    );
    const source = completionSource(docs);
    const labels = source(contextAt("const conf").ctx).options.map((o) => o.label);
    assert.ok(labels.length > 1, `only got ${labels.join(", ")}`);
    assert.notDeepEqual(labels, [...labels].sort(), "the ranking is alphabetical, so boost says nothing");
  });

  test("only identifier-shaped labels are offered", () => {
    const source = completionSource(setOf(A, B, C));
    for (const text of ["const conf", "config.", "function ", "return "]) {
      const result = source(contextAt(text, { explicit: true }).ctx);
      if (!result) continue;
      for (const o of result.options) {
        assert.ok(isWord(o.label), `offered ${JSON.stringify(o.label)} at ${JSON.stringify(text)}`);
      }
    }
  });

  test("no option claims a type, because this package cannot know one", () => {
    const source = completionSource(setOf(A, B, C));
    for (const o of source(contextAt("const conf").ctx).options) {
      assert.ok(!("type" in o), `${o.label} carried a type icon`);
    }
  });

  test("k is honoured", () => {
    const source = completionSource(setOf(A, B, C), { k: 2 });
    assert.ok(source(contextAt("const c").ctx).options.length <= 2);
  });

  test("a full k of identifiers is offered even where punctuation ranks above them", () => {
    // The regression this shares with lexindex-lsp. Asking the index for k and then
    // dropping the punctuation returns fewer than k whenever punctuation ranks highly,
    // which at a `const ` or a `= ` is most of the time: here the narrow ask leaves 2 of
    // the 5 asked for. Asking wide and stopping at k is what fixes it.
    const docs = setOf(A, B, C);
    const source = completionSource(docs, { k: 5 });
    const session = docs.session();
    for (const text of ["const ", "return ", "= "]) {
      const narrow = session.completeScored(text, { k: 5 }).filter((e) => isWord(e.token)).length;
      const offered = source(contextAt(text, { explicit: true }).ctx).options.length;
      assert.equal(offered, 5, `only ${offered} identifiers at ${JSON.stringify(text)}`);
      assert.ok(offered > narrow, `the narrow ask already returned ${narrow}; no regression to catch`);
    }
  });
});

describe("the CodeMirror source — when it stays quiet", () => {
  test("nothing typed and not explicit is null, so the popup does not chase the cursor", () => {
    const source = completionSource(setOf(A, B, C));
    assert.equal(source(contextAt("const ").ctx), null);
    assert.equal(source(contextAt("config.").ctx), null);
  });

  test("nothing typed but explicitly asked for answers, anchored at the cursor", () => {
    const source = completionSource(setOf(A, B, C));
    const text = "const ";
    const result = source(contextAt(text, { explicit: true }).ctx);
    assert.ok(result, "an explicit request deserves an answer");
    assert.equal(result.from, text.length);
  });

  test("minPrefix holds the popup back until enough is typed", () => {
    const source = completionSource(setOf(A, B, C), { minPrefix: 3 });
    assert.equal(source(contextAt("const c").ctx), null);
    assert.equal(source(contextAt("const co").ctx), null);
    assert.ok(source(contextAt("const con").ctx));
    // and an explicit request overrides it
    assert.ok(source(contextAt("const c", { explicit: true }).ctx));
  });

  test("a prefix nothing can match is null rather than an empty popup", () => {
    const source = completionSource(new DocumentSet());
    assert.equal(source(contextAt("zzqqxx").ctx), null);
  });

  test("no validFor, so a further keystroke re-asks instead of filtering a stale list", () => {
    const source = completionSource(setOf(A, B, C));
    assert.ok(!("validFor" in source(contextAt("const conf").ctx)));
  });
});

describe("the CodeMirror source — what it touches, and what it follows", () => {
  test("it reads pos, explicit and state.doc.sliceString, and nothing else", () => {
    const source = completionSource(setOf(A, B, C));
    const { ctx, read } = contextAt("const conf");
    source(ctx); // the Proxy throws if anything else is reached for
    assert.ok(read.includes("context.pos"));
    assert.ok(read.includes("state.doc"));
    assert.ok(read.includes("doc.sliceString"));

    // Nothing outside the documented surface, on this call or on one that has to consult
    // `explicit` -- which a typed prefix long enough to answer never reaches, since the
    // check short-circuits before it.
    const allowed = ["context.explicit", "context.pos", "context.state", "doc.sliceString", "state.doc"];
    const { ctx: bare, read: bareRead } = contextAt("const ", { explicit: true });
    source(bare);
    assert.ok(bareRead.includes("context.explicit"), "an empty prefix must consult explicit");
    for (const surface of new Set([...read, ...bareRead])) {
      assert.ok(allowed.includes(surface), `reached for ${surface}`);
    }
  });

  test("it follows the document set: a tab opened mid-session changes what is offered", () => {
    const docs = setOf(A);
    const source = completionSource(docs);
    const before = source(contextAt("const conf", { explicit: true }).ctx);
    assert.equal(before, null, "nothing open mentions `conf`");

    docs.open("later.js", B);
    const after = source(contextAt("const conf").ctx);
    assert.ok(after && after.options.length > 0, "the newly opened document should be reachable");
  });

  test("it follows the cursor: activating a document takes its text out of the index", () => {
    const docs = setOf(A, B);
    docs.activate("doc1.js"); // B holds the cursor now
    const source = completionSource(docs, { cacheBeta: 0 }); // index only, so this is visible
    assert.equal(source(contextAt("const conf").ctx), null, "B's own words must not come from the index");
  });
});
