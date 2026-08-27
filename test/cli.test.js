/**
 * The CLI and the on-disk build path, exercised as a user reaches them.
 *
 * These run the real binary in a child process against a real temporary tree rather than
 * calling the functions behind it. The CLI is the surface an editor plugin talks to, and
 * an exit code or a JSON shape that changed without anyone noticing is exactly the kind of
 * break the unit tests above cannot see.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex, updateIndexFile, collectFiles } from "../src/build.js";
import { resolveLanguages, LANGUAGES, LANGUAGE_NAMES } from "../src/languages.js";
import { isLikelyGenerated, hasGeneratedName } from "../src/generated.js";
import { Completer } from "../src/completer.js";
import { lex } from "../src/lex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "lexindex.js");
const MEASURE = path.join(here, "..", "tools", "measure.mjs");
const REPO = path.join(here, "..");

let dir;
const FILES = {
  "alpha.js": "export function renderWidget(widget) { return widget.name; }\nrenderWidget(null);\n",
  "beta.js": "import { renderWidget } from './alpha.js';\nexport const widgetCount = 2;\nrenderWidget(widgetCount);\n",
  "gamma.js": "export function renderPanel(panel) { return panel.title; }\nrenderPanel({ title: 'x' });\n",
  "notes.md": "renderWidget is documented here but markdown is not indexed.\n",
};

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-test-"));
  for (const [name, body] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(dir, name), body);
  }
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run the CLI and capture all three of stdout, stderr and the exit code.
 *
 * spawnSync rather than execFileSync because a non-zero exit is a documented outcome
 * here, not an exception, and because the recital rate is written to stderr — which
 * execFileSync's return value drops on the floor.
 */
function run(args, input) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    input: input === undefined ? "" : input,
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

describe("collectFiles / buildIndex", () => {
  test("indexes the js files and leaves the markdown alone", () => {
    const built = buildIndex(dir);
    assert.equal(built.files, 3);
    assert.equal(built.candidates, 3, "a file the extension pattern rejects is never a candidate");
    assert.ok(built.tokens > 0);
  });

  test("--exclude style predicates drop files from the corpus", () => {
    const built = buildIndex(dir, { exclude: (f) => f.endsWith("gamma.js") });
    assert.equal(built.files, 2);
    assert.equal(built.skipped, 1);
    assert.equal(built.files + built.skipped, built.candidates, "every candidate is accounted for");
  });
});

