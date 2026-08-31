/**
 * The Monaco provider, tested without Monaco installed, for the same reason the CodeMirror
 * source is: this package claims empty `dependencies` and `devDependencies` in its first
 * paragraph, and installing `monaco-editor` to prove an adapter works would disprove the
 * thing the adapter is careful about.
 *
 * The model here is a real one in the only sense that matters — it holds lines and answers
 * `getValueInRange` by honouring the range it is given, 1-based columns and all. That is
 * what makes the range arithmetic testable: a provider that built the "text above the
 * cursor" range wrongly would be handed the wrong text and would rank against it, and a
 * model that ignored the range would hide exactly that bug.
 *
 * The surface is guarded by a Proxy that throws on anything the provider should not touch.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { isWord } from "../src/lex.js";
import { Completer } from "../src/completer.js";
import { DocumentSet } from "../src/documents.js";
import { completionProvider } from "../src/monaco.js";

/** A model that honours the range, and a position, both guarded. */
function editorAt(text, offset = text.length) {
  const read = [];
  const guard = (target, label, allowed) =>
    new Proxy(target, {
      get(t, prop) {
        if (typeof prop === "symbol") return t[prop];
        if (!allowed.includes(prop)) {
          throw new Error(
            `the provider read ${label}.${prop}, which Monaco is not being asked for here.`
          );
        }
        read.push(`${label}.${prop}`);
        return t[prop];
      },
    });

  const lines = text.split("\n");
  const model = guard(
    {
      getValueInRange({ startLineNumber, startColumn, endLineNumber, endColumn }) {
        const out = [];
        for (let ln = startLineNumber; ln <= endLineNumber; ln++) {
          const line = lines[ln - 1] === undefined ? "" : lines[ln - 1];
          const from = ln === startLineNumber ? startColumn - 1 : 0;
          const to = ln === endLineNumber ? endColumn - 1 : line.length;
          out.push(line.slice(from, to));
        }
        return out.join("\n");
      },
    },
    "model",
    ["getValueInRange"]
  );

  // Monaco's line numbers and columns are both 1-based.
  const upto = text.slice(0, offset);
  const lineNumber = upto.split("\n").length;
  const column = offset - (upto.lastIndexOf("\n") + 1) + 1;
  const position = guard({ lineNumber, column }, "position", ["lineNumber", "column"]);

  return { model, position, read };
}

const A = "export function renderWidget(widget) { return widget.name; }";
const B = "const config = loadConfig(); config.enabled = true; config.retries = 3;";
const C = "function loadConfig() { return { enabled: false, retries: 3 }; }";

function setOf(...texts) {
  const docs = new DocumentSet();
  texts.forEach((t, i) => docs.open(`doc${i}.js`, t));
  return docs;
}

describe("the Monaco provider — what it offers", () => {
  test("it is a provider object, and declares no trigger characters", () => {
    const provider = completionProvider(setOf(A, B, C));
    assert.equal(typeof provider.provideCompletionItems, "function");
    assert.ok(
      !("triggerCharacters" in provider),
      "registering `.` would put this in front of member completions, which it loses"
    );
  });

  test("a typed prefix produces suggestions whose range replaces the partial word", () => {
    const provider = completionProvider(setOf(A, B, C));
    const { model, position } = editorAt("const conf");
    const result = provider.provideCompletionItems(model, position);
    assert.ok(result.suggestions.length > 0);
    for (const s of result.suggestions) {
      assert.equal(s.range.startColumn, position.column - "conf".length);
      assert.equal(s.range.endColumn, position.column);
      assert.equal(s.range.startLineNumber, 1);
      assert.equal(s.range.endLineNumber, 1);
      assert.ok(s.label.startsWith("conf"), s.label);
    }
  });

  test("the range arithmetic survives a cursor that is not on the first line", () => {
    const docs = setOf(A, B, C);
    const provider = completionProvider(docs);
    const text = "function first() {\n  const x = 1;\n}\n\nconst conf";
    const { model, position } = editorAt(text);
    assert.equal(position.lineNumber, 5, "the fixture should put the cursor on line 5");

    const result = provider.provideCompletionItems(model, position);
    // If the "text above the cursor" range were built wrongly the model would hand back
    // different text and the ranking would differ from this.
    const expected = new Completer(docs.index).complete(text, { k: 5 }).filter(isWord);
    assert.deepEqual(result.suggestions.map((s) => s.label), expected);
    assert.equal(result.suggestions[0].range.startLineNumber, 5);
    assert.equal(result.suggestions[0].range.startColumn, position.column - "conf".length);
  });

  test("sortText ascends in this index's order, zero padded so 10 follows 9", () => {
    const provider = completionProvider(setOf(A, B, C), { k: 12 });
    const { model, position } = editorAt("const c");
    const items = provider.provideCompletionItems(model, position).suggestions;
    const sorts = items.map((s) => s.sortText);
    assert.deepEqual(sorts, [...sorts].sort(), "sortText must order the way the list does");
    for (const s of sorts) assert.equal(s.length, 4, `not zero padded: ${s}`);
  });

  test("every suggestion carries insertText and filterText", () => {
    const provider = completionProvider(setOf(A, B, C));
    const { model, position } = editorAt("const conf");
    for (const s of provider.provideCompletionItems(model, position).suggestions) {
      assert.equal(s.insertText, s.label);
      assert.equal(s.filterText, s.label);
    }
  });

  test("only identifier-shaped labels are offered", () => {
    const provider = completionProvider(setOf(A, B, C));
    for (const text of ["const conf", "config.", "function ", "return "]) {
      const { model, position } = editorAt(text);
      for (const s of provider.provideCompletionItems(model, position).suggestions) {
        assert.ok(isWord(s.label), `offered ${JSON.stringify(s.label)} at ${JSON.stringify(text)}`);
      }
    }
  });

  test("a full k of identifiers is offered even where punctuation ranks above them", () => {
    const docs = setOf(A, B, C);
    const provider = completionProvider(docs, { k: 5 });
    const session = docs.session();
    for (const text of ["const ", "return ", "= "]) {
      const narrow = session.completeScored(text, { k: 5 }).filter((e) => isWord(e.token)).length;
      const { model, position } = editorAt(text);
      const offered = provider.provideCompletionItems(model, position).suggestions.length;
      assert.equal(offered, 5, `only ${offered} identifiers at ${JSON.stringify(text)}`);
      assert.ok(offered > narrow, `the narrow ask already returned ${narrow}; no regression to catch`);
    }
  });

  test("incomplete is set, so Monaco re-asks rather than filtering a stale list", () => {
    const provider = completionProvider(setOf(A, B, C));
    const { model, position } = editorAt("const conf");
    assert.equal(provider.provideCompletionItems(model, position).incomplete, true);
  });

  test("an empty answer is an empty result, not a throw and not a null", () => {
    const provider = completionProvider(new DocumentSet());
    const { model, position } = editorAt("zzqqxx");
    const result = provider.provideCompletionItems(model, position);
    assert.deepEqual(result, { suggestions: [], incomplete: false });
  });

  test("minPrefix holds it back until enough is typed", () => {
    const provider = completionProvider(setOf(A, B, C), { minPrefix: 3 });
    const short = editorAt("const c");
    assert.deepEqual(provider.provideCompletionItems(short.model, short.position).suggestions, []);
    const enough = editorAt("const con");
    assert.ok(provider.provideCompletionItems(enough.model, enough.position).suggestions.length > 0);
  });
});

