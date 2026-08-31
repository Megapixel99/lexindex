/**
 * `DocumentSet` keeps an index over the open documents by adding and subtracting one
 * document at a time, which is the same bet `updateIndexFile` makes and needs the same
 * proof: the result must be EXACTLY a rebuilt index, not an approximation of one. So most
 * of what follows compares the whole count table against a model built from scratch over
 * the documents that should be in it.
 *
 * The other half is the active-document rule. The document holding the cursor is kept out
 * of the index on purpose — the cache half of the blend already serves it, and serves it
 * without seeing the text below the cursor, which is what every published accuracy here
 * was measured with. A bug that let the active document into the index would raise the
 * numbers and would be nearly invisible in a suggestion list, so it is asserted directly
 * rather than inferred from behaviour.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { lex } from "../src/lex.js";
import { CountModel, recitalBand } from "../src/count-model.js";
import { Completer } from "../src/completer.js";
import { DocumentSet } from "../src/documents.js";

/** A total ordering of everything a model counted, so two models can be compared. */
function dump(m) {
  const parts = [`tokens=${m.nTokens}`, `files=${m.nFiles}`];
  for (const tab of m.tabs) {
    const rows = [...tab]
      .map(
        ([ctx, counts]) =>
          ctx +
          " => " +
          [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map((e) => e.join(":")).join(",")
      )
      .sort();
    parts.push(rows.join("|"));
  }
  return parts.join("\n");
}

/** What the index SHOULD hold: a from-scratch model over exactly these texts. */
function rebuilt(...texts) {
  const m = new CountModel(5);
  for (const t of texts) {
    const toks = lex(t);
    if (toks.length) m.addFileTokens(toks);
  }
  return m.finalize();
}

const A = "export function renderWidget(widget) { return widget.name; }";
const B = "const config = loadConfig(); config.enabled = true;";
const C = "function loadConfig() { return { enabled: false, retries: 3 }; }";
const D = "for (const item of items) { console.log(item.id, item.name); }";

describe("DocumentSet — an index over the documents somebody has open", () => {
  test("an empty set predicts nothing and is still safe to complete against", () => {
    const docs = new DocumentSet();
    assert.equal(docs.size, 0);
    // beta 0 is the index alone, so with nothing open there is nothing to say.
    assert.deepEqual(docs.completer({ cacheBeta: 0 }).complete("const conf"), []);
  });

  test("opening documents builds exactly the index a rebuild would", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B).open("c.js", C);
    assert.equal(docs.size, 3);
    assert.equal(dump(docs.index), dump(rebuilt(A, B, C)));
  });

  test("re-opening a document with new text replaces its counts rather than adding them", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B);
    docs.open("b.js", D);
    assert.equal(docs.size, 2);
    assert.equal(dump(docs.index), dump(rebuilt(A, D)));
  });

  test("closing a document takes its counts with it", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B).open("c.js", C);
    docs.close("b.js");
    assert.equal(docs.size, 2);
    assert.equal(dump(docs.index), dump(rebuilt(A, C)));
  });

  test("closing something that was never open changes nothing", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A);
    const before = dump(docs.index);
    docs.close("nope.js");
    assert.equal(dump(docs.index), before);
    assert.equal(docs.size, 1);
  });

  test("an empty document is open, and contributes nothing to count", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("empty.js", "");
    assert.equal(docs.size, 2);
    assert.equal(dump(docs.index), dump(rebuilt(A)));
  });

  test("emptying a document that had text subtracts what it had", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B);
    docs.open("b.js", "");
    assert.equal(dump(docs.index), dump(rebuilt(A)));
  });
});

