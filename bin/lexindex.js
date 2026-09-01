#!/usr/bin/env node
/**
 * lexindex <dir>... [options]
 *
 * The CLI exists so that an editor plugin, a shell pipeline or a scratch experiment can
 * reach the index without writing JavaScript. That means it has to be able to complete
 * text that is not on disk yet — an editor's live buffer is unsaved by definition — which
 * is what `--stdin` is for, and it has to be able to answer in a form a program can read,
 * which is what `--json` is for.
 *
 * Exit codes follow the convention the rest of this project uses:
 *   0 ran, produced output   1 ran, nothing to suggest   2 could not run or could not measure
 */
import fs from "node:fs";
import { buildIndex } from "../src/build.js";
import { Completer } from "../src/completer.js";
import { topWords } from "../src/identifiers.js";
import { lex } from "../src/lex.js";
import { recitalBand as band } from "../src/count-model.js";
import { resolveLanguages, LANGUAGE_NAMES } from "../src/languages.js";
import { localIndexFor, DEFAULT_MIN_CONFIDENCE } from "../src/line-index.js";

const argv = process.argv.slice(2);
const dirs = [];
let at = null;
let k = 5;
let stats = false;
let json = false;
let wordsOnly = false;
let lineMode = false;
let minConfidence = DEFAULT_MIN_CONFIDENCE;
let useStdin = false;
let beta = 0.5;
let recitalOf = null;
let extRe = null;
let excludeRe = null;
let maxBytes = null;
let langSpec = null;
let skipGenerated = false;

function usage() {
  console.log(`usage: lexindex <dir>... [options]

  position
    --at <file>:<offset>          complete at a byte offset
    --at <file>:<line>:<col>      complete at a 1-based line and column
    --stdin                       read the buffer from stdin rather than from disk;
                                  with no --at, complete at the end of what was piped
  output
    -k <n>                        how many suggestions (default 5)
    --json                        one JSON object: suggestions, scores, recital, index
    --words                       identifier-shaped suggestions only, as every editor
                                  integration does; punctuation is kept by default so
                                  a measurement stays a fair one
    --line                        the whole NEXT LINE, retrieved from the corpus with
                                  the file and line it came from; exits 1 and says so
                                  when nothing is likely enough to offer
    --min-confidence <n>          share of the score the best line must hold to be
                                  offered at all, default 0.3; 0 always answers
    --stats                       report what the index holds
    --recital <file>              just the recital rate of <file> against the index
  index
    --beta <n>                    0 repo only, 1 buffer only, default 0.5
    --lang <names>                index another language: python, go, rust, java,
                                  ruby, c, cpp, csharp, php, swift, kotlin, shell,
                                  sql, or "all". Comma-separated. Default javascript.
    --ext <regex>                 which filenames to index (overrides --lang)
    --exclude <regex>             drop matching paths from the corpus
    --skip-generated              drop files that look generated (protobuf stubs,
                                  parser tables, minified bundles). Reported either way.
    --max-bytes <n>               skip files larger than this (default 400000)

examples
    lexindex ./src --stats
    lexindex ./src --at src/server.js:120:9 -k 5
    sed -n '1,120p' src/server.js | lexindex ./src --stdin --json
    lexindex ./service --lang python --stats`);
}

