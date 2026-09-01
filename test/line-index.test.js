/**
 * The line table: what it remembers, what it refuses to invent, and what it refuses to
 * say out loud when it is only guessing.
 *
 * The behaviour worth pinning is the refusal, and there are now two of them: a context
 * nobody has ever written, and a context whose continuations disagree too much to call.
 * Both are asserted first and separately, not folded into a happy path — a predictor that
 * always answers is easy to write and produces code the corpus never held, which is the
 * one thing an index over your own repository must not do.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import {
  LineIndex,
  localIndex,
  LINE_WIDTHS,
  LINE_CONTEXT,
  MAX_PER_CONTEXT,
  DEFAULT_MIN_CONFIDENCE,
} from "../src/line-index.js";

/** A file whose second line always follows the same tokens. */
const REPEATED = ["const a = 1;", "doThing(a);", "const b = 2;", "doThing(b);"].join("\n");

/** Indexed once and reused; nothing below mutates it. */
function indexOf(...files) {
  const ix = new LineIndex();
  for (const [name, text] of files) ix.addFile(name, text);
  return ix.finalize();
}

describe("LineIndex — refusing", () => {
  test("it returns null for a context it has never seen", () => {
    // The property the whole design rests on: no answer rather than an invented one.
    const ix = indexOf(["a.js", "const conf = load();\nreturn conf.value;\n"]);
    assert.equal(ix.lookup("const wobble = quantum(flux);"), null);
  });

  test("it returns null when there is not even a context yet", () => {
    const ix = indexOf(["a.js", "const conf = load();\nreturn conf.value;\n"]);
    assert.equal(ix.lookup("const"), null, "fewer tokens than the narrowest width is not a context");
  });

  test("it withholds a candidate that does not clear the confidence bar", () => {
    // Six files, six different continuations of the same context: something is always
    // "most frequent", and saying it would be a guess dressed as a retrieval.
    const ix = indexOf(
      ...Array.from({ length: 6 }, (_, i) => [`f${i}.js`, `const x = 1;\nbranch${i}();\n`]),
    );
    assert.equal(ix.lookup("const x = 1;"), null, "a six-way tie is not an answer");
    // ...but the candidates are still there for a caller that wants to offer a list.
    const near = ix.candidates("const x = 1;");
    assert.equal(near.length, 6);
    assert.ok(near[0].confidence < DEFAULT_MIN_CONFIDENCE, `confidence was ${near[0].confidence}`);
  });

  test("minConfidence 0 answers where the default abstains", () => {
    const ix = indexOf(
      ...Array.from({ length: 6 }, (_, i) => [`f${i}.js`, `const x = 1;\nbranch${i}();\n`]),
    );
    const hit = ix.lookup("const x = 1;", { minConfidence: 0 });
    assert.ok(hit, "the floor is the only thing that was withholding this");
    assert.match(hit.text, /^branch\d\(\);$/);
  });
});

describe("LineIndex — retrieving", () => {
  test("it retrieves a line that followed this context", () => {
    const ix = indexOf(["a.js", "const conf = load();\nreturn conf.value;\n"]);
    const hit = ix.lookup("const conf = load();");
    assert.ok(hit, "expected a hit for a context the file contained");
    assert.equal(hit.text, "return conf.value;");
  });

  test("a hit carries the file and line it came from", () => {
    // Provenance is what makes a suggestion checkable rather than merely convincing.
    const ix = indexOf(["src/thing.js", "// header\nconst conf = load();\nreturn conf.value;\n"]);
    const hit = ix.lookup("const conf = load();");
    assert.equal(hit.file, "src/thing.js");
    assert.equal(hit.line, 3, "the retrieved line's own 1-based number in its file");
  });

  test("the most agreed-on continuation wins, and confidence is reported", () => {
    const ix = indexOf(
      ["a.js", "const x = 1;\nsame();\n"],
      ["b.js", "const x = 1;\nsame();\n"],
      ["c.js", "const x = 1;\ndifferent();\n"],
    );
    const hit = ix.lookup("const x = 1;");
    assert.equal(hit.text, "same();");
    assert.equal(hit.count, 2);
    assert.equal(hit.alternatives, 2, "two distinct lines were seen here");
    assert.ok(hit.confidence > 0.5, `a 2-to-1 majority should read as confident, got ${hit.confidence}`);
  });

  test("confidence is a share, so it sums to one across the candidates", () => {
    const ix = indexOf(
      ["a.js", "const x = 1;\nsame();\n"],
      ["b.js", "const x = 1;\nsame();\n"],
      ["c.js", "const x = 1;\ndifferent();\n"],
    );
    const total = ix.candidates("const x = 1;").reduce((s, c) => s + c.confidence, 0);
    assert.ok(Math.abs(total - 1) < 1e-9, `shares summed to ${total}`);
  });

  test("blank lines are not lines", () => {
    const ix = indexOf(["a.js", "const conf = load();\n\n\nreturn conf.value;\n"]);
    assert.equal(ix.lookup("const conf = load();").text, "return conf.value;");
  });

  test("the context spans the newline, because a line break is not a token", () => {
    const ix = indexOf(["a.js", REPEATED]);
    const hit = ix.lookup("const a = 1;");
    assert.ok(hit, "a context ending at a line break still resolves");
    assert.equal(hit.text, "doThing(a);");
  });

  test("distinct continuations per context are capped", () => {
    // Without the cap the table grows with the corpus rather than with its repetition.
    const ix = indexOf(
      ...Array.from({ length: MAX_PER_CONTEXT + 20 }, (_, i) => [`f${i}.js`, `const x = 1;\nunique${i}();\n`]),
    );
    const near = ix.candidates("const x = 1;");
    assert.equal(near.length, MAX_PER_CONTEXT, `kept ${near.length}, cap is ${MAX_PER_CONTEXT}`);
  });
});

