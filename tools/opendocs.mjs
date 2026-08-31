#!/usr/bin/env node
/**
 * How many open tabs does this need before it has counts?
 *
 *     node tools/opendocs.mjs <dir>...
 *
 * `tools/measure.mjs` answers the question for a repository on disk: index everything,
 * hold some out, see whether the mechanism beats what an editor gives you free. That is
 * the wrong question for a browser embedding. A CodeMirror or Monaco page has no file
 * walker and no repository -- the only text it can index is the documents the user
 * currently has open. So the question becomes a sweep: at 1 open document, 3, 8, 30,
 * does the index have enough counts to beat the word list that ships in the editor?
 *
 * This is the gate that decides whether a browser build is worth writing. If the answer
 * is "not below 30 documents" and web IDEs typically hold five, the mechanism does not
 * reach that market and nothing should be built for it.
 *
 * THREE BASELINES, and the third is the one this decision turns on:
 *
 *   - `completeAnyWord` -- the words in the CURRENT document. This is what CodeMirror 6
 *     actually ships, and it is the incumbent being displaced.
 *   - words from ALL open documents, by frequency. This is closer to what VS Code's
 *     word-based suggestions do, and it is the honest control: it sees exactly the same
 *     text the index sees. Beating only the first baseline would prove nothing about the
 *     mechanism -- it would prove that reading eight documents beats reading one, which
 *     needs no n-gram model. The claim in the README is that CONDITIONING ON THE
 *     PRECEDING TOKEN wins. Only the second baseline tests that.
 *   - THE CACHE ALONE, over an EMPTY index: beta=1 with no open documents indexed at all.
 *     This is an ablation rather than something an editor ships, and it is here because
 *     the first two baselines cannot answer the question the sweep was written for. The
 *     hybrid is half cache, and the cache reads only the document being edited -- so it
 *     wins at one open document whether or not opening more documents pays anything.
 *     Measured against the other two, "wins from 1 open document" is a true sentence that
 *     would talk somebody into building a tab indexer that earns nothing. The column that
 *     says whether reading the other tabs is worth writing is `z vs buf`, and the row
 *     where it first clears 1.96 is the reach number.
 *
 * TWO TAB SETS, because which documents are open is not a neutral choice:
 *
 *   - `--tabs random` samples open documents from anywhere in the corpus. This is
 *     pessimistic: nobody opens eight random files.
 *   - `--tabs sibling` picks the documents nearest the edited file by path. This is
 *     closer to a real tab set, and optimistic in the same direction the corpus warnings
 *     in the README are about -- files that sit together repeat each other.
 *
 * The truth for a given user is between them, so both run by default.
 *
 * Positions are held FIXED across the whole sweep, so every row is scored on exactly the
 * same cursors and the columns are paired. Only the index changes.
 *
 * BOILERPLATE, reported rather than gated. The sweep's whole subject is how much a few
 * open documents know about the one being edited, so a corpus where every file opens with
 * the same license header answers with the header. Canvas LMS is the worked example: 43.4%
 * of its scored positions sit on a 4-token context that appears in more than half of all
 * other files, and its reach number is that AGPL block rather than its code. The share is
 * printed for every corpus on the same posture as the generated-code check in the CLI --
 * count it and say so, since a heuristic that silently dropped half a repository would be
 * worse than the problem.
 *
 * GATES, matching measure.mjs: it refuses rather than reporting a number it cannot
 * support -- too few files, zero scored positions, or a scorer never seen to both hit
 * and miss.
 *
 *     --tabs random|sibling|both   which tab set to simulate (default both)
 *     --sweep 1,2,3,5,8,12,20,30   open-document counts to try
 *     --json                       the same measurements as one JSON object
 */

import fs from "node:fs";
import path from "node:path";
import { lex, isWord } from "../src/lex.js";
import { CountModel, recitalBand } from "../src/count-model.js";
import { Completer } from "../src/completer.js";
import { collectFiles } from "../src/build.js";
import { resolveLanguages } from "../src/languages.js";

const HOLDOUT = Number(process.env.HOLDOUT || 0.2);
const PER_FILE = Number(process.env.PERFILE || 25);
const SEED = Number(process.env.SEED || 0);
const K = 5;
const DEFAULT_SWEEP = [1, 2, 3, 5, 8, 12, 20, 30, 50];
// A sweep is nine paired tests, not one, and every row spends its own discordant pairs.
// Below this the z column is decoration: the harness would be reporting the sampling
// noise of a dozen disagreements as a threshold somebody then builds a product on.
const MIN_POSITIONS = 200;