/** Read a flag's value, refusing to silently swallow the next flag as an argument. */
function value(flag, i) {
  const v = argv[i + 1];
  if (v === undefined || (v.startsWith("--") && v.length > 2)) {
    fail(`${flag} wants a value`);
  }
  return v;
}
function fail(msg, hint) {
  console.error(`lexindex: ${msg}`);
  if (hint) console.error(`          ${hint}`);
  process.exit(2);
}

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--at") at = value(a, i++);
  else if (a === "-k") k = Number(value(a, i++));
  else if (a === "--beta") beta = Number(value(a, i++));
  else if (a === "--ext") extRe = value(a, i++);
  else if (a === "--lang") langSpec = value(a, i++);
  else if (a === "--exclude") excludeRe = value(a, i++);
  else if (a === "--max-bytes") maxBytes = Number(value(a, i++));
  else if (a === "--recital") recitalOf = value(a, i++);
  else if (a === "--stats") stats = true;
  else if (a === "--words") wordsOnly = true;
  else if (a === "--line") lineMode = true;
  else if (a === "--min-confidence") minConfidence = Number(value(a, i++));
  else if (a === "--json") json = true;
  else if (a === "--stdin") useStdin = true;
  else if (a === "--skip-generated") skipGenerated = true;
  else if (a === "-h" || a === "--help") {
    usage();
    process.exit(0);
  } else if (a.startsWith("-") && a !== "-") {
    fail(`unknown option ${a}`, "run `lexindex --help` for the list");
  } else dirs.push(a);
}

if (dirs.length === 0) {
  usage();
  process.exit(2);
}
if (!Number.isFinite(k) || k < 1) fail("-k wants a positive number");
if (!Number.isFinite(beta) || beta < 0 || beta > 1) fail("--beta wants a number from 0 to 1");
if (maxBytes !== null && (!Number.isFinite(maxBytes) || maxBytes < 1)) {
  fail("--max-bytes wants a positive number");
}

const buildOpts = {};
if (langSpec !== null) {
  try {
    const resolved = resolveLanguages(langSpec);
    buildOpts.extensions = resolved.extensions;
    buildOpts.skipDirs = resolved.skipDirs;
  } catch (e) {
    fail(e.message);
  }
}
// --ext is the escape hatch and wins, so a pattern the presets do not cover is always
// reachable without waiting for a preset to exist.
if (extRe !== null) {
  try {
    buildOpts.extensions = new RegExp(extRe);
  } catch (e) {
    fail(`--ext is not a valid regular expression: ${e.message}`);
  }
}
if (excludeRe !== null) {
  let re;
  try {
    re = new RegExp(excludeRe);
  } catch (e) {
    fail(`--exclude is not a valid regular expression: ${e.message}`);
  }
  buildOpts.exclude = (file) => re.test(file);
}
if (maxBytes !== null) buildOpts.maxBytes = maxBytes;
buildOpts.skipGenerated = skipGenerated;
buildOpts.lineIndex = lineMode;

const built = buildIndex(dirs, buildOpts);

// A root that is not a readable directory is refused by name, even when the other roots
// produced files. Quietly indexing a smaller corpus than the one asked for reports
// numbers about different code, and a wrong number said confidently is the one failure
// this project refuses everywhere.
if (built.missing.length > 0) {
  for (const m of built.missing) {
    console.error(`lexindex: not a directory: ${m}`);
    // The way several paths arrive fused into one argument is a shell that did not
    // split them — zsh leaves an unquoted $var whole where bash breaks it on spaces.
    // When every piece of the fused argument exists, say so: the fix is one keystroke
    // away and invisible from the generic message.
    const parts = m.split(/\s+/).filter(Boolean);
    if (parts.length > 1 && parts.every(isDirectory)) {
      console.error(
        `          this one argument holds ${parts.length} paths that all exist — ` +
          `a shell variable can arrive unsplit (zsh does not split unquoted variables); ` +
          `pass each directory as its own argument.`
      );
    }
  }
  process.exit(2);
}
function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

if (built.files === 0) {
  console.error("lexindex: indexed 0 files — nothing to complete from.");
  console.error(
    langSpec === null
      ? "          check the path, or that it holds .js/.ts files outside node_modules."
      : `          check the path, or that it holds ${langSpec} files outside the skipped directories.`
  );
  if (langSpec === null && extRe === null) {
    console.error(`          for another language: --lang <${LANGUAGE_NAMES.slice(0, 6).join("|")}|...>`);
  }
  if (excludeRe !== null || extRe !== null) {
    console.error(`          ${built.candidates} files were found and then filtered out by --ext/--exclude.`);
  }
  process.exit(2);
}

