# lexindex

[![npm](https://img.shields.io/npm/v/lexindex?label=npm&color=CB3837)](https://www.npmjs.com/package/lexindex)
[![ci](https://github.com/Megapixel99/lexindex/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Megapixel99/lexindex/actions/workflows/ci.yml)
[![license MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Code completion from your own repository's statistics: an n-gram index over the files you already have, blended with a cache over the buffer you are editing. No model file, no network, no telemetry. `dependencies` and `devDependencies` are both empty, which a reader can check in `package.json`.

The counting mechanism is not new work. It is a JavaScript implementation of a well-studied idea (n-gram language models over source code, with a cache for the file being edited), and it was validated against an existing reference implementation before it was trusted: 15 of 15 identical top-5 lists across the full range of the blend parameter. See [Prior art](#prior-art) for the papers.

## One number decides whether this helps you

The recital rate is how often a four-token context in a held-out file was already somewhere in the index; it is the honest predictor of whether any of this is worth installing, and it varies from 13.5% to 72.9% across the nine corpora measured so far.

```sh
npx lexindex /path/to/your/repo --stats
```

| your recital | what to expect | the evidence |
|---|---|---|
| above 60% | the full claim holds; it beats your editor's word list, and it beats a plain frequency table on real identifiers | z=2.90 at 71.2%, z=3.81 at 61.7% |
| 40% to 60% | it still beats your editor's word list, though a ten-line frequency table gets you most of the way | z=0.14 at 46.5%, z=0.58 at 45.3%, both null |
| below 40% | expect little | z=1.62 at 37.9%, null; at 13.5% even the advantage over an ordinary word list was null |

That table is the claim. The accuracies quoted further down are large, but completion accuracy is large everywhere; what varies is whether this tool, rather than something considerably simpler, is what earned them.

The tool says which band you are in rather than letting you discover it: `measure` prints the recital rate, and the CLI prints it with every suggestion, with `below ~40%; expect little` attached when it is low.

## Install

```sh
npm i -D lexindex
```

```sh
npx lexindex ./src --stats                       # index and report what it holds
npx lexindex ./src --at src/server.js:2400 -k 5  # suggest at a byte offset

# the measurement harness ships with the package
node node_modules/lexindex/tools/measure.mjs ./src
```

```js
import { buildIndex, Completer } from "lexindex";

const { index } = buildIndex("./src");
const completer = new Completer(index);

completer.complete("const conf");   // ["config", "configure", ...]
```

## Does it beat what your editor already does for free?

That is the only question worth asking about a completion engine, and it is the one most completion benchmarks avoid by reporting an accuracy with nothing beside it; every editor already offers the words in your open buffers. Run the harness against your own repository and find out. Here is a real application at 45.8% recital:

```
  arm                                                  top-1    top-5    ident+1char
  repo index only  (beta=0)                            38.710  56.129   34.328
  buffer only      (beta=1)                            30.968  53.548   47.761
  HYBRID           (beta=0.5)                          49.677  69.677   56.716
  baseline: buffer words by recency  (your editor)      0.645   9.032   25.373
  baseline: repo identifiers by frequency (ctags-like)  0.645   2.581   13.433

  paired vs "buffer words by recency" on ident+1char (McNemar):
    repo index only  (beta=0)        18:12   of 30    z=1.10   <- NULL, not a difference
    HYBRID           (beta=0.5)      25:4    of 29    z=3.90
```

`ident+1char` is the accuracy after one character of an identifier has been typed, and it is the number to read; aggregate top-1 is mostly punctuation and flatters every engine including this one, since only 25% to 40% of positions are identifiers at all.

Across nine corpora the hybrid beat the word-based baseline in eight, with paired z from 2.98 to 12.65. The ninth was a null, at 13.5% recital.

Several directories are treated as one corpus, matching `buildIndex`. Measuring them separately splits a repository into underpowered samples; on a repository whose JavaScript lives in three folders, that was the difference between three nulls (z=1.13, 0.58, 1.63) and one answer (z=5.74).

```sh
node node_modules/lexindex/tools/measure.mjs ./src ./scripts ./tools   # one index, one result
```

Which half carries the mechanism depends on the same number. On a repetitive repository the index dominates and the cache adds little; below roughly 40% recital the index alone becomes statistically null and only the blend wins. Neither arm is the tool, and that is the argument for the fixed 0.5 blend rather than for either half.

## Re-ranking a language server's list

A TypeScript language server knows what is in scope, though it ranks by static category buckets with no frequency signal at all. Feeding its own candidate list through this index and reordering it, over three TypeScript corpora and 1,596 positions, each truncated at the cursor so that neither side sees the answer:

| ordering | top-1 |
|---|---|
| tsserver's own `sortText` | 47.7% |
| plus buffer recency (VS Code-like) | 64.5% |
| plus repo identifier frequency (a ctags table, about ten lines) | 62% to 75% |
| reordered by this index | **89.4%** |

```js
const reordered = completer.rerank(
  entries.map((e) => e.name),
  document.getText().slice(0, offset)
);
```

Three caveats shrink that a long way, and they should be read before the number is quoted anywhere. The `sortText` tie rate is about 89%, so nine candidates in ten share one bucket and the incumbent ordering is largely alphabetical; roughly half the win is keyword positions, where tsserver ranks `removeEventListener` above `return` (a genuine defect you see in an editor, though a cheap one to beat); and against a plain frequency table on real identifiers, the advantage is conditional on recital in exactly the way the table at the top describes.

So it is two claims, and only the first is unconditional. Against what your editor shows you, reordering wins everywhere measured. Against ten lines of frequency counting, the n-gram machinery earns its keep only on repositories that repeat themselves.

Used this way it does not lose at `foo.` member positions (87.8% against 78.9% pooled, z=2.98), because as a re-ranker it never has to know what is in scope. Where tsserver leaves a long list of 30 or more candidates, reordering stops helping: z=1.86, null.

## What it cannot do

1. **It is not type-aware.** It has no idea what is in scope or which members exist on an object, and standing alone at a `foo.` position a language server beats it outright. Its place is where no language server runs (CodeMirror and Monaco embeddings, plain-JavaScript projects, `cmp-buffer`-style setups), or as the re-ranker described above.
2. **It ranks tokens, not lines.** No ghost text and no multi-token generation; the research this derives from measured whole-line output as right about 1 time in 10 mid-line, and never right past roughly 10 tokens.
3. **Corpus choice changes the answer, and it is easy to fool yourself.** This is the largest free parameter in a completion benchmark, and during development it inflated the headline through three separate doors: a vendored `assets/vendor/` holding 344 third-party libraries (0.567 became 0.809 on the same repository); a fetched research corpus, 1,249 files of 1,266, reached through the `.ts` and `.tsx` extensions rather than a directory name (54.7 became 80.9); and `.claude/worktrees/`, holding 14 whole duplicate copies of the repository. Vendored bundles and duplicated checkouts repeat themselves enormously, and repetition is exactly what this tool measures. Excluded by default for that reason: `node_modules`, `vendor`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.cache`, `.claude`, `.venv`, `venv`, `site-packages`, `.tox`, `__pycache__`, and `*.min.js`. If you widen the net, say what you indexed when you quote the number; a completion accuracy without its corpus definition cannot be read.
4. **Comments and string contents are indexed.** That was checked rather than assumed, and it goes the other way: restricting to code-only positions lowered identifier accuracy on 4 corpora of 6.
5. **A foreign index does not help.** Indexing one project and completing another cost 0.167 to 0.197 top-1, so there is no pretrained corpus to ship, and shipping one would be worse than nothing.

## Seven things it deliberately does not do

Each was implemented, measured, and rejected in the research this derives from. They are absent on purpose, and re-adding one without re-running the measurement would be undoing a result.

| absent | why |
|---|---|
| confidence gating | dominated on both axes, three separate times |
| within-document retrieval instead of a cache | lost three separate times |
| recency decay on cache counts | a clean negative; aggressive decay actively hurts |
| right-context or suffix conditioning | the default never moved |
| degeneracy suppression | filtering repetition removes the best suggestions (0.352 exact against 0.122 overall) |
| whole-line generation | right about 1 time in 10 mid-line, never past roughly 10 tokens |
| a bundled pretrained corpus | 57 times the corpus was worth +0.000 in the configuration a user actually runs |

The last is the load-bearing product decision: the only corpus that pays is the one already on your disk.

## How it works

Witten-Bell interpolated n-grams, orders 0 through 4, keyed by token strings with an unbounded vocabulary. For each context length the weight is `N / (N + T)`, times-seen over distinct-continuations, so a context with many different continuations is distrusted and the mass falls through to a shorter one; there are no tuned constants anywhere in it. A second order-3 model over the tokens above the cursor supplies names the repository has never seen, the two are blended at a fixed 0.5, prefix-filtered, and ranked with deterministic tie-breaking.

The lexer is one regular expression (an identifier, a number, or a single punctuation character), so it is language-agnostic by accident rather than by effort.

## Prior art

The mechanism is published research and this package does not claim it.

- Hindle, Barr, Su, Gabel and Devanbu, [On the Naturalness of Software](https://doi.org/10.1109/ICSE.2012.6227135), ICSE 2012. The paper that established that code is far more repetitive than prose, and that n-grams exploit it.
- Tu, Su and Devanbu, [On the Localness of Software](https://doi.org/10.1145/2635868.2635875), FSE 2014. The cache model over the current file, which is the second half of this package.
- Hellendoorn and Devanbu, [Are Deep Neural Networks the Best Choice for Modeling Source Code?](https://doi.org/10.1145/3106237.3106290), FSE 2017. The refinement, and the argument that a well-built count model is a stronger baseline than it is usually given credit for.
- Franks, Tu, Devanbu and Hellendoorn, [CACHECA: A Cache Language Model Based Code Suggestion Tool](https://doi.org/10.1109/ICSE.2015.228), ICSE 2015. This architecture, shipped inside Eclipse for Java, eleven years ago.
- [SLP-Core](https://github.com/SLP-team/SLP-Core) is the reference implementation of the family, in Java.

The claim here is narrower than any of those: a JavaScript implementation that installs from a package manager, states the condition under which it helps, and ships the harness that checks it.

What the incumbents do instead is worth knowing, because it is what the numbers above are measured against. VS Code's word-based suggestions are a regular-expression scan into a `Set<string>`, capped at 10,000, emitted with no `sortText`, ranked by fuzzy match and bracket-nesting proximity, and scoped to open documents rather than the repository on disk. `tsserver` ranks by static category buckets with no frequency signal. CodeMirror's `completeAnyWord`, Vim's `i_CTRL-N`, `cmp-buffer` and `company-dabbrev-code` are all word sets, and the last of those sorts alphabetically. None of them conditions on the preceding token.

## API

| | |
|---|---|
| `buildIndex(dirs, opts)` | `{ index, files, tokens, ms, candidates, skipped }` |
| `new Completer(index, { cacheBeta })` | `cacheBeta` 0 is repo only, 1 is buffer only, default 0.5 |
| `completer.complete(textBeforeCursor, { k })` | lexes, finds the partial identifier, updates the buffer |
| `completer.rerank(candidates, textBeforeCursor)` | reorders another engine's list; returns a permutation, so nothing is added and nothing is dropped |
| `completer.scoreCandidates(prev, candidates)` | `Map<candidate, score>`, the blend over a supplied set |
| `completer.setBuffer(tokens)` and `.suggest(prev, { k, prefix })` | the lower-level path |
| `index.recitalRate(tokens)` | the number from the table at the top |
| `lex(text)`, `isWord(t)`, `splitAtCursor(text)` | the tokenizer |

`setBuffer` is incremental: extending the previous buffer reuses the cache instead of rebuilding it, which is what keeps the per-keystroke cost flat. On a 369-file, 560K-token index, building takes 1.07 s and a suggestion takes 0.36 ms at the median (p99 3.30 ms).

## Exit codes

| | |
|---|---|
| `0` | ran, produced output |
| `1` | ran, nothing to suggest |
| `2` | could not measure: too few files, zero scored positions, or a scorer never observed producing both a hit and a miss |

The third exists because a clean result from an instrument that could not fail is worth nothing; `measure` refuses rather than printing a number it cannot support.

## License

MIT