function fail(msg) {
  console.error(`opendocs.mjs: ${msg}`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
let langSpec = null;
let tabMode = "both";
let sweep = DEFAULT_SWEEP;
const dirs = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--json") continue;
  if (a === "--lang") {
    langSpec = argv[++i];
    if (langSpec === undefined) fail("--lang wants a value");
    continue;
  }
  if (a === "--tabs") {
    tabMode = argv[++i];
    if (!["random", "sibling", "both"].includes(tabMode)) fail("--tabs wants random, sibling or both");
    continue;
  }
  if (a === "--sweep") {
    const v = argv[++i];
    if (v === undefined) fail("--sweep wants a value");
    sweep = v.split(",").map((n) => Number(n.trim()));
    if (sweep.some((n) => !Number.isInteger(n) || n < 1)) fail("--sweep wants positive integers");
    sweep.sort((x, y) => x - y);
    continue;
  }
  dirs.push(a);
}
if (!dirs.length) {
  fail("usage: opendocs.mjs [--json] [--tabs random|sibling|both] [--sweep 1,3,8] [--lang <names>] <dir>...");
}

let collectOpts = {};
if (langSpec !== null) {
  try {
    const resolved = resolveLanguages(langSpec);
    collectOpts = { extensions: resolved.extensions, skipDirs: resolved.skipDirs };
  } catch (e) {
    fail(e.message);
  }
}

const say = (line) => {
  if (!asJson) console.log(line);
};

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, seed) {
  const r = mulberry32(seed);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Words in a set of token streams, deduplicated and ranked. What an editor gives free. */
function rankWords(streams, mode, prefix) {
  const last = new Map();
  const freq = new Map();
  let i = 0;
  for (const toks of streams) {
    for (const w of toks) {
      i++;
      if (!isWord(w)) continue;
      last.set(w, i);
      freq.set(w, (freq.get(w) || 0) + 1);
    }
  }
  let ws = [...last.keys()];
  if (prefix) ws = ws.filter((w) => w.startsWith(prefix));
  if (mode === "recency") ws.sort((a, b) => last.get(b) - last.get(a));
  else ws.sort((a, b) => freq.get(b) - freq.get(a) || last.get(b) - last.get(a));
  return ws;
}

/** McNemar on the discordant pairs: where exactly one of the two arms was right. */
function mcnemar(aHits, bHits) {
  let aOnly = 0;
  let bOnly = 0;
  for (let i = 0; i < aHits.length; i++) {
    if (aHits[i] && !bHits[i]) aOnly++;
    else if (!aHits[i] && bHits[i]) bOnly++;
  }
  const n = aOnly + bOnly;
  return { aOnly, bOnly, n, z: n ? Math.abs(aOnly - bOnly) / Math.sqrt(n) : 0 };
}

/** Shared leading path segments, so a "tab set" can be the files that sit together. */
function pathProximity(a, b) {
  const x = a.split(path.sep);
  const y = b.split(path.sep);
  let n = 0;
  while (n < x.length - 1 && n < y.length - 1 && x[n] === y[n]) n++;
  return n;
}

const collected = collectFiles(dirs, collectOpts);
const files = [...collected];
if (files.length < 4) {
  console.error(
    `GATE: ${dirs.join(" + ")} has ${files.length} indexable files; need at least 4 to hold any out.` +
      (langSpec === null ? `\n      Only .js/.ts is indexed by default -- for another language pass --lang.` : "")
  );
  process.exit(2);
}
shuffle(files, SEED);
const nHold = Math.max(1, Math.floor(files.length * HOLDOUT));
const held = files.slice(0, nHold);
const pool = files.slice(nHold);

// Every file is read and lexed exactly once. The sweep rebuilds indexes many times over
// the same documents, and re-reading the disk for each would make the tool's own cost
// the thing being measured.
const tokensOf = new Map();
for (const p of files) {
  try {
    tokensOf.set(p, lex(fs.readFileSync(p, "utf8")));
  } catch {
    tokensOf.set(p, []);
  }
}

/**
 * What share of the scored positions sit on text the whole corpus already carries?
 *
 * A context present in half the other files is a license header, a generated preamble or a
 * copied import block. Positions on those are trivially predictable from any one open
 * document, so a corpus full of them reports a reach of 1 whatever the mechanism does.
 */
function boilerplateShare(scored) {
  const docFreq = new Map();
  for (const p of pool) {
    const t = tokensOf.get(p);
    const seen = new Set();
    for (let i = 4; i < t.length; i++) seen.add(t.slice(i - 4, i).join(" "));
    for (const c of seen) docFreq.set(c, (docFreq.get(c) || 0) + 1);
  }
  const bands = [0.25, 0.5];
  const counts = bands.map(() => 0);
  for (const { file, at } of scored) {
    const df = (docFreq.get(tokensOf.get(file).slice(at - 4, at).join(" ")) || 0) / pool.length;
    bands.forEach((b, i) => {
      if (df >= b) counts[i]++;
    });
  }
  return { inQuarter: counts[0] / scored.length, inHalf: counts[1] / scored.length };
}

/**
 * The cursors, fixed once. Every row of the sweep is scored on exactly these, so the
 * columns are paired and the only thing varying down a column is how many documents were
 * open. Identifier positions only: that is the number a user feels, and the aggregate is
 * mostly punctuation.
 */
const positions = [];
for (const p of held) {
  const toks = tokensOf.get(p);
  if (toks.length < 8) continue;
  const stride = Math.max(1, Math.floor((toks.length - 2) / PER_FILE));
  for (let t = 4; t < toks.length; t += stride) {
    if (!isWord(toks[t])) continue;
    positions.push({ file: p, at: t });
  }
}
if (positions.length === 0) {
  console.error(`GATE: 0 identifier positions survived. This is not a clean result.`);
  process.exit(2);
}
if (positions.length < MIN_POSITIONS) {
  console.error(
    `GATE: only ${positions.length} identifier positions across ` +
      `${new Set(positions.map((p) => p.file)).size} edited documents; need ${MIN_POSITIONS}.\n` +
      `      A sweep spends its discordant pairs nine times over, and this corpus has too\n` +
      `      few to spare. Point it at a larger corpus, or raise PERFILE / HOLDOUT.`
  );
  process.exit(2);
}

/** Which documents are open, for this many tabs, while editing this file. */
function tabsFor(n, editing, mode) {
  if (mode === "random") return pool.slice(0, n);
  const near = [...pool].sort(
    (a, b) => pathProximity(editing, b) - pathProximity(editing, a) || (a < b ? -1 : 1)
  );
  return near.slice(0, n);
}

// The ablation's index: finalized, and holding nothing. A Completer over this one draws
// its entire candidate set from the cache, so the arm is the buffer with no open document
// behind it -- not beta=1 over a real index, which would still let the index nominate
// candidates and quietly stop being an ablation.
const emptyModel = new CountModel(5);
emptyModel.finalize();

function buildModel(paths) {
  const model = new CountModel(5);
  for (const p of paths) {
    const toks = tokensOf.get(p);
    if (toks.length) model.addFileTokens(toks);
  }
  model.finalize();
  return model;
}

function runSweep(mode) {
  const rows = [];
  let sawHit = false;
  let sawMiss = false;
  // Bounded on purpose. In `random` mode every edited file sees the same tab set, so one
  // entry serves a whole row and the cache is pure win. In `sibling` mode the tab set is
  // keyed on the edited file, so entries are almost never reused -- and an unbounded map
  // then holds one index per (edited document x sweep point), which on a 2,000-file corpus
  // is thousands of live count tables and a heap-limit abort partway through the run. A
  // harness that dies on the large corpora is one that only ever reports the small ones.
  const MODEL_CACHE = 8;
  const modelCache = new Map();
  const cacheModel = (key, make) => {
    const hit = modelCache.get(key);
    if (hit) return hit;
    const built = make();
    if (modelCache.size >= MODEL_CACHE) modelCache.delete(modelCache.keys().next().value);
    modelCache.set(key, built);
    return built;
  };

  for (const n of sweep) {
    if (n > pool.length) continue;
    const hits = { hybrid: [], buf: [], cur: [], all: [] };
    let recSeen = 0;
    let recTotal = 0;
    let tokens = 0;
    let tokenSamples = 0;

    let lastFile = null;
    let completer = null;
    // Independent of the open-document set, so it is built once and keeps its buffer
    // across the sweep exactly as the hybrid's does.
    const bufOnly = new Completer(emptyModel, { cacheBeta: 1 });
    let model = null;
    let openTokens = null;

    for (const { file, at } of positions) {
      if (file !== lastFile) {
        const tabs = tabsFor(n, file, mode);
        model = cacheModel(tabs.join(" "), () => buildModel(tabs));
        openTokens = tabs.map((p) => tokensOf.get(p));
        completer = new Completer(model, { cacheBeta: 0.5 });
        lastFile = file;
        tokens += model.nTokens;
        tokenSamples++;
      }

      const toks = tokensOf.get(file);
      const prev = toks.slice(0, at);
      const truth = toks[at];
      const prefix = truth[0];
      completer.setBuffer(prev);
      bufOnly.setBuffer(prev);

      recTotal++;
      if (model.tabs[4].has(prev.slice(at - 4).join(" "))) recSeen++;

      const lists = {
        hybrid: completer.suggest(prev, { k: K, prefix }),
        buf: bufOnly.suggest(prev, { k: K, prefix }),
        cur: rankWords([prev], "recency", prefix).slice(0, K),
        // The current buffer is itself an open document, and the words ABOVE the cursor
        // are the only part of it either side could have seen. Text below the cursor is
        // not written yet at this position.
        all: rankWords([...openTokens, prev], "freq", prefix).slice(0, K),
      };
      for (const arm of Object.keys(hits)) {
        const hit = lists[arm][0] === truth;
        hits[arm].push(hit ? 1 : 0);
        if (hit) sawHit = true;
        else sawMiss = true;
      }
    }

    const mean = (xs) => xs.reduce((s, x) => s + x, 0) / xs.length;
    rows.push({
      open: n,
      tokens: Math.round(tokens / Math.max(1, tokenSamples)),
      recital: recSeen / recTotal,
      acc: {
        hybrid: mean(hits.hybrid),
        buf: mean(hits.buf),
        cur: mean(hits.cur),
        all: mean(hits.all),
      },
      vsCur: mcnemar(hits.hybrid, hits.cur),
      vsAll: mcnemar(hits.hybrid, hits.all),
      vsBuf: mcnemar(hits.hybrid, hits.buf),
      // Neither arm reads the open documents, so this pair is identical in every row.
      // It is carried on the row anyway because it is the whole answer for the embedding
      // that has exactly one document -- a docs page, an admin console, a config editor
      // -- where the sweep above has no rows to give.
      bufVsCur: mcnemar(hits.buf, hits.cur),
    });
  }

  if (!rows.length) {
    console.error(
      `GATE: no sweep point fits -- the pool holds ${pool.length} documents and the smallest ` +
        `requested open-document count is ${sweep[0]}.`
    );
    process.exit(2);
  }
  if (!sawHit || !sawMiss) {
    console.error(
      `GATE: the scorer was never observed producing both a hit and a miss ` +
        `(hit=${sawHit}, miss=${sawMiss}). A scorer that cannot do both is not measuring.`
    );
    process.exit(2);
  }
  return rows;
}

const report = {
  corpus: dirs.join(" + "),
  language: langSpec || "javascript (default)",
  pool: pool.length,
  editedDocuments: new Set(positions.map((p) => p.file)).size,
  positions: positions.length,
  sweep: {},
  thresholds: {},
};
if (collected.duplicates > 0) report.duplicates = collected.duplicates;

const pct = (x) => (100 * x).toFixed(1);
const modes = tabMode === "both" ? ["random", "sibling"] : [tabMode];

say(`\n=== ${dirs.join(" + ")}${langSpec ? `   [--lang ${langSpec}]` : ""}`);
if (collected.duplicates > 0) {
  say(
    `NOTE: ${collected.duplicates} file${collected.duplicates === 1 ? "" : "s"} were reachable through ` +
      `more than one of those paths, and were counted once.`
  );
}
const boiler = boilerplateShare(positions);
report.boilerplate = boiler;
say(
  `${positions.length} identifier positions across ${report.editedDocuments} edited documents, ` +
    `with a pool of ${pool.length} others to open.`
);
say(
  `BOILERPLATE: ${pct(boiler.inHalf)}% of those positions sit on a context that more than half ` +
    `the other files also carry\n` +
    `             (${pct(boiler.inQuarter)}% at a quarter of them). ` +
    (boiler.inHalf >= 0.25
      ? `That is a license header or a generated\n` +
        `             preamble, and it is what this sweep will mostly be measuring. Read the rows\n` +
        `             as a property of that boilerplate rather than of the corpus's code.`
      : boiler.inQuarter >= 0.4
        ? `No single header runs through the whole corpus, but a quarter of it\n` +
          `             shares that much: a tree of near-identical files -- CRUD scaffolds, route\n` +
          `             modules, rule definitions. That repetition is the high-recital band by\n` +
          `             construction, so read this corpus as the optimistic end rather than the middle.`
        : `Low enough that the rows are about the code.`)
);
say(`Every row below is scored on those SAME positions. Only the open-document set changes.`);

for (const mode of modes) {
  const rows = runSweep(mode);
  report.sweep[mode] = rows;
  say(
    `\n--- tab set: ${mode}` +
      (mode === "random"
        ? "   (documents sampled from anywhere -- pessimistic)"
        : "   (documents nearest by path -- optimistic, and closer to a real tab set)")
  );
  say(
    `  ${"open".padStart(4)}  ${"tokens".padStart(8)}  ${"recital".padStart(7)}  ` +
      `${"lexindex".padStart(8)}  ${"buf only".padStart(8)}  ${"cur doc".padStart(8)}  ` +
      `${"all open".padStart(8)}  ${"z vs cur".padStart(8)}  ${"z vs all".padStart(8)}  ` +
      `${"z vs buf".padStart(8)}`
  );
  for (const r of rows) {
    const flag = (m) => (m.z >= 1.96 ? " " : "*");
    say(
      `  ${String(r.open).padStart(4)}  ${r.tokens.toLocaleString().padStart(8)}  ` +
        `${(pct(r.recital) + "%").padStart(7)}  ${(pct(r.acc.hybrid) + "%").padStart(8)}  ` +
        `${(pct(r.acc.buf) + "%").padStart(8)}  ${(pct(r.acc.cur) + "%").padStart(8)}  ` +
        `${(pct(r.acc.all) + "%").padStart(8)}  ` +
        `${r.vsCur.z.toFixed(2).padStart(7)}${flag(r.vsCur)} ${r.vsAll.z.toFixed(2).padStart(7)}${flag(r.vsAll)} ` +
        `${r.vsBuf.z.toFixed(2).padStart(7)}${flag(r.vsBuf)}`
    );
  }
  say(`  * = NULL, not a difference (|z| < 1.96)`);

  // The numbers the decision turns on, said in words rather than left in a table. The
  // second is the one that matters: beating the current document alone can be had by
  // reading more documents, which needs no model.
  const firstCur = rows.find((r) => r.vsCur.z >= 1.96 && r.acc.hybrid > r.acc.cur);
  const firstAll = rows.find((r) => r.vsAll.z >= 1.96 && r.acc.hybrid > r.acc.all);
  const firstBuf = rows.find((r) => r.vsBuf.z >= 1.96 && r.acc.hybrid > r.acc.buf);
  const band = rows.find((r) => r.recital >= 0.359);
  report.thresholds[mode] = {
    beatsCurrentDocumentAt: firstCur ? firstCur.open : null,
    beatsAllOpenDocumentsAt: firstAll ? firstAll.open : null,
    beatsCacheAloneAt: firstBuf ? firstBuf.open : null,
    cacheAloneVsEditorWordList: { acc: rows[0].acc.buf, editor: rows[0].acc.cur, z: rows[0].bufVsCur.z },
    reaches36PctRecitalAt: band ? band.open : null,
  };
  say(
    `  VERDICT: beats the current document's word list from ` +
      `${firstCur ? `${firstCur.open} open documents` : "NO row in this sweep"}; ` +
      `beats all open documents' words from ` +
      `${firstAll ? `${firstAll.open} open documents` : "NO row in this sweep"}.`
  );
  const b0 = rows[0];
  say(
    `  ONE DOCUMENT: with nothing else indexed, the cache alone gives ` +
      `${pct(b0.acc.buf)}% against the editor's ${pct(b0.acc.cur)}% ` +
      `(z=${b0.bufVsCur.z.toFixed(2)}${b0.bufVsCur.z >= 1.96 ? "" : ", NULL"}). ` +
      `That row needs no open documents at all.`
  );
  say(
    `  REACH: reading the other open documents first pays at ` +
      `${firstBuf ? `${firstBuf.open} open documents` : "NO row in this sweep"}` +
      `${firstBuf ? "" : " -- below that the cache alone is the whole result"}.`
  );
  say(
    `  recital crosses the 35.9% band at ` +
      `${band ? `${band.open} open documents` : "NO row in this sweep"} -- ` +
      recitalBand(band ? band.recital : rows[rows.length - 1].recital)
  );
}

if (asJson) console.log(JSON.stringify(report, null, 2));