describe("updateIndexFile — a long-lived process keeping up with edits", () => {
  test("it refuses rather than silently double-counting when tokens were not retained", () => {
    const built = buildIndex(dir);
    assert.throws(() => updateIndexFile(built, path.join(dir, "alpha.js")), /retainFileTokens/);
  });

  test("an edit on disk reaches the suggestions without a rebuild", () => {
    const built = buildIndex(dir, { retainFileTokens: true });
    const target = path.join(dir, "gamma.js");
    const original = fs.readFileSync(target, "utf8");
    try {
      const before = new Completer(built.index, { cacheBeta: 0 }).suggest(["export", "function"], { k: 5 });
      assert.ok(!before.includes("renderTooltip"));

      fs.writeFileSync(target, "export function renderTooltip(t) { return t; }\nrenderTooltip(1);\n");
      const r = updateIndexFile(built, target);
      assert.equal(r.action, "updated");

      const after = new Completer(built.index, { cacheBeta: 0 }).suggest(["export", "function"], { k: 5 });
      assert.ok(after.includes("renderTooltip"), `got ${JSON.stringify(after)}`);
      assert.ok(!after.includes("renderPanel"), "the name that was replaced is gone from the corpus");
      assert.equal(built.files, 3, "an edit is not a new file");
    } finally {
      fs.writeFileSync(target, original);
      updateIndexFile(built, target);
    }
  });

  test("passing the text directly indexes an unsaved buffer", () => {
    const built = buildIndex(dir, { retainFileTokens: true });
    updateIndexFile(built, path.join(dir, "alpha.js"), "const unsavedIdentifier = 1; unsavedIdentifier;");
    const out = new Completer(built.index, { cacheBeta: 0 }).suggest(["const"], { k: 5 });
    assert.ok(out.includes("unsavedIdentifier"), `got ${JSON.stringify(out)}`);
  });

  test("a new file, then its deletion, move the file count both ways", () => {
    const built = buildIndex(dir, { retainFileTokens: true });
    const fresh = path.join(dir, "delta.js");
    assert.equal(updateIndexFile(built, fresh, "export const brandNewThing = 1;").action, "added");
    assert.equal(built.files, 4);
    assert.equal(updateIndexFile(built, fresh, null).action, "removed");
    assert.equal(built.files, 3);
    assert.equal(updateIndexFile(built, fresh, null).action, "unchanged", "removing it twice is not an error");
  });

  test("an index kept current by updates matches one built from the same tree", () => {
    const built = buildIndex(dir, { retainFileTokens: true });
    const extra = path.join(dir, "epsilon.js");
    fs.writeFileSync(extra, "export function renderChart(series) { return series.length; }\n");
    try {
      updateIndexFile(built, extra);
      const scratch = buildIndex(dir);
      assert.equal(built.index.nTokens, scratch.index.nTokens);
      assert.equal(built.index.nFiles, scratch.index.nFiles);
      assert.deepEqual(
        new Completer(built.index, { cacheBeta: 0 }).suggest(["export", "function"], { k: 5 }),
        new Completer(scratch.index, { cacheBeta: 0 }).suggest(["export", "function"], { k: 5 })
      );
    } finally {
      fs.rmSync(extra, { force: true });
    }
  });
});

