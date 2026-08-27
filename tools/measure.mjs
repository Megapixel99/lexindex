#!/usr/bin/env node
/**
 * Does this actually beat what your editor already does for free?
 *
 *     node tools/measure.mjs <dir>...
 *
 * That is the only question worth asking about a completion engine, and it is the one
 * most completion benchmarks avoid by reporting an accuracy with nothing beside it. Every
 * editor already offers the words in your open buffers ranked by fuzzy match; a tool that
 * does not beat that is worth nothing however good its number looks alone.
 *
 * So this reports the arms AND the baselines, on the same held-out positions, with a
 * paired significance test — and it leads with `ident+1char`, the accuracy after one
 * character of an identifier has been typed, because that is what a user experiences.
 * Aggregate top-1 is mostly punctuation and flatters everything.
 *
 * It also reports the RECITAL RATE: how often a held-out 4-token context was already in
 * the index. That is the honest predictor of whether this tool helps on your repo.
 * Measured across eight corpora it ran 72.9% down to 13.5%, and at 13.5% the advantage
 * over an ordinary word list was NULL.
 *
 * GATES. The harness refuses rather than reporting a number it cannot support: too few
 * files, zero scored positions, or a scorer that never produced both a hit and a miss.
 * A clean result from an instrument that could not fail is worthless — this project's
 * sibling tool reported "0 findings over 8,595 files" while silently discarding all of
 * them, and only a positive control caught it.
 */

import fs from "node:fs";
import { lex, isWord } from "../src/lex.js";
import { CountModel } from "../src/count-model.js";
import { Completer } from "../src/completer.js";
import { collectFiles } from "../src/build.js";

const HOLDOUT = Number(process.env.HOLDOUT || 0.2);
const PER_FILE = Number(process.env.PERFILE || 25); // an uncapped harness once drew 400
const SEED = Number(process.env.SEED || 0);         // cases from six files. Cap it.
const K = 5;

const dirs = process.argv.slice(2);
if (!dirs.length) {
  console.error("usage: measure.mjs <dir>...");
  process.exit(2);
}

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

