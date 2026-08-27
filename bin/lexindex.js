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
import { lex } from "../src/lex.js";

const argv = process.argv.slice(2);
const dirs = [];
let at = null;
let k = 5;
let stats = false;
let json = false;
let useStdin = false;
let beta = 0.5;
let recitalOf = null;
let extRe = null;
let excludeRe = null;
let maxBytes = null;

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
    --stats                       report what the index holds
    --recital <file>              just the recital rate of <file> against the index
  index
    --beta <n>                    0 repo only, 1 buffer only, default 0.5
    --ext <regex>                 which filenames to index (default js/ts family)
    --exclude <regex>             drop matching paths from the corpus
    --max-bytes <n>               skip files larger than this (default 400000)

examples
    lexindex ./src --stats
    lexindex ./src --at src/server.js:120:9 -k 5
    sed -n '1,120p' src/server.js | lexindex ./src --stdin --json`);
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
  else if (a === "--exclude") excludeRe = value(a, i++);
  else if (a === "--max-bytes") maxBytes = Number(value(a, i++));
  else if (a === "--recital") recitalOf = value(a, i++);
  else if (a === "--stats") stats = true;
  else if (a === "--json") json = true;
  else if (a === "--stdin") useStdin = true;
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

const built = buildIndex(dirs, buildOpts);
if (built.files === 0) {
  console.error("lexindex: indexed 0 files — nothing to complete from.");
  console.error("          check the path, or that it holds .js/.ts files outside node_modules.");
  if (excludeRe !== null || extRe !== null) {
    console.error(`          ${built.candidates} files were found and then filtered out by --ext/--exclude.`);
  }
  process.exit(2);
}

const indexReport = {
  files: built.files,
  candidates: built.candidates,
  skipped: built.skipped,
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

/** The band from the README's table — the honest predictor, not a decoration. */
function band(rate) {
  if (rate >= 0.6) return "above ~60%; the full claim holds";
  if (rate >= 0.4) return "40-60%; beats a word list, a frequency table gets you most of the way";
  return "below ~40%; expect little";
}

// The recital rate is reported with every suggestion because it is the honest predictor
// of whether these suggestions are worth anything on this repo.
const recital = built.index.recitalRate(lex(text));
const completer = new Completer(built.index, { cacheBeta: beta });
const before = text.slice(0, offset);
const scored = completer.completeScored(before, { k });

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
