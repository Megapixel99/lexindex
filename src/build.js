/**
 * Walk a repository and build an index from it.
 *
 * `node_modules` is excluded by default and that is a measured decision, not tidiness:
 * a foreign corpus does not help. Indexing one project and completing a different one
 * cost 0.167-0.197 top-1 in the source research, and 57x more corpus was worth +0.000.
 * Dependencies are somebody else's idioms; your repo is the signal.
 */

import fs from "node:fs";
import path from "node:path";
import { lex } from "./lex.js";
import { CountModel } from "./count-model.js";

const DEFAULT_EXTENSIONS = /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/;
const DEFAULT_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "vendor",
  ".cache",
  // Not your code, and each one inflates the index with near-duplicates or foreign
  // idioms. `.claude` holds agent worktrees — whole extra copies of the repository, which
  // is the most contaminating thing a completion index can eat.
  ".claude",
  ".venv",
  "venv",
  "site-packages",
  ".tox",
  "__pycache__",
]);
const DEFAULT_MAX_BYTES = 400_000;

/** Collect indexable files under `dir`. */
export function collectFiles(dir, options = {}) {
  const {
    extensions = DEFAULT_EXTENSIONS,
    skipDirs = DEFAULT_SKIP_DIRS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDepth = 24,
  } = options;

  const out = [];
  (function walk(d, depth) {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(p, depth + 1);
      } else if (e.isFile() && extensions.test(e.name) && !/\.min\.js$/.test(e.name)) {
        let size;
        try {
          size = fs.statSync(p).size;
        } catch {
          continue;
        }
        if (size <= maxBytes) out.push(p);
      }
    }
  })(dir, 0);
  return out;
}

/**
 * Build an index from one or more directories.
 * @returns {{index: CountModel, files: number, tokens: number, ms: number, skipped: number}}
 */
export function buildIndex(dirs, options = {}) {
  const { order = 5, exclude = null } = options;
  const roots = Array.isArray(dirs) ? dirs : [dirs];

  const model = new CountModel(order);
  const started = Date.now();
  let candidates = 0;
  let skipped = 0;

  for (const root of roots) {
    for (const file of collectFiles(root, options)) {
      candidates++;
      if (exclude && exclude(file)) {
        skipped++;
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        skipped++;
        continue;
      }
      const tokens = lex(text);
      if (tokens.length) model.addFileTokens(tokens);
    }
  }

  model.finalize();

  return {
    index: model,
    files: model.nFiles,
    tokens: model.nTokens,
    skipped,
    candidates,
    ms: Date.now() - started,
  };
}