describe("DocumentSet — the document holding the cursor is not in the index", () => {
  test("activating a document removes it from the index", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B).open("c.js", C);
    docs.activate("b.js");
    assert.equal(docs.size, 3, "it is still open");
    assert.equal(dump(docs.index), dump(rebuilt(A, C)), "it is not indexed");
  });

  test("the tokens of the active document are genuinely absent, not merely outranked", () => {
    const docs = new DocumentSet();
    docs.open("only.js", "const renderWidgetTwice = 1;");
    docs.activate("only.js");
    // Nothing else is open, so the index is empty and beta 0 has nothing to offer.
    assert.equal(docs.index.nTokens, 0);
    assert.deepEqual(docs.completer({ cacheBeta: 0 }).complete("const renderWidget"), []);
  });

  test("moving the cursor puts the document it left back in and takes the new one out", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B).open("c.js", C);
    docs.activate("b.js");
    docs.activate("c.js");
    assert.equal(dump(docs.index), dump(rebuilt(A, B)));
  });

  test("activating null puts every document back in", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B);
    docs.activate("a.js");
    docs.activate(null);
    assert.equal(dump(docs.index), dump(rebuilt(A, B)));
  });

  test("activating the same document twice is not two subtractions", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B);
    docs.activate("a.js");
    docs.activate("a.js");
    assert.equal(dump(docs.index), dump(rebuilt(B)));
  });

  test("a document opened while it already holds the cursor is not indexed", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A);
    docs.activate("b.js"); // the editor knows the tab before it hands over the text
    docs.open("b.js", B);
    assert.equal(dump(docs.index), dump(rebuilt(A)));
    // and it joins the index the moment the cursor leaves
    docs.activate("a.js");
    assert.equal(dump(docs.index), dump(rebuilt(B)));
  });

  test("editing the active document does not disturb the index", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B);
    docs.activate("b.js");
    const before = dump(docs.index);
    docs.open("b.js", B + " " + D);
    docs.open("b.js", D);
    assert.equal(dump(docs.index), before, "keystrokes in the buffer cost the index nothing");
    docs.activate(null);
    assert.equal(dump(docs.index), dump(rebuilt(A, D)), "and the latest text is what joins");
  });

  test("closing the active document leaves the rest of the index intact", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B).open("c.js", C);
    docs.activate("b.js");
    docs.close("b.js");
    assert.equal(docs.size, 2);
    assert.equal(docs.activeId, null);
    assert.equal(dump(docs.index), dump(rebuilt(A, C)));
  });

  test("a long sequence of opens, edits, closes and cursor moves still equals a rebuild", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A);
    docs.activate("a.js");
    docs.open("b.js", B);
    docs.open("c.js", C);
    docs.activate("c.js");
    docs.open("a.js", A + " " + D);
    docs.close("b.js");
    docs.open("d.js", D);
    docs.activate("d.js");
    docs.open("c.js", C + " " + B);
    docs.close("c.js");
    docs.activate(null);
    // open at the end: a.js (A + D) and d.js (D)
    assert.equal(dump(docs.index), dump(rebuilt(A + " " + D, D)));
  });
});

describe("DocumentSet — what an editor holds on to", () => {
  test("a session survives opens, closes and cursor moves and stays exact", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B);
    const session = docs.session();

    const at = (text) => session.complete(text, { k: 5 });
    const fresh = (text) => new Completer(docs.index).complete(text, { k: 5 });

    assert.deepEqual(at("const conf"), fresh("const conf"));
    docs.open("c.js", C);
    assert.deepEqual(at("const conf"), fresh("const conf"));
    docs.activate("b.js");
    assert.deepEqual(at("const conf"), fresh("const conf"));
    docs.close("a.js");
    assert.deepEqual(at("const conf"), fresh("const conf"));
  });

  test("the recital rate is the index's, and moves as documents open", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A);
    const alone = docs.recital(A);
    docs.open("b.js", B).open("c.js", C).open("d.js", D);
    const together = docs.recital(A);
    assert.ok(alone >= 0 && alone <= 1, `rate out of range: ${alone}`);
    assert.ok(together >= alone, "opening documents that repeat it cannot lower it");
  });

  test("open, close and activate all return the set, so they chain", () => {
    const docs = new DocumentSet();
    assert.equal(docs.open("a.js", A), docs);
    assert.equal(docs.activate("a.js"), docs);
    assert.equal(docs.close("a.js"), docs);
  });
});