describe("the CLI", () => {
  test("--stats reports the index and exits 0", () => {
    const r = run([dir, "--stats"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /files\s+: 3 of 3 candidates/);
    assert.match(r.stdout, /COMPLETE/);
  });

  test("no position at all is a stats run, not an error", () => {
    assert.equal(run([dir]).status, 0);
  });

  test("--at <file>:<line>:<col> completes at a 1-based line and column", () => {
    // beta.js line 3 is `renderWidget(widgetCount);`; stop after `render`.
    const r = run([dir, "--at", `${path.join(dir, "beta.js")}:3:7`, "-k", "5"]);
    assert.equal(r.status, 0);
    const out = r.stdout.trim().split("\n");
    assert.ok(out.includes("renderWidget"), `got ${JSON.stringify(out)}`);
    assert.ok(out.every((w) => w.startsWith("render")), "the partial word must filter the list");
  });

  test("--at <file>:<offset> still means a byte offset", () => {
    const r = run([dir, "--at", `${path.join(dir, "beta.js")}:10`, "-k", "3"]);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().length > 0);
  });

  test("--stdin completes a buffer that was never written to disk", () => {
    const r = run([dir, "--stdin", "-k", "5"], "const widgetCount = 1;\nconst other = widgetC");
    assert.equal(r.status, 0);
    assert.ok(r.stdout.trim().split("\n").includes("widgetCount"), r.stdout);
  });

  test("the recital rate is reported alongside every suggestion, on stderr", () => {
    const r = run([dir, "--stdin"], "const render");
    assert.match(r.stderr, /recital \d+\.\d%/);
    assert.ok(!r.stdout.includes("recital"), "stdout stays parseable as a plain list of tokens");
  });

  test("--json emits one object with the suggestions, their scores and the band", () => {
    const r = run([dir, "--stdin", "--json", "-k", "3"], "const render");
    assert.equal(r.status, 0);
    const o = JSON.parse(r.stdout);
    assert.ok(Array.isArray(o.suggestions));
    assert.deepEqual(o.suggestions, o.scored.map((e) => e.token));
    assert.equal(typeof o.recital, "number");
    assert.equal(typeof o.band, "string");
    assert.equal(o.index.files, 3);
    for (const e of o.scored) assert.equal(typeof e.score, "number");
  });

  test("--recital answers the question the README says to ask first", () => {
    const r = run([dir, "--recital", path.join(dir, "beta.js")]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /recital\s+: \d+\.\d%/);
  });

  test("--beta 0 is the repo alone and --beta 1 is the buffer alone", () => {
    const buffer = "const zephyrCounter = 0;\nzephyrCounter += 1;\nconst z";
    const repoOnly = run([dir, "--stdin", "--beta", "0", "-k", "5"], buffer);
    const bufferOnly = run([dir, "--stdin", "--beta", "1", "-k", "5"], buffer);
    assert.ok(!repoOnly.stdout.includes("zephyrCounter"), "the repo has never seen this name");
    assert.ok(bufferOnly.stdout.includes("zephyrCounter"), "the buffer has, twice");
  });

  test("--exclude narrows the corpus", () => {
    const r = run([dir, "--exclude", "gamma", "--stats"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /files\s+: 2 of 3 candidates/);
  });

  test("--ext widens it to files the default pattern ignores", () => {
    const r = run([dir, "--ext", "\\.(js|md)$", "--stats"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /files\s+: 4 of 4 candidates/);
  });

  // Exit codes are a documented interface here, so they get asserted like one.
  test("an empty index exits 2 rather than reporting a confident nothing", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-empty-"));
    try {
      const r = run([empty, "--stats"]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /indexed 0 files/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  test("an unknown option is refused instead of being treated as a directory", () => {
    const r = run([dir, "--not-a-flag"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown option/);
  });

  test("a flag missing its value is refused rather than eating the next flag", () => {
    const r = run([dir, "--at"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /wants a value/);
  });

  test("an out-of-range --beta or -k is refused", () => {
    assert.equal(run([dir, "--stdin", "--beta", "7"], "const x").status, 2);
    assert.equal(run([dir, "--stdin", "-k", "0"], "const x").status, 2);
  });

  test("an unreadable --at file exits 2 and says which file", () => {
    const r = run([dir, "--at", `${path.join(dir, "nope.js")}:1:1`]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot read/);
  });

  test("a line past the end of the file is clamped and said out loud", () => {
    const r = run([dir, "--at", `${path.join(dir, "beta.js")}:9999:1`]);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /past the end of the file/);
  });

  test("--help exits 0 and lists the options", () => {
    const r = run(["--help"]);
    assert.equal(r.status, 0);
    for (const flag of ["--at", "--stdin", "--json", "--beta", "--recital"]) {
      assert.ok(r.stdout.includes(flag), `--help does not mention ${flag}`);
    }
  });

  test("no arguments prints usage and exits 2", () => {
    assert.equal(run([]).status, 2);
  });
});

/**
 * The harness is the thing the README tells people to run, and CI gates on it reaching a
 * verdict. Until now nothing checked that it still does.
 */
describe("the measurement harness", () => {
  function measure(args) {
    const r = spawnSync(process.execPath, [MEASURE, ...args], { encoding: "utf8" });
    if (r.error) throw r.error;
    return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
  }

  test("it reaches a verdict on this repository", () => {
    const r = measure([path.join(REPO, "src"), path.join(REPO, "tools"), path.join(REPO, "test")]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /RECITAL: [\d.]+%/);
    assert.match(r.stdout, /COMPLETE : \d+ positions scored/);
  });

  test("it reports the re-ranking use, or says why it cannot", () => {
    const r = measure([path.join(REPO, "src"), path.join(REPO, "tools"), path.join(REPO, "test")]);
    assert.match(r.stdout, /RE-RANKING the list your editor would offer/);
    // On a corpus this small it should refuse rather than print a number from a handful
    // of positions. Either outcome is legitimate; silence is not.
    assert.ok(
      /CANNOT SUPPORT A NUMBER/.test(r.stdout) || /reordered by this index/.test(r.stdout),
      "the re-ranking section neither reported nor refused"
    );
  });

  test("--json puts one parseable object on stdout and no prose beside it", () => {
    const r = measure(["--json", path.join(REPO, "src"), path.join(REPO, "tools"), path.join(REPO, "test")]);
    assert.equal(r.status, 0);
    const o = JSON.parse(r.stdout); // throws if any human-readable line leaked onto stdout
    assert.equal(typeof o.recital, "number");
    assert.ok(o.index.files > 0);
    assert.ok(o.positions.scored > 0);
    assert.ok(o.rerank, "the re-ranking measurement is missing from the JSON");
    assert.ok(
      typeof o.rerank.refused === "string" || o.rerank.orderings,
      "the JSON must carry either the re-ranking numbers or the reason there are none"
    );
    for (const key of ["arms", "paired", "complete", "corpus"]) assert.ok(key in o, `missing ${key}`);
  });

  test("the re-ranking exclusions are counted and reported, not buried", () => {
    const r = measure(["--json", path.join(REPO, "src"), path.join(REPO, "tools"), path.join(REPO, "test")]);
    const { rerank } = JSON.parse(r.stdout);
    // A single-candidate list makes every ordering right; leaving those in would inflate
    // every row equally and the comparison with them.
    assert.equal(typeof rerank.droppedSingleCandidate, "number");
    assert.equal(typeof rerank.truthNotInList, "number");
    assert.equal(
      rerank.scored + rerank.droppedSingleCandidate + rerank.truthNotInList,
      rerank.offered,
      "every position that offered a list must be accounted for"
    );
  });

  test("too few files is a refusal, not a number", () => {
    const thin = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-thin-"));
    try {
      fs.writeFileSync(path.join(thin, "only.js"), "const x = 1;\n");
      const r = measure([thin]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /GATE:/);
    } finally {
      fs.rmSync(thin, { recursive: true, force: true });
    }
  });

  test("no arguments is a usage error", () => {
    assert.equal(measure([]).status, 2);
  });
});

describe("languages", () => {
  let poly;
  before(() => {
    poly = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-poly-"));
    fs.writeFileSync(path.join(poly, "a.py"), "def render_widget(widget):\n    return widget.name\n\nrender_widget(None)\n");
    fs.writeFileSync(path.join(poly, "b.py"), "from a import render_widget\nconfig = load_config()\nrender_widget(config)\n");
    fs.writeFileSync(path.join(poly, "c.go"), "package main\nfunc RenderWidget(w Widget) string { return w.Name }\n");
    fs.writeFileSync(path.join(poly, "d.js"), "export function renderWidget(w) { return w.name; }\n");
    fs.mkdirSync(path.join(poly, "target"));
    fs.writeFileSync(path.join(poly, "target", "generated.rs"), "fn generated() {}\n");
    fs.writeFileSync(path.join(poly, "e.rs"), "fn render_widget(w: Widget) -> String { w.name }\n");
  });
  after(() => fs.rmSync(poly, { recursive: true, force: true }));

  test("resolveLanguages accepts names, aliases and lists", () => {
    assert.deepEqual(resolveLanguages("python").languages, ["python"]);
    assert.deepEqual(resolveLanguages("py").languages, ["python"]);
    assert.deepEqual(resolveLanguages("ts").languages, ["javascript"]);
    assert.deepEqual(resolveLanguages("py,go").languages, ["python", "go"]);
    assert.deepEqual(resolveLanguages(" PY , Go ").languages, ["python", "go"]);
    assert.deepEqual(resolveLanguages("py,py").languages, ["python"], "duplicates collapse");
    assert.equal(resolveLanguages("all").languages.length, LANGUAGE_NAMES.length);
  });

  test("an unknown language names itself and what is on offer", () => {
    assert.throws(() => resolveLanguages("cobol"), /unknown language "cobol"/);
    assert.throws(() => resolveLanguages("cobol"), /javascript/);
    assert.throws(() => resolveLanguages(""), /at least one/);
  });

  test("each preset matches its own files and not another's", () => {
    const py = resolveLanguages("python").extensions;
    for (const f of ["a.py", "a.pyi"]) assert.ok(py.test(f), `python should match ${f}`);
    for (const f of ["a.js", "a.go", "a.pyx", "a.PY"]) assert.ok(!py.test(f), `python should not match ${f}`);

    const js = resolveLanguages("javascript").extensions;
    for (const f of ["a.js", "a.mjs", "a.tsx"]) assert.ok(js.test(f));
    assert.ok(!js.test("a.py"));

    // A joined preset must match both sides, which a naive concatenation gets wrong.
    const both = resolveLanguages("py,go").extensions;
    assert.ok(both.test("a.py") && both.test("a.go") && !both.test("a.js"));
  });

  test("every shipped preset is a usable regular expression", () => {
    for (const name of LANGUAGE_NAMES) {
      const { extensions } = resolveLanguages(name);
      assert.ok(extensions instanceof RegExp, `${name} did not resolve to a RegExp`);
      assert.ok(LANGUAGES[name].extensions.source.length > 0);
    }
  });

  test("the default is still JavaScript, so no measured number moves", () => {
    const built = buildIndex(poly);
    assert.equal(built.files, 1, "only d.js should be indexed by default");
  });

  test("--lang style options reach collectFiles", () => {
    assert.equal(buildIndex(poly, { languages: "python" }).files, 2);
    assert.equal(buildIndex(poly, { languages: "py,go" }).files, 3);
  });

  test("a language's build directory is skipped only for that language", () => {
    // e.rs is real source; target/generated.rs is build output.
    assert.equal(buildIndex(poly, { languages: "rust" }).files, 1);
    assert.ok(resolveLanguages("rust").skipDirs.has("target"));
    assert.ok(!resolveLanguages("javascript").skipDirs.has("target"), "target is real source elsewhere");
    // Asking for rust files without the rust preset still finds both.
    assert.equal(collectFiles(poly, { extensions: /\.rs$/ }).length, 2);
  });

  test("the CLI indexes another language and completes in it", () => {
    const stats = run([poly, "--lang", "python", "--stats"]);
    assert.equal(stats.status, 0);
    assert.match(stats.stdout, /files\s+: 2 of 2 candidates/);

    const out = run([poly, "--lang", "python", "--stdin", "-k", "5"], "render_wid");
    assert.equal(out.status, 0);
    assert.ok(out.stdout.trim().split("\n").includes("render_widget"), out.stdout);
  });

  test("without --lang the empty-index error points at --lang", () => {
    const onlyPy = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-py-"));
    try {
      fs.writeFileSync(path.join(onlyPy, "a.py"), "x = 1\n");
      const r = run([onlyPy, "--stats"]);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--lang/, "the error must say how to index another language");
    } finally {
      fs.rmSync(onlyPy, { recursive: true, force: true });
    }
  });

  test("the CLI refuses an unknown language", () => {
    const r = run([poly, "--lang", "cobol", "--stats"]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown language/);
  });

  test("--ext still overrides --lang, so an uncovered pattern stays reachable", () => {
    const r = run([poly, "--lang", "python", "--ext", "\\.go$", "--stats"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /files\s+: 1 of 1 candidates/);
  });

  test("the harness takes --lang, which is how the claim gets checked per language", () => {
    const r = spawnSync(process.execPath, [MEASURE, "--json", "--lang", "python", poly], { encoding: "utf8" });
    // Two files is below the harness's own gate, and it must say so rather than answer.
    assert.equal(r.status, 2);
    assert.match(r.stderr, /GATE:/);
  });

  test("the harness hints at --lang when the default found nothing", () => {
    const onlyPy = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-py2-"));
    try {
      for (const n of ["a", "b", "c", "d", "e"]) fs.writeFileSync(path.join(onlyPy, `${n}.py`), `x_${n} = 1\n`);
      const r = spawnSync(process.execPath, [MEASURE, onlyPy], { encoding: "utf8" });
      assert.equal(r.status, 2);
      assert.match(r.stderr, /--lang/);
    } finally {
      fs.rmSync(onlyPy, { recursive: true, force: true });
    }
  });
});

/**
 * Several directories are one corpus, and a file reachable twice is still one file.
 *
 * This is not tidiness. Duplicated content repeats itself perfectly, repetition is exactly
 * what the index measures, and a corpus counted twice reports a recital rate describing
 * the counting rather than the code — the same defect the README spends a numbered point
 * on, reached through the tool's own documented interface rather than through a vendored
 * directory.
 */
describe("overlapping paths are one corpus", () => {
  let root;
  before(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-dup-"));
    fs.mkdirSync(path.join(root, "lib"));
    for (let i = 0; i < 6; i++) {
      fs.writeFileSync(path.join(root, `f${i}.js`), `export const symbol${i} = ${i};\nexport function helper${i}(a) { return a + ${i}; }\n`);
    }
    for (let i = 0; i < 3; i++) {
      fs.writeFileSync(path.join(root, "lib", `g${i}.js`), `export const libSymbol${i} = ${i};\n`);
    }
  });
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  test("a directory named twice yields each file once", () => {
    const once = collectFiles(root);
    const twice = collectFiles([root, root]);
    assert.equal(twice.length, once.length);
    assert.equal(twice.duplicates, once.length);
    assert.equal(once.duplicates, 0);
  });

  // `./src` and `./src/` are the same directory and different strings. This is the one a
  // person types without noticing.
  test("a trailing slash is the same directory", () => {
    const plain = collectFiles(root);
    const slashed = collectFiles([root, root + path.sep]);
    assert.equal(slashed.length, plain.length);
    assert.equal(slashed.duplicates, plain.length);
  });

  test("a parent and its own child overlap", () => {
    const parent = collectFiles(root);
    const both = collectFiles([root, path.join(root, "lib")]);
    assert.equal(both.length, parent.length, "the child's files are already under the parent");
    assert.equal(both.duplicates, 3);
  });

  // The reason the key is the REAL path and not `path.resolve`. This is not hypothetical:
  // on macOS the temp directory is itself reached through a symlink, so the two spellings
  // below are the same directory that `path.resolve` calls different — and any repository
  // under a symlinked home, mount or checkout has the same shape.
  test("two spellings of one directory through a symlink are the same directory", () => {
    const real = fs.realpathSync(root);
    if (real === root) return; // no symlink in the way on this platform; nothing to prove
    assert.notEqual(path.resolve(root), path.resolve(real), "the fixture is not exercising this");

    const both = collectFiles([root, real]);
    assert.equal(both.length, collectFiles(root).length);
    assert.equal(both.duplicates, collectFiles(root).length, "resolve() alone would have missed this");
  });

  // Documenting what the walker actually does, because the dedup above only matters if
  // you know what does and does not reach it.
  test("a symlinked file is not followed at all, so it cannot duplicate its target", () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-link-"));
    try {
      fs.symlinkSync(path.join(root, "f0.js"), path.join(other, "linked.js"));
    } catch {
      fs.rmSync(other, { recursive: true, force: true });
      return; // a platform without symlink permission
    }
    try {
      assert.equal(collectFiles(other).length, 0, "readdir reports a symlink as neither file nor directory");
      assert.equal(collectFiles([root, other]).length, collectFiles(root).length);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test("the duplicate count does not leak into the list itself", () => {
    const files = collectFiles([root, root]);
    // Existing callers spread, iterate and serialise this; none of that may change.
    assert.equal([...files].length, files.length);
    assert.equal(JSON.parse(JSON.stringify(files)).length, files.length);
    assert.ok(!Object.keys(files).includes("duplicates"));
    for (const f of files) assert.equal(typeof f, "string");
  });

  test("a single directory as a plain string still works", () => {
    assert.ok(Array.isArray(collectFiles(root)));
    assert.equal(collectFiles(root).length, 9);
  });

  // The point of the whole exercise: the corpus, and so every number taken from it, must
  // not move because of how the same tree was spelled on the command line.
  test("the index is identical however the same tree is spelled", () => {
    const honest = buildIndex(root);
    for (const spelling of [[root, root], [root, root + path.sep], [root, path.join(root, "lib")]]) {
      const b = buildIndex(spelling);
      assert.equal(b.files, honest.files, `files moved for ${JSON.stringify(spelling)}`);
      assert.equal(b.tokens, honest.tokens, `tokens moved for ${JSON.stringify(spelling)}`);
      assert.ok(b.duplicates > 0, "the overlap should have been noticed");
    }
    assert.equal(buildIndex(root).duplicates, 0);
  });

  test("the recital rate does not move either, which is the number that matters", () => {
    const honest = buildIndex(root);
    const doubled = buildIndex([root, root]);
    const held = lex(fs.readFileSync(path.join(root, "f0.js"), "utf8"));
    assert.equal(doubled.index.recitalRate(held), honest.index.recitalRate(held));
  });

  test("the CLI says when paths overlapped rather than quietly deduplicating", () => {
    const r = run([root, root + path.sep, "--stats"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /files\s+: 9 of 9 candidates/);
    assert.match(r.stderr, /reachable through more than one of the paths/);
    assert.ok(!run([root, "--stats"]).stderr.includes("reachable through"), "no note when there is nothing to note");
  });

  test("the harness says so too, because it is about to print numbers", () => {
    const r = spawnSync(process.execPath, [MEASURE, root, root + path.sep], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /NOTE: 9 files were reachable through more than one/);
    assert.match(r.stdout, /inflate every number below/);
  });

  test("the harness reports the same corpus however it is spelled", () => {
    const readJson = (dirs) =>
      JSON.parse(spawnSync(process.execPath, [MEASURE, "--json", ...dirs], { encoding: "utf8" }).stdout);
    const honest = readJson([root]);
    const doubled = readJson([root, root]);
    assert.equal(doubled.index.files, honest.index.files);
    assert.equal(doubled.recital, honest.recital, "recital must not move with the argument list");
    assert.equal(doubled.positions.scored, honest.positions.scored);
  });
});

/**
 * Generated code is the contamination this tool is most exposed to: it repeats itself far
 * more than a person's code does, and repetition is the one thing the index measures.
 *
 * The precision cases below are not invented. Every "must not be flagged" string is the
 * shape of something that was flagged during development and should not have been.
 */
describe("spotting generated code", () => {
  test("it recognises the conventions generators actually emit", () => {
    const generated = [
      ["// Code generated by protoc-gen-go. DO NOT EDIT.", "Go's documented convention"],
      ["/* @generated */", "the @generated convention"],
      ["# DO NOT EDIT", "a bare shout on its own line"],
      ["# automatically generated by the FlatBuffers compiler, do not modify", "FlatBuffers"],
      ["# Generated by the protocol buffer compiler.  DO NOT EDIT!", "protobuf"],
      ["// This file was generated by the build script", "a plain header"],
      ["-- Generated by schema.rb", "a SQL comment naming a script"],
    ];
    for (const [text, why] of generated) {
      assert.equal(isLikelyGenerated(text, "a.js"), "marker", `missed ${why}: ${JSON.stringify(text)}`);
    }
  });

  // Prose about generated code is not generated code. The Rails model that produced the
  // second case here was a real false positive on a real repository.
  test("it does not flag ordinary code that merely mentions generation", () => {
    const ordinary = [
      "const x = 1; // we should not edit this by hand",
      "# A little note about QuizQuestions: they could be auto-generated by an admin",
      "/* The docs explain how these files are generated by our pipeline. */",
      "// Regenerate the fixtures before editing them",
      "function generatedAt() { return Date.now(); }",
      "export const DO_NOT_EDIT_MESSAGE = 'careful';",
    ];
    for (const text of ordinary) {
      assert.equal(isLikelyGenerated(text, "a.js"), false, `false positive on ${JSON.stringify(text)}`);
    }
  });

  test("it recognises filenames that are generated by convention", () => {
    for (const f of ["service_pb2.py", "api_pb2_grpc.py", "types.pb.go", "bundle.min.js", "Form.designer.cs", "model.g.dart"]) {
      assert.equal(hasGeneratedName(f), true, `missed ${f}`);
      assert.equal(isLikelyGenerated("whatever", f), "name");
    }
    for (const f of ["server.js", "pb.js", "designer.cs", "generated_helpers.py", "min.test.js"]) {
      assert.equal(hasGeneratedName(f), false, `false positive on ${f}`);
    }
  });

  // Only the head, because a linter rule or a boilerplate checker discusses these markers
  // at length and is not itself generated.
  test("a marker far down a long file is not a header", () => {
    const body = "const x = 1;\n".repeat(600); // comfortably past the head window
    assert.equal(isLikelyGenerated(body + "\n// DO NOT EDIT\n", "a.js"), false);
    assert.equal(isLikelyGenerated("// DO NOT EDIT\n" + body, "a.js"), "marker");
  });

  test("buildIndex counts generated files and only drops them when asked", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-gen-"));
    try {
      fs.writeFileSync(path.join(d, "real.js"), "export const realCode = 1;\nexport function helper(a) { return a + realCode; }\n");
      fs.writeFileSync(path.join(d, "gen.js"), "// Code generated by protoc. DO NOT EDIT.\nexport const genA = 1;\nexport const genB = 2;\n");

      const counted = buildIndex(d);
      assert.equal(counted.generated, 1);
      assert.equal(counted.files, 2, "reporting is the default; nothing is dropped");

      const dropped = buildIndex(d, { skipGenerated: true });
      assert.equal(dropped.generated, 1, "still counted, so it can still be reported");
      assert.equal(dropped.files, 1);
      assert.ok(dropped.tokens < counted.tokens);
      assert.equal(dropped.files + dropped.skipped, dropped.candidates, "every candidate accounted for");
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("a corpus with no generated code reports none, and says nothing", () => {
    const built = buildIndex(dir);
    assert.equal(built.generated, 0);
    assert.ok(!run([dir, "--stats"]).stderr.includes("look generated"));
  });

  test("the CLI reports generated files, and excludes them on request", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-gen2-"));
    try {
      fs.writeFileSync(path.join(d, "real.js"), "export const realCode = 1;\n");
      fs.writeFileSync(path.join(d, "gen.js"), "// Code generated by x. DO NOT EDIT.\nexport const genA = 1;\n");

      const reported = run([d, "--stats"]);
      assert.equal(reported.status, 0);
      assert.match(reported.stderr, /1 file looks generated and was indexed/);
      assert.match(reported.stderr, /--skip-generated/);

      const excluded = run([d, "--skip-generated", "--stats"]);
      assert.equal(excluded.status, 0);
      assert.match(excluded.stderr, /was excluded/);
      assert.match(excluded.stdout, /files\s+: 1 of 2 candidates/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  test("the harness reports it too, because it is about to print numbers", () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-gen3-"));
    try {
      for (let i = 0; i < 5; i++) {
        fs.writeFileSync(path.join(d, `real${i}.js`), `export const realCode${i} = ${i};\nexport function helper${i}(a) { return a + ${i}; }\n`);
      }
      fs.writeFileSync(path.join(d, "gen.js"), "// Code generated by x. DO NOT EDIT.\nexport const genA = 1;\n");
      const r = spawnSync(process.execPath, [MEASURE, d], { encoding: "utf8" });
      assert.match(r.stdout, /NOTE: 1 of 6 files looks generated and was INCLUDED/);
      assert.match(r.stdout, /--skip-generated/);

      const skipped = spawnSync(process.execPath, [MEASURE, "--skip-generated", d], { encoding: "utf8" });
      assert.match(skipped.stdout, /was EXCLUDED/);
    } finally {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });
});
