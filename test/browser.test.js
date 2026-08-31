/**
 * The browser export exists for one reason: a bundler following the main entry pulls
 * `node:fs` into a page that never calls it, because `src/index.js` re-exports
 * `buildIndex`. So the test that matters is not "does it import" — it is that the whole
 * transitive import graph reachable from `src/browser.js` contains no node builtin and no
 * bare specifier at all.
 *
 * A list of safe files maintained by hand would be wrong the first time somebody added an
 * import, and wrong silently. The graph is walked instead.
 *
 * And the walk is checked against a POSITIVE CONTROL: the same walk over `src/index.js`
 * must find `node:fs`, because a graph walker that cannot find the one import known to be
 * there would pass this file whatever it contained. That is the same rule the exit-code
 * table states for the harnesses — a clean result from an instrument that could not fail
 * is worth nothing.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// Anchored to a line that STARTS with `import` or `export`, which is what a real
// statement in this codebase does and what a usage example inside a doc comment does not
// -- those lines start with `*`. An unanchored scan read the `import ... from
// "lexindex/browser"` in codemirror.js's own header and reported the package as depending
// on itself. A dynamic `import()` would evade the anchor, so nothing may use one; the
// test below holds the walked files to that.
// The `from` clause, and the bare side-effect import, each confined to one line. A looser
// pattern paired the two quotes of an empty default argument with a quote two lines below
// and reported the code between them as a module specifier.
const FROM = /^\s*(?:import|export)\b[^\n]*?\bfrom\s*["']([^"'\n]+)["']/gm;
const BARE = /^\s*import\s*["']([^"'\n]+)["']/gm;
const DYNAMIC = /\bimport\s*\(/;

/**
 * Every specifier reachable from `entry`, following relative imports and recording the
 * rest. Returns { external, visited }.
 */
function walk(entry) {
  const external = new Set();
  const visited = new Set();
  const dynamic = new Set();
  const queue = [path.join(SRC, entry)];

  while (queue.length) {
    const file = queue.pop();
    if (visited.has(file)) continue;
    visited.add(file);

    const text = fs.readFileSync(file, "utf8");
    if (DYNAMIC.test(stripComments(text))) dynamic.add(path.basename(file));
    for (const re of [FROM, BARE]) {
      for (const m of text.matchAll(re)) {
        const spec = m[1];
        if (spec.startsWith(".")) queue.push(path.resolve(path.dirname(file), spec));
        else external.add(spec);
      }
    }
  }
  return { external, visited, dynamic };
}

/** Comments only, so the dynamic-import guard is not tripped by prose describing one. */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("the browser export — nothing in its import graph is a node builtin", () => {
  test("src/index.js reaches node:fs, so the walker can fail", () => {
    const { external, visited } = walk("index.js");
    assert.ok(visited.size > 5, `only walked ${visited.size} files; the walk is not working`);
    assert.ok(
      external.has("node:fs"),
      `positive control failed: the walk over src/index.js found ${
        [...external].join(", ") || "no external specifiers at all"
      }, but buildIndex imports node:fs. The walker is broken, not the entry point.`
    );
  });

  test("src/browser.js reaches no external specifier whatsoever", () => {
    const { external, visited } = walk("browser.js");
    assert.ok(visited.size > 5, `only walked ${visited.size} files; the walk is not working`);
    assert.deepEqual(
      [...external].sort(),
      [],
      "a page bundling lexindex/browser would have to resolve these"
    );
  });

  test("src/codemirror.js reaches no external specifier either, CodeMirror included", () => {
    const { external } = walk("codemirror.js");
    assert.deepEqual(
      [...external].sort(),
      [],
      "the completion source is written against CodeMirror's shape, not its package"
    );
  });

  test("no file in either graph loads anything dynamically, which the walk cannot follow", () => {
    for (const entry of ["index.js", "browser.js", "codemirror.js"]) {
      assert.deepEqual(
        [...walk(entry).dynamic],
        [],
        `a dynamic import() would carry a specifier past the check above`
      );
    }
  });

  test("build.js is not reachable from the browser entry", () => {
    const { visited } = walk("browser.js");
    const reached = [...visited].map((f) => path.basename(f));
    assert.ok(!reached.includes("build.js"), `browser.js reached ${reached.join(", ")}`);
  });
});

describe("the browser export — the same objects, not a second implementation", () => {
  test("every name it exports is identical to the main entry's", async () => {
    const main = await import("../src/index.js");
    const browser = await import("../src/browser.js");
    for (const name of Object.keys(browser)) {
      assert.ok(name in main, `lexindex/browser exports ${name} and lexindex does not`);
      assert.equal(browser[name], main[name], `${name} is a different object on the two entries`);
    }
  });

  test("it withholds exactly the file-system half and nothing else", async () => {
    const main = await import("../src/index.js");
    const browser = await import("../src/browser.js");
    const missing = Object.keys(main).filter((n) => !(n in browser));
    assert.deepEqual(missing.sort(), ["buildIndex", "collectFiles", "updateIndexFile"]);
  });
});

describe("the exports map", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, "..", "package.json"), "utf8"));

  test("names the browser and codemirror subpaths", () => {
    assert.equal(pkg.exports["./browser"], "./src/browser.js");
    assert.equal(pkg.exports["./codemirror"], "./src/codemirror.js");
  });

  test("every target it names is a file that exists and imports cleanly", async () => {
    for (const [subpath, target] of Object.entries(pkg.exports)) {
      const file = path.join(SRC, "..", target);
      assert.ok(fs.existsSync(file), `${subpath} points at ${target}, which is not there`);
      if (target.endsWith(".js")) await import(file);
    }
  });
});
