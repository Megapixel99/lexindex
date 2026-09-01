#!/usr/bin/env node
/**
 * Re-derive the `--line` numbers quoted in the README, on your own code.
 *
 * usage: node tools/measure-line.mjs <corpus-dir>... -- <held-out-dir>...
 *
 * The two sides must be DISJOINT. Predicting lines of a file that is in the index measures
 * nothing except that a hash table works: every context resolves to the line that follows
 * it in that very file. The script refuses overlapping roots rather than quietly reporting
 * a number near 100%.
 *
 * Both arms run the shipped class, so this compares the current ranking against the plain
 * single-width lookup it replaced rather than against a description of it:
 *
 *   before  new LineIndex({ widths: [4] }), no local model, minConfidence 0
 *   after   the defaults
 *
 * Coverage and exactness trade against each other, so the honest comparison holds coverage
 * fixed: the threshold sweep finds the point where "after" answers as often as "before"
 * did, and reports exactness there.
 */
import fs from "node:fs";
import path from "node:path";
import { collectFiles } from "../src/build.js";
import { lex } from "../src/lex.js";
import { LineIndex, localIndex, LINE_WIDTHS, DEFAULT_MIN_CONFIDENCE } from "../src/line-index.js";

const argv = process.argv.slice(2);
const split = argv.indexOf("--");
if (split === -1 || split === 0 || split === argv.length - 1) {
  console.error("usage: node tools/measure-line.mjs <corpus-dir>... -- <held-out-dir>...");
  process.exit(2);
}
const corpusDirs = argv.slice(0, split);
const evalDirs = argv.slice(split + 1);

/** Refuse the mistake that makes every number look wonderful. */
for (const c of corpusDirs) {
  for (const e of evalDirs) {
    const a = path.resolve(c);
    const b = path.resolve(e);
    if (a === b || a.startsWith(b + path.sep) || b.startsWith(a + path.sep)) {
      console.error(`measure-line: ${c} and ${e} overlap — held-out code must not be indexed`);
      process.exit(2);
    }
  }
}

const read = (dirs) =>
  collectFiles(dirs)
    .map((p) => {
      try {
        return { path: p, text: fs.readFileSync(p, "utf8") };
      } catch {
        return null;
      }
    })
    .filter(Boolean);

/** Non-blank lines, as the index itself splits them. */
function linesOf(text) {
  const out = [];
  for (const raw of text.split("\n")) {
    const t = raw.trim();
    if (!t) continue;
    const toks = lex(t);
    if (toks.length) out.push({ text: t, tokens: toks });
  }
  return out;
}

/** How much of the true line the suggestion got before its first mistake. */
function prefixAgreement(pred, truth) {
  let k = 0;
  while (k < pred.length && k < truth.length && pred[k] === truth[k]) k++;
  return truth.length ? k / truth.length : 0;
}

/** Only the tail of the buffer can match anything, and it keeps this loop linear. */
const TAIL = 40;

function measure(corpus, evalFiles, { old = false, threshold = DEFAULT_MIN_CONFIDENCE } = {}) {
  const ix = new LineIndex(old ? { widths: [4] } : {});
  for (const f of corpus) ix.addFile(f.path, f.text);
  ix.finalize();

  let n = 0, offered = 0, exact = 0, top3 = 0, prefixSum = 0, unseen = 0;
  for (const f of evalFiles) {
    const lines = linesOf(f.text);
    const buf = [];
    for (let i = 0; i < lines.length; i++) {
      if (i >= 3) {
        n++;
        const above = buf.join("\n");
        // The buffer above the cursor only — never the line being predicted, or any after.
        const local = old ? null : localIndex(buf.slice(-TAIL).join("\n"));
        const ranked = ix.candidates(above, { local });
        const hit = ix.lookup(above, { local, minConfidence: old ? 0 : threshold });
        if (hit) {
          offered++;
          if (hit.text === lines[i].text) exact++;
          if (ranked.slice(0, 3).some((c) => c.text === lines[i].text)) top3++;
          prefixSum += prefixAgreement(lex(hit.text), lines[i].tokens);
        }
        if (ranked.length === 0) unseen++;
      }
      buf.push(lines[i].text);
      if (buf.length > TAIL * 2) buf.shift();
    }
  }
  return {
    n,
    offer: (100 * offered) / n,
    exact: offered ? (100 * exact) / offered : 0,
    prefix: offered ? (100 * prefixSum) / offered : 0,
    top3: (100 * top3) / n,
    unseen: (100 * unseen) / n,
  };
}

const corpus = read(corpusDirs);
const evalFiles = read(evalDirs);
if (corpus.length === 0 || evalFiles.length === 0) {
  console.error("measure-line: need files on both sides");
  process.exit(2);
}

console.log(`widths [${LINE_WIDTHS}]  default floor ${DEFAULT_MIN_CONFIDENCE}`);
console.log(`corpus ${corpus.length} files | held out ${evalFiles.length} files`);

const before = measure(corpus, evalFiles, { old: true });
console.log(`${before.n} line positions\n`);

const row = (label, r) =>
  console.log(
    `${label.padEnd(30)} offer ${r.offer.toFixed(1).padStart(5)}%  exact ${r.exact.toFixed(1).padStart(5)}%  ` +
      `prefix ${r.prefix.toFixed(1).padStart(5)}%  top3 ${r.top3.toFixed(1).padStart(5)}%`,
  );

row("before (widths [4], no floor)", before);
const now = measure(corpus, evalFiles, {});
row(`after (floor ${DEFAULT_MIN_CONFIDENCE})`, now);
console.log(`${"".padEnd(30)} never-seen ${now.unseen.toFixed(1)}% of positions`);

// Hold coverage fixed, so the comparison is not just "answers more often".
let matched = null;
for (let t = 0; t <= 0.8; t += 0.02) {
  const r = measure(corpus, evalFiles, { threshold: t });
  if (!matched || Math.abs(r.offer - before.offer) < Math.abs(matched.offer - before.offer)) {
    matched = { ...r, t };
  }
}
row(`after (floor ${matched.t.toFixed(2)}, matched)`, matched);
console.log(
  `\nat matched coverage: exact ${(matched.exact - before.exact >= 0 ? "+" : "")}${(matched.exact - before.exact).toFixed(1)} pts, ` +
    `prefix ${(matched.prefix - before.prefix >= 0 ? "+" : "")}${(matched.prefix - before.prefix).toFixed(1)} pts, ` +
    `top3 ${(matched.top3 - before.top3 >= 0 ? "+" : "")}${(matched.top3 - before.top3).toFixed(1)} pts`,
);