describe("the Monaco provider — the kind it will not guess", () => {
  test("with nothing supplied, no suggestion claims a kind at all", () => {
    const provider = completionProvider(setOf(A, B, C));
    const { model, position } = editorAt("const conf");
    for (const s of provider.provideCompletionItems(model, position).suggestions) {
      assert.ok(!("kind" in s), `${s.label} carried a kind nobody supplied`);
    }
  });

  test("it reads Text off the namespace the caller already imported", () => {
    // The shape of the real thing: an enum object whose numbering belongs to Monaco.
    const monaco = { languages: { CompletionItemKind: { Text: 18, Function: 1, Variable: 4 } } };
    const provider = completionProvider(setOf(A, B, C), { monaco });
    const { model, position } = editorAt("const conf");
    for (const s of provider.provideCompletionItems(model, position).suggestions) {
      assert.equal(s.kind, 18);
    }
  });

  test("the number is never written down here: a different enum gives a different kind", () => {
    // A positive control for the paragraph in the header. If this file held a literal,
    // this test would keep passing while the value was wrong for the caller's Monaco.
    const monaco = { languages: { CompletionItemKind: { Text: 7 } } };
    const provider = completionProvider(setOf(A, B, C), { monaco });
    const { model, position } = editorAt("const conf");
    assert.equal(provider.provideCompletionItems(model, position).suggestions[0].kind, 7);
  });

  test("kind can be passed directly, and wins over the namespace", () => {
    const monaco = { languages: { CompletionItemKind: { Text: 18 } } };
    const provider = completionProvider(setOf(A, B, C), { monaco, kind: 27 });
    const { model, position } = editorAt("const conf");
    assert.equal(provider.provideCompletionItems(model, position).suggestions[0].kind, 27);
  });

  test("a namespace without the enum is not a crash", () => {
    const provider = completionProvider(setOf(A, B, C), { monaco: {} });
    const { model, position } = editorAt("const conf");
    const items = provider.provideCompletionItems(model, position).suggestions;
    assert.ok(items.length > 0);
    assert.ok(!("kind" in items[0]));
  });
});

describe("the Monaco provider — what it touches, and what it follows", () => {
  test("it reads getValueInRange, lineNumber and column, and nothing else", () => {
    const provider = completionProvider(setOf(A, B, C));
    const { model, position, read } = editorAt("const conf");
    provider.provideCompletionItems(model, position); // the Proxy throws on anything else
    const surfaces = [...new Set(read)].sort();
    assert.deepEqual(surfaces, ["model.getValueInRange", "position.column", "position.lineNumber"]);
  });

  test("it follows the document set and the cursor", () => {
    const docs = setOf(A);
    const provider = completionProvider(docs);
    const ask = () => {
      const { model, position } = editorAt("const conf");
      return provider.provideCompletionItems(model, position).suggestions;
    };
    assert.deepEqual(ask(), [], "nothing open mentions `conf`");

    docs.open("later.js", B);
    assert.ok(ask().length > 0, "a document opened mid-session should be reachable");

    docs.activate("later.js");
    assert.deepEqual(ask(), [], "and taken back out when it takes the cursor");
  });
});
