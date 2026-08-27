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

import { buildIndex, updateIndexFile } from "../src/build.js";
import { Completer } from "../src/completer.js";
import { lex } from "../src/lex.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "lexindex.js");

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