describe("LineIndex — every width votes", () => {
  test("a narrower width still contributes when the widest matches nothing", () => {
    // `const x = 1 ;` is five tokens, so a six-token context has nothing to key on here.
    // If only the widest matching width were consulted this would return nothing at all.
    const ix = indexOf(["a.js", "const x = 1;\nafter();\n"]);
    const hit = ix.lookup("let z = 0;\nconst x = 1;", { minConfidence: 0 });
    assert.ok(hit, "width 4 and 5 agreed even though width 6 had no entry");
    assert.equal(hit.text, "after();");
  });

  test("matching at two widths outranks matching at one, with counts tied", () => {
    // Both candidates were seen exactly once, so frequency cannot separate them. `alpha`
    // matches the four- AND five-token tail; `beta` only the four-token one. Summing
    // across widths is what breaks the tie -- a single-width lookup would coin-flip it.
    const ix = indexOf(
      ["a.js", "const x = 1;\nalpha();\n"],
      ["b.js", "let x = 1;\nbeta();\n"],
    );
    const ranked = ix.candidates("const x = 1;");
    assert.equal(ranked.length, 2, "both are candidates at width 4");
    assert.equal(ranked[0].count, ranked[1].count, "counts are tied, so this is not frequency");
    assert.equal(ranked[0].text, "alpha();", "the one that also matched at width 5 wins");
  });

  test("LINE_CONTEXT is the narrowest width that votes", () => {
    // Four tokens is what the order-5 count model conditions on, and nothing narrower is
    // consulted: a two-token tail is usually `) ;`, which matches almost any line and
    // would leave this index unable to say it had never seen a context.
    assert.equal(LINE_CONTEXT, 4);
    assert.equal(Math.min(...LINE_WIDTHS), LINE_CONTEXT, `${LINE_WIDTHS} should start at ${LINE_CONTEXT}`);
  });

  test("stats report what the table holds, across every width", () => {
    const ix = indexOf(["a.js", REPEATED]);
    const s = ix.stats();
    assert.equal(s.files, 1);
    assert.equal(s.widths, LINE_WIDTHS.length);
    assert.ok(s.contexts > 0, "expected at least one context");
    assert.ok(s.lines > 0, "expected at least one indexed line");
  });
});

describe("localIndex — the buffer is a corpus too", () => {
  test("a line repeated in the buffer is retrievable when the corpus never had it", () => {
    const corpus = indexOf(["far.js", "unrelated();\nthings();\nhappen();\nhere();\n"]);
    const buffer = "const t = trace();\nemit(t);\nconst t = trace();\n";
    assert.equal(corpus.lookup("const t = trace();"), null, "the corpus has never seen this");
    const hit = corpus.lookup(buffer, { local: localIndex(buffer) });
    assert.ok(hit, "the buffer above the cursor has seen it, and that counts");
    assert.equal(hit.text, "emit(t);");
    assert.equal(hit.file, "<buffer>", "provenance says where it actually came from");
  });

  test("the local model does not leak the line being predicted", () => {
    // localIndex is built from the text ABOVE the cursor, so the answer cannot be in it.
    // If this ever regressed, every benchmark built on it would silently read as perfect.
    const above = "const t = trace();\n";
    assert.equal(localIndex(above).lookup("const t = trace();", { minConfidence: 0 }), null);
  });

  test("corpus and buffer vote together rather than one overriding the other", () => {
    const corpus = indexOf(
      ["a.js", "const x = 1;\ncorpusLine();\n"],
      ["b.js", "const x = 1;\ncorpusLine();\n"],
      ["c.js", "const x = 1;\ncorpusLine();\n"],
    );
    const buffer = "const x = 1;\nbufferLine();\nsomething();\nconst x = 1;\n";
    const both = corpus.candidates(buffer, { local: localIndex(buffer) }).map((c) => c.text);
    assert.ok(both.includes("corpusLine();"), "the corpus still has a say");
    assert.ok(both.includes("bufferLine();"), "so does the buffer");
  });
});
