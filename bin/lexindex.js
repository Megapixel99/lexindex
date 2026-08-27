#!/usr/bin/env node
/**
 * lexindex <dir>... --at <file>:<offset>   suggest at a byte offset in a file
 * lexindex <dir>... --stats                index the tree and report what it holds
 *
 * Exit codes follow the convention the rest of this project uses:
 *   0 ran, produced suggestions   1 ran, nothing to suggest   2 could not measure
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
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--at") at = argv[++i];
  else if (argv[i] === "-k") k = Number(argv[++i]);
  else if (argv[i] === "--stats") stats = true;
  else if (argv[i] === "-h" || argv[i] === "--help") { usage(); process.exit(0); }
  else dirs.push(argv[i]);
}
function usage() {
  console.log("usage: lexindex <dir>... [--at <file>:<offset>] [-k N] [--stats]");
}
if (dirs.length === 0) { usage(); process.exit(2); }

const built = buildIndex(dirs);
if (built.files === 0) {
  console.error("lexindex: indexed 0 files — nothing to complete from.");
  console.error("          check the path, or that it holds .js/.ts files outside node_modules.");
  process.exit(2);
}

if (stats || !at) {
  console.log(`files    : ${built.files} of ${built.candidates} candidates`);
  console.log(`tokens   : ${built.tokens.toLocaleString()}`);
  console.log(`vocab    : ${built.index.uni.size.toLocaleString()} distinct tokens`);
  console.log(`built in : ${built.ms} ms`);
  console.log(`COMPLETE : ${built.files + built.skipped} of ${built.candidates} accounted for`);
  if (!at) process.exit(0);
}

const m = /^(.*):(\d+)$/.exec(at);
if (!m) { console.error("lexindex: --at wants <file>:<offset>"); process.exit(2); }
const [, file, offRaw] = m;
let text;
try { text = fs.readFileSync(file, "utf8"); } catch (e) {
  console.error(`lexindex: cannot read ${file}: ${e.message}`);
  process.exit(2);
}
const offset = Math.min(Number(offRaw), text.length);

// The recital rate is printed with every suggestion because it is the honest predictor
// of whether these suggestions are worth anything on this repo.
const recital = built.index.recitalRate(lex(text));
const completer = new Completer(built.index);
const out = completer.complete(text.slice(0, offset), { k });

console.error(`(recital ${(recital * 100).toFixed(1)}% — below ~40% expect little)`);
if (out.length === 0) { console.error("lexindex: no candidates"); process.exit(1); }
for (const w of out) console.log(w);