const indexReport = {
  files: built.files,
  candidates: built.candidates,
  skipped: built.skipped,
  duplicates: built.duplicates,
  generated: built.generated,
  generatedSkipped: skipGenerated,
  tokens: built.tokens,
  vocab: built.index.uni.size,
  ms: built.ms,
};

/** --recital: answer the one question the README says to ask first, and stop. */
if (recitalOf !== null) {
  let text;
  try {
    text = fs.readFileSync(recitalOf, "utf8");
  } catch (e) {
    fail(`cannot read ${recitalOf}: ${e.message}`);
  }
  const tokens = lex(text);
  if (tokens.length < 5) {
    fail(`${recitalOf} holds ${tokens.length} tokens — too few to measure a 4-token context.`);
  }
  const rate = built.index.recitalRate(tokens);
  if (json) {
    console.log(JSON.stringify({ recital: rate, band: band(rate), file: recitalOf, index: indexReport }));
  } else {
    console.log(`recital  : ${(rate * 100).toFixed(1)}%  (${band(rate)})`);
  }
  process.exit(0);
}

if (stats || (!at && !useStdin)) {
  if (json) {
    console.log(JSON.stringify({ index: indexReport }));
  } else {
    console.log(`files    : ${built.files} of ${built.candidates} candidates`);
    console.log(`tokens   : ${built.tokens.toLocaleString()}`);
    console.log(`vocab    : ${built.index.uni.size.toLocaleString()} distinct tokens`);
    console.log(`built in : ${built.ms} ms`);
    console.log(`COMPLETE : ${built.files + built.skipped} of ${built.candidates} accounted for`);
  }
  if (built.generated > 0) {
    // Generated code repeats itself, and repetition is the whole of what this measures.
    const one = built.generated === 1;
    console.error(
      `lexindex: ${built.generated} file${one ? "" : "s"} ${one ? "looks" : "look"} generated and ` +
        `${one ? "was" : "were"} ${skipGenerated ? "excluded" : "indexed"}.` +
        (skipGenerated ? "" : " Re-run with --skip-generated to see the difference.")
    );
  }
  if (built.duplicates > 0) {
    // Counted once, and said out loud. Overlapping paths inflate the recital rate, which
    // is the number this whole tool asks people to trust.
    console.error(
      `lexindex: ${built.duplicates} file${built.duplicates === 1 ? "" : "s"} were reachable ` +
        `through more than one of the paths given, and were indexed once.`
    );
  }
  if (!at && !useStdin) process.exit(0);
}

// ---- work out what text we are completing, and where in it -------------------
//
// `--at` may name a byte offset or a line and column; an editor has the latter and
// nothing produces the former by hand. `--stdin` supplies the text itself, because the
// buffer an editor wants completed has not been written to disk.
let text;
let file = null;
let position = null; // {line, col} | {offset}

if (at !== null) {
  const lineCol = /^(.*):(\d+):(\d+)$/.exec(at);
  const byteOff = /^(.*):(\d+)$/.exec(at);
  if (lineCol) {
    file = lineCol[1];
    position = { line: Number(lineCol[2]), col: Number(lineCol[3]) };
  } else if (byteOff) {
    file = byteOff[1];
    position = { offset: Number(byteOff[2]) };
  } else {
    fail("--at wants <file>:<offset> or <file>:<line>:<col>");
  }
  if (file === "" ) file = "-";
}

if (useStdin) {
  try {
    text = fs.readFileSync(0, "utf8");
  } catch (e) {
    fail(`cannot read stdin: ${e.message}`);
  }
  if (file !== null && file !== "-" && at !== null) {
    // --stdin wins on content; the path is then only a label. Say so rather than
    // quietly completing something other than what was piped in.
    console.error(`lexindex: --stdin given, so ${file} on --at is used only for its position.`);
  }
} else {
  if (file === null || file === "-") {
    fail("--at names no readable file", "pass a real path, or use --stdin to pipe the buffer");
  }
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    fail(`cannot read ${file}: ${e.message}`);
  }
}