/** Words in the buffer, deduplicated and ranked — what every editor already gives you. */
function bufferWords(buf, mode, prefix) {
  const last = new Map();
  const freq = new Map();
  for (let i = 0; i < buf.length; i++) {
    const w = buf[i];
    if (!isWord(w)) continue;
    last.set(w, i);
    freq.set(w, (freq.get(w) || 0) + 1);
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
  const z = n ? Math.abs(aOnly - bOnly) / Math.sqrt(n) : 0;
  return { aOnly, bOnly, n, z };
}

// Several directories are ONE corpus, matching buildIndex(). A repo whose JS is spread
// over three folders is still one repo, and splitting it into three tiny corpora would
// report three underpowered nulls instead of one answer.
{
  const dir = dirs.join(" + ");
  let files = [];
  for (const d of dirs) files.push(...collectFiles(d));
  if (files.length < 4) {
    console.error(`GATE: ${dir} has ${files.length} indexable files; need at least 4 to hold any out.`);
    process.exit(2);
  }
  shuffle(files, SEED);
  const nHold = Math.max(1, Math.floor(files.length * HOLDOUT));
  const held = files.slice(0, nHold);
  const train = files.slice(nHold);

  const model = new CountModel(5);
  const t0 = Date.now();
  for (const p of train) {
    const toks = lex(fs.readFileSync(p, "utf8"));
    if (toks.length) model.addFileTokens(toks);
  }
  model.finalize();
  const indexMs = Date.now() - t0;

  const arms = {
    "repo index only  (beta=0)": new Completer(model, { cacheBeta: 0 }),
    "buffer only      (beta=1)": new Completer(model, { cacheBeta: 1 }),
    "HYBRID           (beta=0.5)": new Completer(model, { cacheBeta: 0.5 }),
  };
  const names = [
    ...Object.keys(arms),
    "baseline: buffer words by recency  (your editor)",
    "baseline: buffer words by frequency",
    "baseline: repo identifiers by frequency (ctags-like)",
  ];

  const identHits = {};
  for (const n of names) identHits[n] = [];
  const acc = {};
  for (const n of names) acc[n] = { t1: 0, t5: 0, identT1: 0 };

  let scored = 0;
  let identScored = 0;
  let recSeen = 0;
  let recTotal = 0;
  let sawHit = false;
  let sawMiss = false;
  let heldUsed = 0;

  for (const p of held) {
    const toks = lex(fs.readFileSync(p, "utf8"));
    if (toks.length < 8) continue;
    heldUsed++;
    const stride = Math.max(1, Math.floor((toks.length - 2) / PER_FILE));
    for (const c of Object.values(arms)) c.cache = null;

    for (let t = 4; t < toks.length; t += stride) {
      const prev = toks.slice(0, t);
      const truth = toks[t];
      for (const c of Object.values(arms)) c.setBuffer(prev);

      recTotal++;
      if (model.tabs[4].has(prev.slice(t - 4).join(" "))) recSeen++;

      // `ident+1char`: the identifier case, after one character has been typed. This is
      // the number a user feels; the aggregate is mostly punctuation.
      const identCase = isWord(truth);
      const prefix = identCase ? truth[0] : null;
      scored++;
      if (identCase) identScored++;

      for (const name of names) {
        let list;
        if (arms[name]) {
          list = arms[name].suggest(prev, { k: K, prefix: null });
        } else if (name.includes("recency")) {
          list = bufferWords(prev, "recency", null).slice(0, K);
        } else if (name.includes("buffer words by frequency")) {
          list = bufferWords(prev, "freq", null).slice(0, K);
        } else {
          list = model.wordsByFrequency.slice(0, K);
        }
        if (list[0] === truth) acc[name].t1++;
        if (list.includes(truth)) acc[name].t5++;

        if (identCase) {
          let il;
          if (arms[name]) il = arms[name].suggest(prev, { k: K, prefix });
          else if (name.includes("recency")) il = bufferWords(prev, "recency", prefix).slice(0, K);
          else if (name.includes("buffer words by frequency")) il = bufferWords(prev, "freq", prefix).slice(0, K);
          else il = model.wordsByFrequency.filter((w) => w.startsWith(prefix)).slice(0, K);
          const hit = il[0] === truth;
          if (hit) {
            acc[name].identT1++;
            sawHit = true;
          } else sawMiss = true;
          identHits[name].push(hit ? 1 : 0);
        }
      }
    }
  }

  // ---- gates, before any number is read -----------------------------------
  if (scored === 0) {
    console.error(`GATE: ${dir} produced 0 scored positions. This is not a clean result.`);
    process.exit(2);
  }
  if (!sawHit || !sawMiss) {
    console.error(
      `GATE: the scorer was never observed producing both a hit and a miss ` +
        `(hit=${sawHit}, miss=${sawMiss}). A scorer that cannot do both is not measuring.`
    );
    process.exit(2);
  }

  const pct = (n, d) => (d ? ((100 * n) / d).toFixed(3) : "—");
  console.log(`\n=== ${dir}`);
  console.log(
    `index: ${train.length} files, ${model.nTokens.toLocaleString()} tokens, ${indexMs} ms` +
      `   held out: ${heldUsed}/${held.length} files`
  );
  console.log(
    `RECITAL: ${pct(recSeen, recTotal)}% of held-out 4-token contexts were already in the index` +
      `${recSeen / Math.max(recTotal, 1) < 0.4 ? "   ← below ~40%; expect little" : ""}`
  );
  console.log(`\n  ${"arm".padEnd(52)} top-1    top-5    ident+1char`);
  for (const n of names) {
    const a = acc[n];
    console.log(
      `  ${n.padEnd(52)} ${pct(a.t1, scored).padStart(6)}  ${pct(a.t5, scored).padStart(6)}` +
        `   ${pct(a.identT1, identScored).padStart(6)}`
    );
  }

  const editor = "baseline: buffer words by recency  (your editor)";
  console.log(`\n  paired vs "${editor}" on ident+1char (McNemar):`);
  for (const n of Object.keys(arms)) {
    const r = mcnemar(identHits[n], identHits[editor]);
    const verdict = r.z >= 1.96 ? "" : "   ← NULL, not a difference";
    console.log(
      `    ${n.padEnd(30)} ${String(r.aOnly).padStart(4)}:${String(r.bOnly).padEnd(4)} of ${String(r.n).padEnd(5)} z=${r.z.toFixed(2)}${verdict}`
    );
  }

  console.log(
    `\nCOMPLETE : ${scored} positions scored (${identScored} identifier) across ${heldUsed} held-out files`
  );
}
