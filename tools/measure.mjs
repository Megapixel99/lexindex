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
 * It also measures the RE-RANKING use, which is the README's strongest claim and used to
 * be the one thing shipped here could not check on your own repo. See the section below
 * for what candidate list it uses and why that list rather than a language server's.
 *
 * GATES. The harness refuses rather than reporting a number it cannot support: too few
 * files, zero scored positions, or a scorer that never produced both a hit and a miss.
 * A clean result from an instrument that could not fail is worthless — this project's
 * sibling tool reported "0 findings over 8,595 files" while silently discarding all of
 * them, and only a positive control caught it.
 *
 *     --json    the same measurements as one JSON object, for automation
 */

import fs from "node:fs";
import { lex, isWord } from "../src/lex.js";
import { CountModel, recitalBand } from "../src/count-model.js";
import { Completer } from "../src/completer.js";
import { collectFiles } from "../src/build.js";

const HOLDOUT = Number(process.env.HOLDOUT || 0.2);
const PER_FILE = Number(process.env.PERFILE || 25); // an uncapped harness once drew 400
const SEED = Number(process.env.SEED || 0);         // cases from six files. Cap it.
const K = 5;

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const dirs = argv.filter((a) => a !== "--json");
if (!dirs.length) {
  console.error("usage: measure.mjs [--json] <dir>...");
  process.exit(2);
}
/** Everything printed, also collected so --json can emit it without a second pass. */
const report = { corpus: dirs.join(" + ") };
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

  const hybrid = arms["HYBRID           (beta=0.5)"];

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

  // ---- the re-ranking use --------------------------------------------------
  //
  // The README's strongest claim is that reordering somebody else's candidate list beats
  // the order they shipped it in, and until now nothing here could check that on your own
  // repo. It does not need a language server to check: the list an ordinary editor offers
  // is the words already in your buffer, which is a REAL candidate list rather than a
  // synthetic one, and it is the same baseline the rest of this harness measures against.
  // What is measured is exactly the shipped `rerankTokens`, not a copy of its arithmetic.
  //
  // Two exclusions, both load-bearing, both reported rather than buried:
  //   - a list of one candidate makes every possible ordering correct whenever it is the
  //     truth, so those positions are dropped; leaving them in would inflate every row
  //     equally and the comparison with it
  //   - re-ranking returns a permutation, so it cannot invent an answer that was never
  //     offered; positions where the truth is not in the list are counted as COVERAGE and
  //     scored separately, because that is the language server's job and not this one's
  const RERANK_LONG_LIST = 10;
  const RERANK_MIN_POSITIONS = 30;
  const rerankOrderings = ["your editor's order (recency)", "by frequency", "reordered by this index"];
  const rr = {};
  const rrHits = {};
  for (const n of rerankOrderings) {
    rr[n] = { hit: 0, short: 0, long: 0 };
    rrHits[n] = [];
  }
  let rrOffered = 0;
  let rrTrivial = 0;
  let rrUncovered = 0;
  let rrScored = 0;
  let rrShort = 0;
  let rrLong = 0;

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

      if (identCase) {
        const offered = bufferWords(prev, "recency", prefix);
        rrOffered++;
        if (offered.length < 2) {
          rrTrivial++;
        } else if (!offered.includes(truth)) {
          rrUncovered++;
        } else {
          rrScored++;
          const long = offered.length >= RERANK_LONG_LIST;
          if (long) rrLong++;
          else rrShort++;

          const ordered = {
            "your editor's order (recency)": offered,
            "by frequency": bufferWords(prev, "freq", prefix),
            "reordered by this index": hybrid.rerankTokens(offered, prev),
          };
          for (const n of rerankOrderings) {
            const hit = ordered[n][0] === truth;
            if (hit) {
              rr[n].hit++;
              rr[n][long ? "long" : "short"]++;
            }
            rrHits[n].push(hit ? 1 : 0);
          }
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
  const rate = (n, d) => (d ? n / d : null);

  report.index = { files: train.length, tokens: model.nTokens, ms: indexMs, heldFiles: heldUsed, heldCandidates: held.length };
  report.recital = rate(recSeen, recTotal);
  report.positions = { scored, identifier: identScored };
  report.arms = {};
  for (const n of names) {
    report.arms[n] = { top1: rate(acc[n].t1, scored), top5: rate(acc[n].t5, scored), identT1: rate(acc[n].identT1, identScored) };
  }

  say(`\n=== ${dir}`);
  say(
    `index: ${train.length} files, ${model.nTokens.toLocaleString()} tokens, ${indexMs} ms` +
      `   held out: ${heldUsed}/${held.length} files`
  );
  say(`RECITAL: ${pct(recSeen, recTotal)}% of held-out 4-token contexts were already in the index`);
  say(`         ${recitalBand(rate(recSeen, recTotal) || 0)}`);
  say(`\n  ${"arm".padEnd(52)} top-1    top-5    ident+1char`);
  for (const n of names) {
    const a = acc[n];
    say(
      `  ${n.padEnd(52)} ${pct(a.t1, scored).padStart(6)}  ${pct(a.t5, scored).padStart(6)}` +
        `   ${pct(a.identT1, identScored).padStart(6)}`
    );
  }

  const editor = "baseline: buffer words by recency  (your editor)";
  report.paired = {};
  say(`\n  paired vs "${editor}" on ident+1char (McNemar):`);
  for (const n of Object.keys(arms)) {
    const r = mcnemar(identHits[n], identHits[editor]);
    report.paired[n] = { ...r, significant: r.z >= 1.96 };
    const verdict = r.z >= 1.96 ? "" : "   ← NULL, not a difference";
    say(
      `    ${n.padEnd(30)} ${String(r.aOnly).padStart(4)}:${String(r.bOnly).padEnd(4)} of ${String(r.n).padEnd(5)} z=${r.z.toFixed(2)}${verdict}`
    );
  }

  // ---- re-ranking ----------------------------------------------------------
  const reference = "your editor's order (recency)";
  const mine = "reordered by this index";
  report.rerank = {
    offered: rrOffered,
    droppedSingleCandidate: rrTrivial,
    truthNotInList: rrUncovered,
    scored: rrScored,
    coverage: rate(rrScored, rrOffered - rrTrivial),
  };

  say(`\n  RE-RANKING the list your editor would offer (buffer words, prefix-filtered):`);
  if (rrScored < RERANK_MIN_POSITIONS) {
    // Same refusal the rest of the harness makes: a number this thin cannot be read.
    // The paired test needs discordant pairs, and a few dozen scorable positions rarely
    // produce enough of them for the z to mean anything.
    const why =
      `only ${rrScored} scorable positions (${rrOffered} identifier positions offered a list, ` +
      `${rrTrivial} had a single candidate, ${rrUncovered} did not contain the truth)`;
    report.rerank.refused = why;
    say(`    CANNOT SUPPORT A NUMBER: ${why}.`);
    say(`    Re-ranking is a permutation, so it needs a list of at least two that holds the answer.`);
  } else {
    report.rerank.orderings = {};
    for (const n of rerankOrderings) {
      report.rerank.orderings[n] = {
        top1: rate(rr[n].hit, rrScored),
        top1ShortLists: rate(rr[n].short, rrShort),
        top1LongLists: rate(rr[n].long, rrLong),
      };
    }
    say(`    ${"ordering".padEnd(30)} top-1     lists <${RERANK_LONG_LIST}   lists >=${RERANK_LONG_LIST}`);
    for (const n of rerankOrderings) {
      say(
        `    ${n.padEnd(30)} ${pct(rr[n].hit, rrScored).padStart(6)}    ` +
          `${pct(rr[n].short, rrShort).padStart(6)}    ${pct(rr[n].long, rrLong).padStart(6)}`
      );
    }
    const rm = mcnemar(rrHits[mine], rrHits[reference]);
    report.rerank.paired = { ...rm, significant: rm.z >= 1.96 };
    say(
      `\n    paired vs "${reference}" (McNemar):  ${rm.aOnly}:${rm.bOnly} of ${rm.n}   ` +
        `z=${rm.z.toFixed(2)}${rm.z >= 1.96 ? "" : "   ← NULL, not a difference"}`
    );
    say(
      `    coverage: the truth was in the offered list at ${pct(rrScored, rrOffered - rrTrivial)}% of ` +
        `positions; re-ranking cannot help at the rest, which is the language server's job.`
    );
    say(
      `    excluded: ${rrTrivial} positions offered a single candidate, where every ordering is right.`
    );
  }

  report.complete = { scored, identifier: identScored, heldFiles: heldUsed, rerankScored: rrScored };
  say(
    `\nCOMPLETE : ${scored} positions scored (${identScored} identifier, ${rrScored} re-ranked) ` +
      `across ${heldUsed} held-out files`
  );
  if (asJson) console.log(JSON.stringify(report, null, 2));
}
