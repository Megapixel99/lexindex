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
import { LANGUAGES, COMMON_SKIP_DIRS, resolveLanguages } from "./languages.js";
import { isLikelyGenerated } from "./generated.js";

// The default is the JavaScript family and stays that way: every number this project
// reports was measured on JavaScript and TypeScript, and a default that quietly widened
// would change what those numbers describe. Other languages are opt-in through
// `languages` here, or `--lang` on the CLI and the harness. See src/languages.js.
const DEFAULT_EXTENSIONS = LANGUAGES.javascript.extensions;
// Not your code, and each one inflates the index with near-duplicates or foreign idioms.
const DEFAULT_SKIP_DIRS = new Set(COMMON_SKIP_DIRS);
const DEFAULT_MAX_BYTES = 400_000;

/**
 * Collect indexable files under `dir`, or under each of several directories.
 *
 * Several directories are ONE corpus, and a file reachable twice is still one file. That
 * is not tidiness, it is the whole subject of this project: duplicated content repeats
 * itself perfectly, repetition is exactly what the index measures, and a corpus counted
 * twice reports a recital rate that describes the counting rather than the code. On this
 * repository, passing `./src` alongside its own parent took recital from 51.0% to 74.0%
 * and identifier accuracy from 34.6% to 83.3% — a completely different verdict, from an
 * argument list a person would type without a second thought.
 *
 * The spellings that reach here are not comparable as strings: `./src` and `./src/` are
 * the same directory, a parent and a child overlap, and a symlink can be a third name for
 * either. So files are keyed on the real path, and the first spelling seen is the one
 * returned.
 *
 * A root that is not a readable directory is recorded on `.missing` rather than walked
 * or thrown on. Deep inside the walk an unreadable entry is routine — a permission
 * denied under someone's tree should not abort the corpus — but a root is a path the
 * caller typed, and a typo there silently shrinks the corpus into one that reports
 * numbers about different code. The caller decides how loud to be; this only refuses
 * to lose the fact.
 *
 * @param {string|string[]} dir one directory, or several treated as one corpus
 */
export function collectFiles(dir, options = {}) {
  const lang = options.languages ? resolveLanguages(options.languages) : null;
  const {
    extensions = lang ? lang.extensions : DEFAULT_EXTENSIONS,
    skipDirs = lang ? lang.skipDirs : DEFAULT_SKIP_DIRS,
    maxBytes = DEFAULT_MAX_BYTES,
    maxDepth = 24,
  } = options;

  const roots = Array.isArray(dir) ? dir : [dir];
  const out = [];
  const seen = new Map(); // real path -> the spelling that got there first
  const missing = [];
  let duplicates = 0;

  const identity = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };

  (function walkAll() {
    for (const root of roots) {
      let st = null;
      try {
        st = fs.statSync(root);
      } catch {}
      if (!st || !st.isDirectory()) {
        missing.push(root);
        continue;
      }
      walk(root, 0);
    }
  })();
  // Non-enumerable so that spreading, iterating or serialising the list behaves exactly
  // as it did before these existed; they are metadata about the walk, not files.
  Object.defineProperty(out, "duplicates", { value: duplicates, enumerable: false });
  Object.defineProperty(out, "missing", { value: missing, enumerable: false });
  return out;

  function walk(d, depth) {
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
        if (size > maxBytes) continue;
        const key = identity(p);
        if (seen.has(key)) {
          duplicates++;
          continue;
        }
        seen.set(key, p);
        out.push(p);
      }
    }
  }
}

/**
 * Build an index from one or more directories.
 *
 * `retainFileTokens` keeps each file's token array on the result, which is what
 * `updateIndexFile` needs to subtract a file's old contribution later. It costs memory
 * proportional to the corpus, so it is opt-in: a one-shot CLI run does not want it, and a
 * long-lived editor process does.
 *
 * @returns {{index: CountModel, files: number, tokens: number, ms: number, skipped: number,
 *   candidates: number, duplicates: number, missing: string[], generated: number,
 *   tokensByFile: Map<string, string[]>|null}}
 */
export function buildIndex(dirs, options = {}) {
  const { order = 5, exclude = null, retainFileTokens = false, skipGenerated = false } = options;
  const roots = Array.isArray(dirs) ? dirs : [dirs];

  const model = new CountModel(order);
  const started = Date.now();
  const tokensByFile = retainFileTokens ? new Map() : null;
  let candidates = 0;
  let skipped = 0;
  let generated = 0;

  // One call for every root, so a file reachable through two of them is counted once.
  const files = collectFiles(roots, options);
  for (const file of files) {
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
    // Counted whether or not it is skipped. Generated code repeats itself enormously and
    // repetition is what this index measures, so a corpus holding it reports a rate
    // describing the generator. Reporting is the default and dropping is opt-in: this is
    // a heuristic, and one that silently discarded a third of a repository would be worse
    // than the problem it solves.
    if (isLikelyGenerated(text, file)) {
      generated++;
      if (skipGenerated) {
        skipped++;
        continue;
      }
    }

    const tokens = lex(text);
    if (tokens.length) {
      model.addFileTokens(tokens);
      if (tokensByFile) tokensByFile.set(path.resolve(file), tokens);
    }
  }

  model.finalize();

  return {
    index: model,
    files: model.nFiles,
    tokens: model.nTokens,
    skipped,
    candidates,
    duplicates: files.duplicates,
    missing: files.missing,
    generated,
    tokensByFile,
    ms: Date.now() - started,
  };
}

/**
 * Bring one file's contribution up to date without rebuilding the index.
 *
 * A build is proportional to the whole tree; this is proportional to one file, and on a
 * 224K-token corpus it measured 7 ms against 353 ms for the rebuild it replaces. The
 * resulting index is not an approximation of a rebuilt one — it is exactly equal to it,
 * which the suite asserts over edits, deletions, additions and long edit sequences.
 *
 * @param {ReturnType<typeof buildIndex>} built a result from `buildIndex({retainFileTokens: true})`
 * @param {string} file path to the file that changed
 * @param {string|null} [text] the new contents; omit to read from disk, pass null if deleted
 * @returns {{file: string, action: "added"|"updated"|"removed"|"unchanged", ms: number}}
 */
export function updateIndexFile(built, file, text) {
  if (!built || !built.tokensByFile) {
    throw new Error(
      "updateIndexFile: needs an index built with { retainFileTokens: true } — " +
        "without the previous tokens there is nothing to subtract."
    );
  }
  const started = Date.now();
  const key = path.resolve(file);
  const previous = built.tokensByFile.get(key) || null;

  let next = null;
  if (text === undefined) {
    try {
      next = lex(fs.readFileSync(key, "utf8"));
    } catch {
      next = null; // unreadable now: treat exactly as a deletion
    }
  } else if (text !== null) {
    next = lex(text);
  }
  if (next && next.length === 0) next = null;

  if (!previous && !next) {
    return { file: key, action: "unchanged", ms: Date.now() - started };
  }

  built.index.replaceFileTokens(previous, next);
  if (next) built.tokensByFile.set(key, next);
  else built.tokensByFile.delete(key);

  built.files = built.index.nFiles;
  built.tokens = built.index.nTokens;

  const action = !previous ? "added" : !next ? "removed" : "updated";
  return { file: key, action, ms: Date.now() - started };
}