let offset;
if (position === null) {
  offset = text.length; // --stdin with no --at: the cursor is the end of what was piped
} else if (position.offset !== undefined) {
  offset = Math.min(position.offset, text.length);
} else {
  offset = offsetOfLineCol(text, position.line, position.col);
}

/** 1-based line and column to a character offset, clamped rather than thrown. */
function offsetOfLineCol(src, line, col) {
  if (line < 1 || col < 1) fail("--at wants a 1-based line and column");
  const lines = src.split("\n");
  if (line > lines.length) {
    console.error(`lexindex: line ${line} is past the end of the file (${lines.length} lines); using the end.`);
    return src.length;
  }
  let o = 0;
  for (let i = 0; i < line - 1; i++) o += lines[i].length + 1;
  return Math.min(o + col - 1, o + lines[line - 1].length);
}



// The recital rate is reported with every suggestion because it is the honest predictor
// of whether these suggestions are worth anything on this repo.
const recital = built.index.recitalRate(lex(text));
const completer = new Completer(built.index, { cacheBeta: beta });
const before = text.slice(0, offset);
// Punctuation is kept by default: aggregate top-1 is mostly punctuation for every
// engine, and a measurement that quietly dropped it would flatter this one. A person
// reading a list wants the identifiers, which is what every editor integration shows
// and what `--words` asks for here -- through the same helper, so the CLI and the
// editors cannot drift.
// A whole line is RETRIEVED, never assembled token by token: greedy extension of this
// model is exact 3.1% of the time at ten tokens, which is about a line. When the context
// has not been seen the honest answer is to say nothing, so this exits 1 rather than
// offering something the corpus never contained.
if (lineMode) {
  // The buffer above the cursor is a corpus too, and the most useful one: indexing it
  // alongside the repository is worth 4.3 and 4.0 points of accuracy on the two measured
  // splits, because code repeats locally far more than it repeats globally. The bounded
  // tail lives in line-index.js so this and the language server cannot disagree about it.
  const local = localIndexFor(before);
  const hit = built.lines.lookup(before, { local, minConfidence });
  if (json) {
    console.log(JSON.stringify({ line: hit, recital, band: band(recital), offset, index: indexReport }));
    process.exit(hit ? 0 : 1);
  }
  console.error(`(recital ${(recital * 100).toFixed(1)}% \u2014 ${band(recital)})`);
  if (!hit) {
    // Two ways to have no answer, and they mean different things to whoever is reading.
    const near = built.lines.candidates(before, { local });
    console.error(
      near.length
        ? `lexindex: nothing here is likely enough \u2014 best of ${near.length} candidate(s) holds ` +
          `${(near[0].confidence * 100).toFixed(0)}% of the score, below --min-confidence ${minConfidence}`
        : "lexindex: this context has not been seen \u2014 no line to retrieve",
    );
    process.exit(1);
  }
  console.log(hit.text);
  const others = hit.alternatives > 1 ? `, ${hit.alternatives - 1} other(s) here` : "";
  console.error(
    `  ${hit.file}:${hit.line} \u2014 ${(hit.confidence * 100).toFixed(0)}% confident, ` +
      `seen ${hit.count} time(s)${others}`,
  );
  process.exit(0);
}

const scored = wordsOnly
  ? topWords(completer, before, k)
  : completer.completeScored(before, { k });

if (json) {
  console.log(
    JSON.stringify({
      suggestions: scored.map((e) => e.token),
      scored,
      recital,
      band: band(recital),
      offset,
      index: indexReport,
    })
  );
  process.exit(scored.length === 0 ? 1 : 0);
}

console.error(`(recital ${(recital * 100).toFixed(1)}% — ${band(recital)})`);
if (scored.length === 0) {
  console.error("lexindex: no candidates");
  process.exit(1);
}
for (const e of scored) console.log(e.token);
