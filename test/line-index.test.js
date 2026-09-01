/**
 * The line table: what it remembers, and what it refuses to invent.
 *
 * The behaviour worth pinning is the refusal. A predictor that always answers is easy to
 * write and produces code the corpus never held, which is the one thing an index over
 * your own repository must not do — so "returns null on an unseen context" is asserted
 * first and separately, not folded into a happy path.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import { LineIndex, LINE_CONTEXT, MAX_PER_CONTEXT } from "../src/line-index.js";

/** A file whose second line always follows the same four tokens. */
const REPEATED = [
  "const a = 1;",
  "doThing(a);",
  "const b = 2;",
  "doThing(b);",
].join("\n");

describe("LineIndex", () => {
  test("it retrieves a line that followed this context", () => {
    const ix = new LineIndex();
    ix.addFile("a.js", "const conf = load();\nreturn conf.value;\n");
    ix.finalize();
    const hit = ix.lookup("const conf = load();");
    assert.ok(hit, "expected a hit for a context the file contained");
    assert.equal(hit.text, "return conf.value;");
  });

  test("it returns null for a context it has never seen", () => {
    // The property the whole design rests on: no answer rather than an invented one.
    const ix = new LineIndex();
    ix.addFile("a.js", "const conf = load();\nreturn conf.value;\n");
    ix.finalize();
    assert.equal(ix.lookup("const wobble = quantum(flux);"), null);
  });

  test("it returns null when there is not even a context yet", () => {
    const ix = new LineIndex();
    ix.addFile("a.js", "const conf = load();\nreturn conf.value;\n");
    ix.finalize();
    assert.equal(ix.lookup("const"), null, "fewer than LINE_CONTEXT tokens is not a context");
  });

  test("a hit carries the file and line it came from", () => {
    // Provenance is what makes a suggestion checkable rather than merely convincing.
    const ix = new LineIndex();
    ix.addFile("src/thing.js", "// header\nconst conf = load();\nreturn conf.value;\n");
    ix.finalize();
    const hit = ix.lookup("const conf = load();");
    assert.equal(hit.file, "src/thing.js");
    assert.equal(hit.line, 3, "the retrieved line's own 1-based number in its file");
  });

  test("the most frequent continuation wins, and the count is reported", () => {
    const ix = new LineIndex();
    ix.addFile("a.js", "const x = 1;\nsame();\n");
    ix.addFile("b.js", "const x = 1;\nsame();\n");
    ix.addFile("c.js", "const x = 1;\ndifferent();\n");
    ix.finalize();
    const hit = ix.lookup("const x = 1;");
    assert.equal(hit.text, "same();");
    assert.equal(hit.count, 2);
    assert.equal(hit.total, 3, "total is every observation of this context");
    assert.equal(hit.alternatives, 2, "two distinct lines were seen here");
  });

  test("distinct continuations per context are capped", () => {
    // Without the cap the table grows with the corpus rather than with its repetition.
    const ix = new LineIndex();
    for (let i = 0; i < MAX_PER_CONTEXT + 20; i++) {
      ix.addFile(`f${i}.js`, `const x = 1;\nunique${i}();\n`);
    }
    ix.finalize();
    const hit = ix.lookup("const x = 1;");
    assert.ok(hit, "a capped context still answers");
    assert.equal(hit.alternatives, MAX_PER_CONTEXT, `kept ${hit.alternatives}, cap is ${MAX_PER_CONTEXT}`);
  });

  test("blank lines are not lines", () => {
    const ix = new LineIndex();
    ix.addFile("a.js", "const conf = load();\n\n\nreturn conf.value;\n");
    ix.finalize();
    const hit = ix.lookup("const conf = load();");
    assert.equal(hit.text, "return conf.value;", "the blank lines between are skipped");
  });

  test("the context spans the newline, because a line break is not a token", () => {
    const ix = new LineIndex();
    ix.addFile("a.js", REPEATED);
    ix.finalize();
    // "const a = 1 ;" is four tokens plus one; the tail is what keys the next line.
    const hit = ix.lookup("const a = 1;");
    assert.ok(hit, "a context ending at a line break still resolves");
    assert.equal(hit.text, "doThing(a);");
  });

  test("stats report what the table holds", () => {
    const ix = new LineIndex();
    ix.addFile("a.js", REPEATED);
    ix.finalize();
    const s = ix.stats();
    assert.equal(s.files, 1);
    assert.ok(s.contexts > 0, "expected at least one context");
    assert.ok(s.lines > 0, "expected at least one indexed line");
  });

  test("LINE_CONTEXT matches the completer's order-5 model", () => {
    // Four tokens of context is the same window the count model conditions on; a line
    // table keyed on a different width would answer about a different question.
    assert.equal(LINE_CONTEXT, 4);
  });
});