describe("DocumentSet — the corpus hygiene the file walker does", () => {
  const HUGE = "const filler = 1; ".repeat(30_000); // ~540k characters

  test("a document past the ceiling is open, and is not in the index", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("bundle.js", HUGE);
    assert.equal(docs.size, 2, "it is open; the editor has it");
    assert.equal(docs.excluded.get("bundle.js"), "size");
    assert.equal(dump(docs.index), dump(rebuilt(A)));
  });

  test("and is not even lexed, which is the cost the ceiling exists to avoid", () => {
    const docs = new DocumentSet();
    docs.open("bundle.js", HUGE);
    assert.deepEqual(docs.tokens.get("bundle.js"), []);
  });

  test("the ceiling is where collectFiles puts it, and can be moved", () => {
    const roomy = new DocumentSet({ maxLength: 10_000_000 });
    roomy.open("bundle.js", HUGE);
    assert.equal(roomy.excluded.has("bundle.js"), false);
    assert.ok(roomy.index.nTokens > 0);

    const strict = new DocumentSet({ maxLength: 10 });
    strict.open("a.js", A);
    assert.equal(strict.excluded.get("a.js"), "size");
  });

  test("a document that grows past the ceiling is taken back out", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("b.js", B);
    assert.equal(dump(docs.index), dump(rebuilt(A, B)));
    docs.open("b.js", HUGE);
    assert.equal(dump(docs.index), dump(rebuilt(A)));
    docs.open("b.js", B);
    assert.equal(dump(docs.index), dump(rebuilt(A, B)), "and back in when it shrinks");
  });

  test("generated code is flagged and still indexed, which is the CLI's posture", () => {
    const gen = "// Code generated by protoc. DO NOT EDIT.\nconst wire = 1; const wire2 = 2;";
    const docs = new DocumentSet();
    docs.open("a.js", A).open("api_pb.js", gen);
    assert.ok(docs.generated.has("api_pb.js"), "it should be counted");
    assert.equal(docs.excluded.has("api_pb.js"), false, "nothing is excluded on this by default");
    assert.equal(dump(docs.index), dump(rebuilt(A, gen)));
  });

  test("skipGenerated excludes it, and says so through the same door as the ceiling", () => {
    const gen = "// Code generated by protoc. DO NOT EDIT.\nconst wire = 1;";
    const docs = new DocumentSet({ skipGenerated: true });
    docs.open("a.js", A).open("api_pb.js", gen);
    assert.ok(docs.generated.has("api_pb.js"));
    assert.equal(docs.excluded.get("api_pb.js"), "generated");
    assert.equal(dump(docs.index), dump(rebuilt(A)));
  });

  test("an excluded document stays out across a cursor move", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).open("bundle.js", HUGE);
    docs.activate("bundle.js");
    assert.equal(dump(docs.index), dump(rebuilt(A)));
    docs.activate("a.js");
    assert.equal(dump(docs.index), dump(rebuilt()), "leaving it does not let it in");
  });

  test("closing an excluded document clears what was recorded about it", () => {
    const docs = new DocumentSet({ skipGenerated: true });
    docs.open("bundle.js", HUGE);
    docs.open("api_pb.js", "// @generated\nconst wire = 1;");
    docs.close("bundle.js");
    docs.close("api_pb.js");
    assert.equal(docs.excluded.size, 0);
    assert.equal(docs.generated.size, 0);
    assert.equal(docs.size, 0);
  });
});

describe("DocumentSet — saying what it is doing", () => {
  test("the recital rate is reported as a document opens, the way the server logs it", () => {
    const seen = [];
    const docs = new DocumentSet({ onRecital: (e) => seen.push(e) });
    docs.open("a.js", A);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, "a.js");
    assert.equal(seen[0].reason, "open");
    assert.ok(seen[0].rate >= 0 && seen[0].rate <= 1);
    assert.equal(seen[0].band, recitalBand(seen[0].rate));
  });

  test("and again when a document takes the cursor, which is when the number matters", () => {
    const seen = [];
    const docs = new DocumentSet({ onRecital: (e) => seen.push(e) });
    docs.open("a.js", A).open("b.js", B);
    seen.length = 0;
    docs.activate("b.js");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, "b.js");
    assert.equal(seen[0].reason, "activate");
  });

  test("but not on every keystroke: re-opening with new text is an edit, not an open", () => {
    const seen = [];
    const docs = new DocumentSet({ onRecital: (e) => seen.push(e) });
    docs.open("a.js", A);
    seen.length = 0;
    docs.open("a.js", A + " const more = 1;");
    docs.open("a.js", A + " const more = 12;");
    assert.deepEqual(seen, []);
  });

  test("nothing is reported for a document too short to be scored on any position", () => {
    const seen = [];
    const docs = new DocumentSet({ onRecital: (e) => seen.push(e) });
    docs.open("tiny.js", "a = 1");
    assert.deepEqual(seen, [], "a rate of 0 from zero positions is not a rate");
  });

  test("an excluded document says so, rather than being quietly absent", () => {
    const seen = [];
    const docs = new DocumentSet({ onExcluded: (e) => seen.push(e) });
    const huge = "const filler = 1; ".repeat(30_000);
    docs.open("bundle.js", huge);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].id, "bundle.js");
    assert.equal(seen[0].reason, "size");
    assert.equal(seen[0].length, huge.length);
  });

  test("neither callback is required, and neither costs anything when absent", () => {
    const docs = new DocumentSet();
    docs.open("a.js", A).activate("a.js");
    docs.open("bundle.js", "x".repeat(500_000));
    assert.equal(docs.size, 2);
  });
});
