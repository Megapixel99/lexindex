#!/usr/bin/env node
/**
 * The line feature as a PAGE sees it, which is not how the repository tools see it.
 *
 * usage: node tools/measure-line-docs.mjs [--tabs 1,2,3,5,10,20] [--policy near|random|both]
 *                                         [--trials 40] [--positions 40] <dir>...
 *
 * `tools/measure-line.mjs` indexes a repository and predicts a disjoint one. A CodeMirror
 * or Monaco embedding has neither: it has the handful of documents somebody has open, and
 * the one holding the cursor is deliberately NOT among them — indexing the document being
 * edited would feed back the very line it is asked to predict. So the free variable here is
 * not which repository, it is HOW MANY TABS, which is what this sweeps.
 *
 * Two policies, because which tabs are open is not random in real life:
 *
 *   near    the other documents are the active one's directory neighbours, which is what
 *           somebody working on one area of a codebase actually has open
 *   random  drawn from anywhere in the tree, the pessimistic case
 *
 * Seeded, so the rows reproduce. SEED=0 unless you set it.
 */
import fs from "node:fs";
import path from "node:path";
import { collectFiles } from "../src/build.js";
import { lex } from "../src/lex.js";
import { DocumentSet } from "../src/documents.js";
import { DEFAULT_MIN_CONFIDENCE, localIndexFor } from "../src/line-index.js";

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(name);
  if (i === -1) return fallback;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const TABS = opt("--tabs", "1,2,3,5,10,20").split(",").map(Number);
const POLICY = opt("--policy", "both");
const TRIALS = Number(opt("--trials", "40"));
const POSITIONS = Number(opt("--positions", "40"));
const FLOOR = Number(opt("--min-confidence", String(DEFAULT_MIN_CONFIDENCE)));
/** Same escape hatch as measure-line.mjs, and for the same reason: corpus choice. */
const EXCLUDE = opt("--exclude", null);
const excludeRe = EXCLUDE === null ? null : new RegExp(EXCLUDE);
const dirs = argv.filter((a) => !a.startsWith("--"));
if (dirs.length === 0) {
  console.error("usage: node tools/measure-line-docs.mjs [options] <dir>...");
  process.exit(2);
}

/** Deterministic PRNG, so a published row can be re-run rather than believed. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const SEED = Number(process.env.SEED ?? 0);

const files = collectFiles(dirs)
  .filter((p) => !excludeRe || !excludeRe.test(p))
  .map((p) => {
    try {
      return { path: p, text: fs.readFileSync(p, "utf8") };
    } catch {
      return null;
    }
  })
  .filter(Boolean);
if (files.length < 2) {
  console.error("measure-line-docs: need at least two documents");
  process.exit(2);
}

const linesOf = (text) =>
  text
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => ({ text: r, tokens: lex(r) }))
    .filter((l) => l.tokens.length);

/** Companions for an active document, under one policy. */
function companions(active, n, pick) {
  if (n <= 0) return [];
  const others = files.filter((f) => f !== active);
  const dir = path.dirname(active.path);
  const ordered =
    pick === "near"
      ? others.slice().sort((a, b) => {
          const da = path.dirname(a.path) === dir ? 0 : 1;
          const db = path.dirname(b.path) === dir ? 0 : 1;
          return da - db;
        })
      : others;
  if (pick === "near") return ordered.slice(0, n);
  const out = [];
  const rand = rng(SEED + 7);
  const pool = ordered.slice();
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

function measure(tabs, policy) {
  const rand = rng(SEED);
  let n = 0, offered = 0, exact = 0, top3 = 0, unseen = 0, localOnly = 0;

  for (let t = 0; t < TRIALS; t++) {
    const active = files[Math.floor(rand() * files.length)];
    const lines = linesOf(active.text);
    if (lines.length < 8) continue;

    const docs = new DocumentSet({ lineIndex: true });
    for (const c of companions(active, tabs - 1, policy)) docs.open(c.path, c.text);
    docs.open(active.path, active.text);
    docs.activate(active.path);

    // Sample positions rather than walking every line: this is a sweep, not a census.
    const step = Math.max(1, Math.floor(lines.length / POSITIONS));
    const buf = [];
    for (let i = 0; i < lines.length; i++) {
      if (i >= 3 && i % step === 0) {
        n++;
        // The trailing newline is not cosmetic: it is what puts the cursor at the START
        // of a line, which is the only position a whole-line suggestion is offered at.
        // Without it every row of this table reads 0.0%, which is how the bug announced
        // itself the first time.
        const above = buf.join("\n") + "\n";
        const got = docs.lineSuggestions(above, { minConfidence: FLOOR });
        if (got.length) {
          offered++;
          if (got[0].text === lines[i].text) exact++;
          if (got.some((c) => c.text === lines[i].text)) top3++;
          // Where did the winning candidate come from? "<buffer>" means the open
          // documents contributed nothing and the prefix carried it alone.
          if (got[0].file === "<buffer>") localOnly++;
        } else if (docs.lines.candidates(above, { local: localIndexFor(above) }).length === 0) {
          // Nothing anywhere -- not in the other tabs, not in the text above the cursor.
          unseen++;
        }
      }
      buf.push(lines[i].text);
      if (buf.length > 80) buf.shift();
    }
  }
  return {
    n,
    offer: (100 * offered) / n,
    exact: offered ? (100 * exact) / offered : 0,
    top3: offered ? (100 * top3) / offered : 0,
    unseen: (100 * unseen) / n,
    fromBuffer: offered ? (100 * localOnly) / offered : 0,
  };
}

console.log(
  `${files.length} documents in the universe | SEED=${SEED} | ${TRIALS} trials, ` +
    `~${POSITIONS} positions each | floor ${FLOOR}` + (EXCLUDE ? ` | excluding ${excludeRe}` : ""),
);
const policies = POLICY === "both" ? ["near", "random"] : [POLICY];
for (const policy of policies) {
  console.log(`\n  tabs open, companions drawn ${policy === "near" ? "from the same directory" : "at random"}`);
  console.log(`  tabs  positions   offers   exact   top3   never-seen   won by the buffer alone`);
  for (const tabs of TABS) {
    const r = measure(tabs, policy);
    console.log(
      `  ${String(tabs).padStart(4)}  ${String(r.n).padStart(9)}   ` +
        `${r.offer.toFixed(1).padStart(5)}%  ${r.exact.toFixed(1).padStart(5)}%  ${r.top3.toFixed(1).padStart(5)}%   ` +
        `${r.unseen.toFixed(1).padStart(9)}%   ${r.fromBuffer.toFixed(1).padStart(21)}%`,
    );
  }
}
