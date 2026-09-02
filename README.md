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

Two different baselines give two different thresholds, and collapsing them into one band was a mistake this table used to make.

**Against your editor's word list**, the advantage holds far lower than expected. It is measured at 35.9% recital (0.583 against 0.194, z=3.74) and at every band above; the only null observed is at **13.5%**.

**Against ten lines of frequency counting**, on real identifiers only, the threshold is much higher: z=3.81 at 61.7% and z=2.90 at 71.2%, and **null at 46.5%, 45.3% and 37.9%**.

| your recital | beats your editor's word list | beats a ten-line frequency table |
|---|---|---|
| above 60% | yes (z=3.18 to 12.65) | yes (z=2.90, z=3.81) |
| 35% to 60% | yes (z=2.98 to 5.74) | **no, null** (z=0.14, 0.58, 1.62) |
| around 15% | **no, null** (z=1.00 at 13.5%) | not measured |

That table is the claim. The accuracies quoted further down are large, but completion accuracy is large everywhere; what varies is whether this tool, rather than something considerably simpler, is what earned them.

The tool says which band you are in rather than letting you discover it: `measure` prints the recital rate, and the CLI prints it with every suggestion.

Note what is **not** measured: how many real repositories fall in each band. Nine corpora were chosen, not sampled, so the fraction of projects this helps is unknown, and two of the strongest rows are admitted artifacts (one was vendored third-party code, and another is a tree of 369 near-identical rule files, which is a property of that tree rather than of the tool).

## Install

```sh
npm i -D lexindex
```

```sh
npx lexindex ./src --stats                        # index and report what it holds
npx lexindex ./src --at src/server.js:120:9 -k 5  # suggest at a line and column
npx lexindex ./src --recital src/server.js        # just the number from the table above
npx lexindex ./service --lang python --stats      # another language; default is js/ts

# complete a buffer that is not on disk yet, which is what an editor actually has
sed -n '1,120p' src/server.js | npx lexindex ./src --stdin --json

# the measurement harness ships with the package
node node_modules/lexindex/tools/measure.mjs ./src
node node_modules/lexindex/tools/measure.mjs --json ./src   # the same, for automation
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

One corpus also means a file reachable through two of those paths is one file. That is the same concern as point 3 below rather than a separate one, and it arrives through this very argument list: `./src ./src/` is two spellings of one directory, a parent and a child overlap, and on a machine whose checkout sits under a symlink two absolute paths can be the same place. Counted twice, this repository's own recital went from 51.0% to 74.0% and its identifier accuracy from 34.6% to 83.3%: a different verdict entirely, from an argument list nobody would look at twice. Files are keyed on their real path so this cannot happen, and both the CLI and the harness say when paths overlapped rather than quietly deduplicating.

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

### Checking it on your own repository

The harness measures this too, so the claim is not one you have to take on trust:

```sh
node node_modules/lexindex/tools/measure.mjs ./src
```

```
  RE-RANKING the list your editor would offer (buffer words, prefix-filtered):
    ordering                       top-1     lists <10   lists >=10
    your editor's order (recency)  66.667    68.421    62.500
    by frequency                   48.148    57.895    25.000
    reordered by this index        62.963    68.421    50.000

    paired vs "your editor's order (recency)" (McNemar):  7:8 of 15   z=0.26   ← NULL
    coverage: the truth was in the offered list at 72.973% of positions
    excluded: 21 positions offered a single candidate, where every ordering is right
```

Read what that is before reading the number. **It is not the tsserver table above.** Reproducing that needs a language server, and the candidate *set* would be a different set: what is in scope, rather than what is in your buffer. What the harness reorders is the list an ordinary editor offers with no language server at all, which is a real candidate list rather than a synthetic one and needs no dependency to produce. So it answers a narrower question than the table: given the words your own editor would show you, does reordering them by this index put the right one first on your repository?

Two exclusions carry weight and are printed rather than buried. A list holding one candidate makes every possible ordering correct whenever that candidate is the answer, so those positions are dropped; leaving them in inflates every row equally and flattens the comparison along with them. And re-ranking returns a permutation, so it can never invent an answer that was not offered: positions where the truth is missing from the list are reported as coverage instead of being scored, because supplying the candidate is the language server's job and not this one's.

The run above is a null, on a corpus chosen for being small. That is the harness working. The table at the top of this README says plainly that there are recital ranges where this tool is expected to lose to one baseline or the other, and a harness that could not report that would not be worth shipping, which is also why it refuses outright rather than printing a number when too few positions survive the exclusions.

## Where no language server runs

The first entry in *What it cannot do* names this tool's place (CodeMirror and Monaco embeddings, plain-JavaScript projects) and until now that was the one claim in this README with nothing measured under it. A browser page has no file walker and no repository. The only text it can index is the documents the user currently has open, so the question is not what a repository's recital rate is; it is a sweep. At 1 open document, 3, 8, 30, is there anything here the editor does not already give away?

```sh
node node_modules/lexindex/tools/opendocs.mjs ./src
node node_modules/lexindex/tools/opendocs.mjs --tabs sibling --sweep 1,3,8 ./src
```

Ghost 5.57.2's `core`, 1,068 files, on 2,180 held-out identifier positions fixed once so that every row is scored on the same cursors and the only thing changing down a column is how many documents were open. `open` counts the documents open *besides* the one being edited, so the first row is an editor holding two tabs:

```
  open    tokens  recital  lexindex  buf only   cur doc  all open  z vs cur  z vs all  z vs buf
     1       416    23.9%     50.5%     35.2%     27.7%     34.0%    18.51    16.50    15.54
     2       847    30.6%     53.7%     35.2%     27.7%     32.8%    20.11    19.13    17.33
     3     1,318    35.5%     56.2%     35.2%     27.7%     32.3%    21.39    20.97    18.64
     5     2,127    40.2%     58.3%     35.2%     27.7%     32.2%    22.48    21.98    19.90
     8     3,428    45.5%     61.0%     35.2%     27.7%     32.6%    23.81    23.29    21.30
    12     5,065    47.6%     61.4%     35.2%     27.7%     32.0%    23.91    23.74    21.41
    20     8,528    52.2%     63.7%     35.2%     27.7%     31.7%    24.89    24.66    22.47
    30    12,778    55.2%     64.9%     35.2%     27.7%     32.4%    25.36    24.97    23.06
    50    19,740    58.7%     65.9%     35.2%     27.7%     32.4%    25.90    25.17    23.55
```

**The column that decides this is the last one, and it is not the obvious one.** Against both word-list baselines the hybrid wins from a single open document on every corpus measured, and that sentence is a trap, because the hybrid is half cache and the cache reads only the document being edited. It wins with one other document open whether or not opening any other document is worth anything, so it would talk somebody into building a tab indexer that earns nothing. `buf only` is the ablation that separates the two: the cache alone over an *empty* index, with no open documents indexed at all. `z vs buf` is the only column that says whether reading the other tabs pays.

Two answers come out of that, and they are different products.

**With one document open, the cache alone is the whole result.** 35.2% against the editor's 27.7% on Ghost (z=9.01) and 30.0% against 21.7% on llocal (z=4.24), with nothing else indexed at all. That is the embedding which has no document set to speak of (a docs page, an admin console's query box, a config editor) and it is served without a `CountModel`, an open-document list, or anything to keep current.

**Reading the other open documents pays from the first one.** Not the thirtieth. Of the six corpus-and-tab-set combinations measured, four are already significant with a single other document open, and the two that are not (z=1.47 and z=1.86) clear it at two. Nothing narrows back to a null further along the sweep.

| corpus | files | positions | boilerplate | cache alone vs the editor's word list | other documents before they pay |
|---|---|---|---|---|---|
| Ghost 5.57.2 `core` | 1,068 | 2,180 | 5.7% | 35.2% vs 27.7% (z=9.01) | 1, either tab set |
| llocal | 216 | 516 | 3.9% | 30.0% vs 21.7% (z=4.24) | 1 sibling, 2 sampled from anywhere |
| k8s | 153 | 255 | 2.4% | 47.1% vs 36.9% (z=3.36) | 1 sampled from anywhere, 2 sibling |

Which documents are open is not a neutral choice, so both ends run. `--tabs random` samples them from anywhere in the corpus, which nobody does; `--tabs sibling` takes the files nearest by path, which is closer to a real tab set and optimistic in exactly the direction point 3 below is about. The truth for a given user is between them. Read k8s as the optimistic end for a second reason: no single header runs through it, but 42.7% of its scored positions share a context with a quarter of the corpus, which is what a tree of near-identical route and object modules looks like from inside.

### This sweep is more exposed to corpus choice, not less

Its whole subject is how much a few open documents already know about the one being edited, so a corpus where every file opens with the same header answers with the header. Canvas LMS's `app` tree reports 56.7% recital and 72.0% accuracy from **one** open document of 961 tokens, which is not a result: 43.4% of its scored positions sit on a four-token context that more than half of all other files also carry, and that context is the 16-line license notice at the top of every file. So the harness measures that share and prints it, on the same posture as the generated-code check: count it and say so.

```
BOILERPLATE: 43.4% of those positions sit on a context that more than half the other files also carry
             (46.2% at a quarter of them). That is a license header or a generated
             preamble, and it is what this sweep will mostly be measuring.
```

Nothing is excluded on the strength of it. The first corpus tried here failed the same gate for a different reason (a Cordova app carrying four byte-identical copies of `cordova.js`) and both are point 3 below arriving through the front door rather than a new hazard.

### What that makes a browser build

Not much, which is the point, and it is shipped: see [In a browser](#in-a-browser). Nothing under `src/` reached for a file system except `build.js`, so the work was an export that leaves it out rather than a second implementation.

The rule that governs all of it is point 5 below and the last row of *Seven things it deliberately does not do*, both unchanged. The index has to be built from the documents the user has open, in their browser. A prebuilt one shipped with the page was measured at 57 times the corpus for +0.000, while the second document somebody actually has open is worth z=4.63.

## What it cannot do

1. **It is not type-aware.** It has no idea what is in scope or which members exist on an object, and standing alone at a `foo.` position a language server beats it outright. Its place is where no language server runs (CodeMirror and Monaco embeddings, plain-JavaScript projects, `cmp-buffer`-style setups), or as the re-ranker described above. What it is worth in that first place is measured in [Where no language server runs](#where-no-language-server-runs) rather than asserted.
2. **It ranks tokens, not lines.** No ghost text and no multi-token generation; the research this derives from measured whole-line output as right about 1 time in 10 mid-line, and never right past roughly 10 tokens.
3. **Corpus choice changes the answer, and it is easy to fool yourself.** This is the largest free parameter in a completion benchmark, and during development it inflated the headline through three separate doors: a vendored `assets/vendor/` holding 344 third-party libraries (0.567 became 0.809 on the same repository); a fetched research corpus, 1,249 files of 1,266, reached through the `.ts` and `.tsx` extensions rather than a directory name (54.7 became 80.9); and `.claude/worktrees/`, holding 14 whole duplicate copies of the repository. Vendored bundles and duplicated checkouts repeat themselves enormously, and repetition is exactly what this tool measures. Excluded by default for that reason: `node_modules`, `vendor`, `dist`, `build`, `coverage`, `.next`, `.nuxt`, `.cache`, `.claude`, `.venv`, `venv`, `site-packages`, `.tox`, `__pycache__`, and `*.min.js`. If you widen the net, say what you indexed when you quote the number; a completion accuracy without its corpus definition cannot be read.
4. **Comments and string contents are indexed.** That was checked rather than assumed, and it goes the other way: restricting to code-only positions lowered identifier accuracy on 4 corpora of 6.
5. **A foreign index does not help.** Indexing one project and completing another cost 0.167 to 0.197 top-1, so there is no pretrained corpus to ship, and shipping one would be worse than nothing.

## Other languages

The lexer never knew what language it was reading. The defaults did: they matched the JavaScript family and nothing else, so a Python repository got `indexed 0 files` and an error telling it to check for `.js` files. The mechanism was language-agnostic and the packaging was not.

```sh
lexindex ./service --lang python --stats
node node_modules/lexindex/tools/measure.mjs --lang go ./pkg
```

`python`, `go`, `rust`, `java`, `kotlin`, `ruby`, `c`, `cpp`, `csharp`, `php`, `swift`, `shell`, `sql`, comma-separated, or `all`. **The default is unchanged and stays JavaScript**, because every number in this README was measured on JavaScript and TypeScript corpora and a default that quietly widened would change what those numbers describe. `--lang` also brings that language's build directories with it (`target` for Rust and Java, `bin`/`obj`/`Library` for C#) on the same reasoning `node_modules` is skipped, and only when that language is asked for, since `target` and `bin` are real source directories in somebody's repository.

Whether it *works* on your language is a question rather than a claim, so the harness takes `--lang` too. Seven corpora, six languages, each a public repository checked for generated and vendored code first. Every corpus links to the exact commit it was measured at, because a completion number without its corpus cannot be read and a corpus nobody else can fetch cannot be checked:

| language | corpus | files | recital | hybrid | vs word list | vs frequency table |
|---|---|---|---|---|---|---|
| Python | [falken/service](https://github.com/google-research/falken/tree/eecd8ab255e5bf3ea31c209bd1ce2f25e7965814/service) | 101 | 55.3% | **72.3%** | 23.4% (z=12.00) | 28.0% (z=12.38) |
| Python | [stable-diffusion-webui](https://github.com/AUTOMATIC1111/stable-diffusion-webui/tree/82a973c04367123ae98bd9abdf80d9eda9b910e2) | 171 | 38.1% | **60.0%** | 34.7% (z=10.17) | 16.7% (z=14.64) |
| Go | [mailslurper/pkg](https://github.com/mailslurper/mailslurper/tree/95aa534ff92f628a8be3221a91cf9d09cf48e3db/pkg) | 68 | 57.3% | **72.3%** | 13.9% (z=11.99) | 23.4% (z=11.33) |
| Java | [Bukkit](https://github.com/Bukkit/Bukkit/tree/f210234e59275330f83b994e199c76f6abd41ee7) | 585 | 58.0% | **67.5%** | 32.4% (z=23.89) | 28.0% (z=27.43) |
| Ruby | [canvas-lms/app](https://github.com/instructure/canvas-lms/tree/1c9f0bb8013ed69c4f2efe11fd483025469b7e6c/app) | 1,385 | 68.1% | **75.3%** | 24.9% (z=46.72) | 28.9% (z=46.97) |
| Swift | [IceCubesApp](https://github.com/Dimillian/IceCubesApp/tree/b2db3033fbf67a97b54d25d6dac2df8a029b26b1) | 343 | 59.9% | **73.0%** | 37.3% (z=18.45) | 29.8% (z=21.18) |
| C | [tmux](https://github.com/tmux/tmux/tree/59dc0e75c439aa88bd303fd0e3e02dae677e78b1) minus `compat/` | 129 | 64.5% | **70.1%** | 31.6% (z=9.93) | 21.7% (z=12.74) |

`ident+1char`, held-out files, paired McNemar, generated code excluded. The hybrid beat both baselines on all seven, and the gaps are large rather than merely significant.

An earlier version of this table measured local checkouts, and two of those were not public repositories at all: somebody's Swift game clone and an FTDI driver drop. A row nobody else can fetch is a row nobody else can check. Every corpus above is a fresh `git clone` of the linked commit, and the harness is seeded (`SEED=0`, a fifth of the files held out, 25 positions per file), so the rows reproduce rather than being taken on trust: falken came back from a fresh clone to the digit, which is the check on that claim. The other rows moved, because a public clone is a different commit from whatever was on one laptop, and because the Swift and C rows are different projects.

```sh
git clone --depth 1 https://github.com/tmux/tmux
rm -rf tmux/compat      # 46 imported libc replacements; see below
node node_modules/lexindex/tools/measure.mjs --lang c ./tmux
```

That `rm -rf` is the vendored-code check arriving on a corpus that does not have a `vendor/` directory to skip. tmux's `compat/` is 46 files of `asprintf`, `getopt_long`, `strlcpy` and OpenBSD's `imsg`, imported rather than written there, and counting them was worth 2.7 points of recital and 4.4 points of accuracy to the row above. The other six corpora carry no such pocket: falken's FlatBuffers output is the only tree dropped from any of them, and it is dropped by `--skip-generated` rather than by hand.

The falken row was published wrong and is corrected here. It first read 213 files at 64.2% recital and 78.5% accuracy, from a corpus checked by hand for protobuf stubs and vendored directories. More than half of it (140 files of 266) turned out to be FlatBuffers output under `generated_flatbuffers/`, which that check did not look for. The verdict survived the correction and the numbers did not. It is still the only generated code in the table: the detector finds none at all in the other six corpora.

Read two limits into that before quoting it. **These corpora do not re-derive the thresholds in the table at the top of this README**, which came from JavaScript and TypeScript; several are far larger than the corpora behind those nulls, and z grows with the square root of the sample, so significance arrives more easily here than it did there, which is exactly why the row at 38.1% recital clears the frequency table when the table says that takes about 60%. The band the CLI prints is still the JavaScript-derived one. And seven corpora is seven corpora: it says the mechanism carries, not that it carries at any particular rate on your repository. That is what the harness is for.

The warning in *What it cannot do* about corpus choice applies with more force here, not less. Generated code is more common outside the JavaScript world (protobuf stubs, OpenAPI clients, parser tables, ORM scaffolding) and it repeats itself enormously, which is precisely what this tool measures.

So the tool looks for it now instead of leaving you to, which is how the falken row above was caught:

```sh
lexindex ./service --lang python --stats            # says how many look generated
lexindex ./service --lang python --skip-generated --stats
node node_modules/lexindex/tools/measure.mjs --lang python --skip-generated ./service
```

It reads the head of each file for the conventional markers (Go's `Code generated … DO NOT EDIT.`, `@generated`, the protobuf and FlatBuffers headers) and recognises a handful of filename conventions such as `*_pb2.py`, `*.pb.go` and `*.min.js`. Only the head, because a file that merely *discusses* generated code is not one; only markers at the start of a line after a comment leader, because `# they could be auto-generated by an admin` in a Rails model is a sentence, not a header. Across the 3,613 files of the seven corpora above it flagged 140, all of them the FlatBuffers files under falken's `generated_flatbuffers/`. Point it at this repository and it flags one more: its own source, which contains the marker strings it searches for.

**Nothing is excluded by default.** It is a heuristic, and one that silently dropped a third of a repository would be worse than the problem; and every number here was measured without it, so switching it on by default would change what those numbers describe. The default is to count and to say so, which is the same posture as the recital rate: report the thing that decides whether the answer is any good, and let the reader act on it. On sympy's `parsing` module, three ANTLR-generated files among 52 were worth 2.6 points of recital and 9.4 points of accuracy.

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
| a bundled pretrained corpus | 57 times the corpus was worth +0.000 at a warm buffer, +0.016 overall, which is a poor trade either way |

The last is the load-bearing product decision: the only corpus that pays is the one already on your disk. Two caveats on that figure, since it is the one most likely to be quoted. The +0.000 is the warm-buffer case; the same measurement gives +0.016 once the buffer empties, and its own write-up calls the thesis bounded rather than absolute. And it was taken in a configuration that included a small transformer, which this package does not have, so it is evidence about the trade rather than a number measured on this architecture.

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
| `buildIndex(dirs, opts)` | `{ index, files, tokens, ms, candidates, skipped, duplicates, missing, tokensByFile }` |
| `collectFiles(dirs, opts)` | one directory or several as one corpus; deduplicated by real path, with `.duplicates` and `.missing` for roots that were not readable directories |
| `isLikelyGenerated(text, file)` | `false`, `"name"` or `"marker"`; `buildIndex` reports `generated` and takes `skipGenerated` |
| `new Completer(index, { cacheBeta })` | `cacheBeta` 0 is repo only, 1 is buffer only, default 0.5 |
| `completer.complete(textBeforeCursor, { k })` | lexes, finds the partial identifier, updates the buffer |
| `completer.completeScored(...)`, `.suggestScored(...)` | the same rankings, each with the score that produced it |
| `completer.rerank(candidates, textBeforeCursor)` | reorders another engine's list; returns a permutation, so nothing is added and nothing is dropped |
| `completer.rerankTokens(candidates, prev)` | the same, for a caller that already holds the tokens |
| `completer.scoreCandidates(prev, candidates)` | `Map<candidate, score>`, the blend over a supplied set |
| `new DocumentSet({ order })` | an index over the open documents; `lexindex/browser` and the main entry both export it |
| `docs.open(id, text)`, `.close(id)`, `.activate(id)` | add or replace a document, drop one, move the cursor; all chain |
| `docs.completer(opts)`, `.session(opts)`, `.recital(text)`, `.index`, `.size` | the blend over the open set, and the number that says whether it is helping |
| `new DocumentSet({ maxLength, skipGenerated, onRecital, onExcluded })` | the file walker's 400 KB ceiling and generated-code flagging, and the two ways it reports itself |
| `docs.excluded`, `docs.generated` | which documents are open but not indexed, and which look generated |
| `completionSource(docs, { k, cacheBeta, minPrefix })` | a CodeMirror 6 `CompletionSource`, from `lexindex/codemirror` |
| `completionProvider(docs, { monaco, kind, k, cacheBeta, minPrefix })` | a Monaco `CompletionItemProvider`, from `lexindex/monaco` |
| `completer.session()` | a `BufferSession`: the same calls, re-lexing only what you typed |
| `session.complete(...)`, `.completeScored(...)`, `.rerank(...)` | drop-in replacements that keep the buffer between keystrokes |
| `completer.setBuffer(tokens)` and `.suggest(prev, { k, prefix })` | the lower-level path |
| `updateIndexFile(built, file, text?)` | re-index one file in place; omit `text` to read from disk, pass `null` if it was deleted |
| `index.replaceFileTokens(old, next)` | swap one file's counts and re-finalize |
| `index.removeFileTokens(tokens)`, `.reopen()` | the lower-level path |
| `index.recitalRate(tokens)` | the number from the table at the top |
| `recitalBand(rate)` | what that number means, in one line; the CLI and the harness both print this one |
| `lex(text)`, `isWord(t)`, `splitAtCursor(text)` | the tokenizer |
| `resolveLanguages(spec)`, `LANGUAGES` | `"python"` or `"py,go"` to `{ extensions, skipDirs }`; also `buildIndex(dirs, { languages })` |

The scores are comparable to each other within one call and are nothing more than that. They are not calibrated probabilities and they do not mean the same thing at two different cursors, so read them to draw a bar or to merge this ranking with another engine's, not as a confidence to cut on. Gating on confidence is the first row of the table above, and it lost three separate times.

`setBuffer` is incremental: extending the previous buffer reuses the cache instead of rebuilding it, which is what keeps the per-keystroke cost flat. On a 369-file, 560K-token index, building takes 1.07 s and a suggestion takes 0.36 ms at the median (p99 3.30 ms).

That 0.36 ms is `suggest(prev, ...)`, which is handed the tokens. `complete(text)` and `rerank(list, text)` are handed the text instead and lex all of it again on every call, so what they cost is the buffer rather than the edit: see below.

## Keeping the index current while you edit

An index built once goes stale the moment you save a file, and rebuilding the tree on every save is not an option in a process that has to answer a keystroke. So one file's contribution can be subtracted and its replacement added, which costs a file rather than a repository:

```js
import { buildIndex, updateIndexFile, Completer } from "lexindex";

const built = buildIndex("./src", { retainFileTokens: true });
const completer = new Completer(built.index);

updateIndexFile(built, "src/server.js");                 // re-read it from disk
updateIndexFile(built, "src/server.js", editor.text);    // or hand it the unsaved buffer
updateIndexFile(built, "src/gone.js", null);             // deleted
```

`retainFileTokens` is what keeps each file's tokens around to be subtracted later, and it is opt-in because it costs memory proportional to the corpus: a one-shot CLI run has no use for it and a long-lived editor process does.

The result is not an approximation of a rebuilt index. It is exactly equal to one, which the suite asserts over edits, deletions, additions and long sequences of edits by comparing the whole count table against a rebuild. On a corpus of 400 files and 422,598 tokens, one file's update took 4.13 ms at the median against 585 ms to rebuild.

That exactness is worth more than the speed. A count left behind at zero would be invisible in a suggestion list and perfectly visible in `recitalRate`, which reads the context tables directly: the index would go on claiming it had seen text that had been deleted, and the recital rate is the one number this project asks anybody to trust.

## One keystroke should cost one keystroke

`complete(text)` and `rerank(list, text)` take the whole text above the cursor, which is the shape an editor reaches for and the reason both of them re-lex the entire buffer on every call. Measured against the 400-file, 422,598-token index above, with a 175 KB file open, that is what the ergonomic path was paying:

| per keystroke, 175 KB buffer | `Completer` | `completer.session()` |
|---|---|---|
| `complete(text)` | 3.26 ms | **1.14 ms** |
| `rerank(list, text)` | 2.28 ms | **0.43 ms** |

A session keeps the tokens and the buffer cache between calls and re-lexes only from the last settled point in the text. The calls take the same arguments and return the same things, so it is a swap and nothing else:

```js
const session = completer.session();

session.complete(textBeforeCursor);            // was completer.complete(...)
session.rerank(candidates, textBeforeCursor);  // was completer.rerank(...)
```

It is the same answer, not a faster approximation of one. The suite types real text in one character at a time and asserts the session's list is identical to a freshly built `Completer`'s at every cursor, at every blend, through backspacing and cursor jumps, and on the shapes that break a careless incremental lexer: `12` growing into `123` is one token and not two, and `12ab` is one run of word characters holding two tokens. Across the checks written while building it, 17,784 comparisons produced no disagreement.

What makes that safe is a property of the lexer rather than bookkeeping. A token is an identifier, a number, or one non-word character, so no token can span a non-word character; any position whose preceding character is a non-word character therefore has everything before it settled, whatever gets typed next. The session re-lexes from the latest such position and reuses the rest. An edit that is not an extension (a backspace, a jump) is rebuilt from scratch, which costs exactly what the plain `Completer` costs today.

Suggestions are also selected rather than sorted now. Ranking 5 candidates out of the roughly 1,700 a live buffer offers had been ordering the 1,695 nobody would see. Because candidates are map keys, no two share a token, so score-then-token is a total order and taking the best k is byte-identical to sorting and slicing, which the suite checks against the full ordering rather than assuming.

## The CLI

```
lexindex <dir>... [options]

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
    --lang <names>                index another language: python, go, rust, java,
                                  ruby, c, cpp, csharp, php, swift, kotlin, shell,
                                  sql, or "all". Comma-separated. Default javascript.
    --ext <regex>                 which filenames to index (overrides --lang)
    --exclude <regex>             drop matching paths from the corpus
    --skip-generated              drop files that look generated; counted either way
    --max-bytes <n>               skip files larger than this (default 400000)
```

`--stdin` is the one that matters for an editor, because the buffer an editor wants completed is unsaved by definition and a byte offset into the file on disk is an offset into the wrong text. Piping the text above the cursor and reading the list back is the whole integration:

```sh
sed -n '1,120p' src/server.js | lexindex ./src --stdin --json
```

Suggestions go to stdout one per line and everything else goes to stderr, so the plain form stays usable in a pipe. `--json` puts the same list on stdout with the scores, the recital rate and the band it falls in, which saves an integration from parsing prose.

`--ext` and `--exclude` exist because corpus choice is the largest free parameter in a completion benchmark, and the README above spends a numbered point on the three separate ways it inflated this project's own headline. If you widen the net past the defaults, say what you indexed when you quote the number.

## A whole line, retrieved rather than guessed

`--line` answers a different question from the rest of this tool: not *what token comes
next*, but *what line came next, last time you were here*.

```
$ lexindex ./src --stdin --line
type: 'integer',
  src/classes/openapi.js:29 - 60% confident, seen 6 time(s), 4 other(s) here
```

It does not generate. Running the token completer on its own output was measured over 883
positions on a corpus of seven sibling services, and it decays about geometrically:

| tokens ahead | exact |
|---|---|
| 1 | 43.0% |
| 3 | 19.7% |
| 5 | 11.4% |
| 10 | **3.1%** |

Ten tokens is roughly a line, so a generated line is right about three times in a hundred.
That is not a tuning problem: an order-5 model conditions on four tokens, and after a few
self-generated steps the context is mostly its own output.

So `--line` remembers instead. It keeps the lines that actually followed a context and
returns the most likely, **with the file and line it came from**.

### How it ranks, and how that was decided

Measured on a public corpus anybody can fetch, for the reason the language table above
gives: a row nobody else can clone is a row nobody else can check. Nine sibling middleware
packages from the express family are indexed and two disjoint ones predicted, then the two
halves are swapped. Both arms run the shipped class — the arm labelled *before* is exactly
`{widths: [4]}` with no local model and no floor — so this compares against the code rather
than a description of it, and coverage is held fixed, because "answers more often" is not
"is right more often".

| corpus | held out | positions | before | after, same coverage |
|---|---|---|---|---|
| 9 packages, 27 files | express, multer | 2,955 | 15.9% | **30.1%** |
| express, multer | 9 packages, 27 files | 5,134 | 19.3% | **33.6%** |

+14.1 and +14.3 points of exactness, and +16.8 and +16.4 of prefix agreement. Reproduce it:

```sh
for r in expressjs/body-parser expressjs/compression expressjs/cors expressjs/morgan \
         expressjs/serve-static expressjs/session pillarjs/finalhandler pillarjs/router \
         pillarjs/send expressjs/express expressjs/multer; do
  git clone --depth 1 https://github.com/$r
done

npm run measure:line -- --exclude '/(test|tests|examples|benchmark|support)/' \
  ./body-parser ./compression ./cors ./finalhandler ./morgan ./router ./send ./serve-static ./session \
  -- ./express ./multer
```

Cloned at HEAD on 2026-09-01: [body-parser `8d6ec0f`](https://github.com/expressjs/body-parser/tree/8d6ec0ff3c34ec3701e502bd582b345fd2846796),
[compression `ae9b1ae`](https://github.com/expressjs/compression/tree/ae9b1ae1cb73433f71bf7aa8dd022f9146bbcdcf),
[cors `5317ebe`](https://github.com/expressjs/cors/tree/5317ebe670db2aaebc1d496eb5d33493deefb3ed),
[finalhandler `577bfbf`](https://github.com/pillarjs/finalhandler/tree/577bfbf00288166b5a069ff78cce60c26b81992f),
[morgan `286b000`](https://github.com/expressjs/morgan/tree/286b000228cacba362bfa89791c6268663f86610),
[router `bda4af3`](https://github.com/pillarjs/router/tree/bda4af36c1e66811717b13421579c63029ea2877),
[send `092f3fc`](https://github.com/pillarjs/send/tree/092f3fc77f0e796519ac328c543c11cced8f2244),
[serve-static `74be78a`](https://github.com/expressjs/serve-static/tree/74be78a8ffad679edfe135c457ce141114d96fcc),
[session `96ebea4`](https://github.com/expressjs/session/tree/96ebea4b6cd805584fba04523773b1b918a836d7),
[express `023767f`](https://github.com/expressjs/express/tree/023767fe9872e029271df1418f73401bff20ff40),
[multer `a53296b`](https://github.com/expressjs/multer/tree/a53296bbd6d57349bcf56da3b2de5111e1c87c54).

The script refuses to run if the two sides overlap: predicting lines of a file that is in
the index measures only that a hash table works, and would report a number near 100%.

**That `--exclude` is doing more work than it looks like.** 134 of express's 141 indexable
files are tests and examples, and test code is far more templated than library code. Leave
them in and the same eleven repositories answer on 64% of positions instead of 29%, and the
same change is worth **+25.7** points instead of +14.1. Neither number is wrong; they are
numbers about different code, which is why the command above is written out in full. Corpus
choice is the largest free parameter here, exactly as it is in the language table.

**Coverage is where a corpus shows itself.** On this public corpus the index has never seen
the context at 63% of line positions and says so. On fifteen sibling services generated from
one template — a private estate, so take the figure as illustration rather than evidence —
that fell to 23-28%, and the same comparison ran +8.6 and +8.3 rather than +14. The more a
codebase repeats itself, the more often this answers and the less each answer is worth. A
high hit rate here means *you have written this before*, which is a fact about the corpus
and not always a compliment to it.

Two things earned their place:

- **Every context width votes, rather than the longest one that matches.** Widths of four,
  five and six tokens each contribute a candidate's share of what followed them, weighted
  by width. Backing off to whichever is longest throws away the fact that the shorter
  contexts agreed.
- **The file you are editing is a corpus too.** The lines above your cursor are worth 4.3
  and 4.0 points of overall accuracy, and lift coverage from 19% to 30%: on a corpus that
  repeats itself as little as this one, the buffer is proportionally more of what there is
  to retrieve from. Code repeats locally far more than
  it repeats globally, and your unsaved buffer is the one corpus the index never has.

Three things did not, written down so nobody has to rediscover them:

- **Templating identifiers into holes** (`const ID = NUM;`) lifts coverage to 97% and costs
  6.2 points of accuracy. Contexts that match only once their names are erased are usually
  not the same context.
- **Recency weighting** on the local model does nothing at any half-life tried (20, 60 and
  200 lines all landed inside the noise).
- **Matching indentation** actively hurts, 28.2% against 40.5% - and that was measured with
  oracle access to the true line's indent, so no better estimate of it will help. A
  candidate's indentation is a fact about the file it came from, not the one it is going to.

### Two ways to have no answer

**A context that has never been seen is refused outright, and exits 1.** That refusal is
the point: an index over your own repository must never hand back code your repository does
not contain, and the provenance is there so a suggestion is checkable rather than merely
convincing. Narrow contexts were left out of the ranking to protect it - a two-token tail is
usually punctuation like `);`, which matches nearly any line ever written, and including it
would take the share of positions where this can honestly say "never seen" from 63-64% down
to 26-27%. On the private estate that was the whole of the argument, since exactness there
moved less than a point either way; on the public corpus dropping them also *raises* it,
26.4% to 29.1% and 26.5% to 30.2%, so the trade turns out to have no cost to weigh.

**A context whose continuations disagree is also withheld**, and says which it was:

```
$ lexindex ./src --stdin --line
lexindex: nothing here is likely enough - best of 7 candidate(s) holds 22% of the score,
          below --min-confidence 0.3
```

`--min-confidence` is the dial, and `confidence` is two things multiplied: the share of the
evidence pointing at this line, and how much evidence there is. The second half is
Witten-Bell `N / (N + T)` - times seen over distinct continuations - the same formula the
count model uses one directory over. It is there because a share alone is silent about
sample size: a context seen exactly once, with one continuation, holds 100% of the score.

| `--min-confidence` | offers | exact |
|---|---|---|
| `0` | 37.1% / 35.7% | 23.7% / 25.5% |
| `0.15` (the default) | 30.4% / 30.0% | 29.0% / 30.2% |
| `0.3` | 20.3% / 20.8% | 39.7% / 40.6% |
| `0.6` | 4.7% / 4.7% | 62.9% / 74.9% |
| `0.8` | 2.3% / 2.6% | 82.1% / 79.5% |

Turning it up is the part that did not work before. Scored as a plain share, 37.6% of all
answers sat at exactly 1.0, so even `--min-confidence 1` still answered on 13.9% of positions
and could not be pushed past 42.5% exact: there was no way to ask for *only when nearly
sure*. Now there is. The default moved from 0.3 to 0.15 because the scale changed underneath
it and not the behaviour - those two default rows are the same answers as before.

One honest caveat about what it is good at. The exact hits are largely declarative
boilerplate - `schema: { type: 'string' },`, `in: 'query',`. A high hit rate here means
*you have written this before*, which is a fact about your corpus and not always a
compliment to it.

The table is opt-in: it is a second pass over the same text and costs memory in proportion
to how much the corpus repeats, so nothing that only completes tokens pays for it. In the
API it is `buildIndex(dirs, { lineIndex: true })`, and the result carries a `lines` table
with `lookup(textBefore, { local, minConfidence })` and `candidates(textBefore, { local })`
for a caller that would rather offer a list - the right line is the top one about 30% of the
time it answers, and inside the top three about 35%. Build the `local` model with `localIndex(textAboveCursor)`.

## In your editor

The tool has always said where it belongs (*where no language server runs*) and then shipped one CLI, leaving everybody to build the same bridge. So it ships a language server now, speaking completion and nothing else, over the protocol every editor already knows.

```sh
npx lexindex-lsp                 # indexes the workspace root the editor reports
npx lexindex-lsp --lang python   # or another language
```

**Neovim**

```lua
vim.api.nvim_create_autocmd("FileType", {
  pattern = { "javascript", "typescript" },
  callback = function()
    vim.lsp.start({
      name = "lexindex",
      cmd = { "npx", "lexindex-lsp" },
      root_dir = vim.fs.root(0, { ".git", "package.json" }),
    })
  end,
})
```

**Helix**, in `languages.toml`: note it sits *beside* the type-aware server rather than replacing it:

```toml
[language-server.lexindex]
command = "npx"
args = ["lexindex-lsp"]

[[language]]
name = "javascript"
language-servers = ["typescript-language-server", "lexindex"]
```

**Emacs**, with eglot:

```elisp
(add-to-list 'eglot-server-programs '(js-mode . ("npx" "lexindex-lsp")))
```

Running it alongside a real language server is the intended arrangement wherever one exists, and the reason is the first entry in *What it cannot do*: this thing is not type-aware, has no idea what is in scope, and loses outright at a `foo.` position. What it contributes is the frequency signal the others have no notion of. Most editors merge completions from several servers, so you get both.

### Whole lines, at a line start

At the start of a line the server also offers the **whole next line**, retrieved from the
index, each item carrying the file and line it came from:

```
┌──────────────────────────────────────────────────────────────┐
│ },                              lexindex line · 63%          │
│ format: 'nullable',             lexindex line · 18%          │
│ format: 'date-time',            lexindex line · 10%          │
│ properties                      lexindex                     │
│ format                          lexindex                     │
└──────────────────────────────────────────────────────────────┘
  classes/openapi.js:34 — seen 85 time(s)
```

This is the one place a server with no idea what is in scope has something a type-aware one
does not: it has read the repository, and it can say *this is what followed here the last
eighty-five times*. Lines sort above the tokens, and the provenance is in the documentation
panel so a suggestion is checkable rather than merely convincing.

Three things it will not do, each of which is a way of declining to guess:

- **Only at a line start** (leading whitespace is fine, a half-typed word is not). The table
  answers "what line followed this context"; half way through `renderWidg` that is not the
  question, and a whole line there would replace what is already typed.
- **Only when the context has been seen** — on a held-out measurement it stays silent on
  roughly two thirds of line positions on a public corpus, and about a quarter on a
  heavily templated one, rather than inventing anything for them.
- **Only when the best candidate clears `--min-confidence`** (0.3 by default). A list an
  editor pops up unbidden is worse than no list.

At most three are offered. The right line is the top one about 30% of the time it clears the
bar and inside the top three about 35%; past three is where the wrong ones live.

The buffer above your cursor is indexed alongside the repository — the one corpus the
server never has on disk, and worth 4.3 and 4.0 points of accuracy on the two measured
splits. Only the last 40 lines, so this is rebuilt per request without re-reading the file.

`--no-line` turns the whole thing off, which also stops the line table being built: it costs
about 4 MB and a tenth of the build time on a 163-file, 75,000-token corpus. `--min-confidence`
takes the floor.

`initializationOptions` takes `lang`, `beta`, `k`, `dirs`, `line` and `minConfidence`,
matching the CLI's flags.

Two details are worth knowing because they are decisions rather than defaults. Completions are identifier-shaped only: the measurements score punctuation because a fair benchmark has to, but a popup offering `;` is noise, and aggregate top-1 is mostly punctuation for every engine including this one. And every item carries a `sortText`, because an editor that re-sorts alphabetically throws away the only thing this server contributes.

It follows the tree, not just the buffer you have open. A save updates that one file, and where the editor supports file watching the server registers for it, so a branch switch, a rebase, a codegen step or a second editor also reach the index: none of which the editor would otherwise tell it about. The client does the watching because it already is: a second recursive watcher from every language server is how a machine runs out of file handles. A client that cannot watch keeps the save-time updates and is told so in the log.

A watched change is reconciled against the disk rather than trusted. The event says what the editor thinks happened; the disk says what did, and the disk is what the index claims to describe, so a stale `Deleted` for a file that is still there leaves it indexed. And a batch large enough that folding it in one file at a time would cost more than rebuilding is rebuilt instead, against the build time this corpus actually measured at startup rather than a guess. A branch switch touching hundreds of files should not stall completions for seconds.

It reports the recital rate to the editor's log as each document opens, with the band it falls in. That number decides whether any of this is worth having, and a server that quietly served weak completions without ever saying so would be the one place in this project where it was hidden.

## In a browser

The section above is the arrangement wherever a language server runs. Where none does, there is no file walker and no repository to index, only the documents the page happens to have open, which is what `DocumentSet` holds.

```js
import { DocumentSet } from "lexindex/browser";
import { completionSource } from "lexindex/codemirror";
import { autocompletion } from "@codemirror/autocomplete";

const docs = new DocumentSet();
docs.open("app.js", appText);      // every document the page holds
docs.open("util.js", utilText);
docs.activate("app.js");           // the one with the cursor

autocompletion({ override: [completionSource(docs)] });
```

`open` is also the edit: call it again with the new text and that document's counts are swapped rather than the index rebuilt, which costs a document instead of a corpus. `close` takes a document's counts out with it. What this is worth at the document counts a page actually has is the section above, and it is worth reading before wiring this up rather than after, with one document open the cache carries the whole result and `DocumentSet` contributes nothing.

### Whole lines here too, opt-in

`--line` and the language server retrieve whole lines at a line start; the two browser
adapters do the same, from the documents the page has open:

```js
const docs = new DocumentSet({ lineIndex: true });   // opt-in
autocompletion({ override: [completionSource(docs)] });
```

```
},                      classes/openapi.js:34 · 64%
format: 'nullable',     classes/openapi.js:40 · 19%
format: 'date-time',    classes/openapi.js:81 · 9%
properties
format
```

Lines sort above the tokens — `boost` in CodeMirror, `sortText` in Monaco, for the same
reason each of those exists at all: an ordering the editor re-sorts is an ordering thrown
away. The gates are the ones the CLI uses and are enforced in one place, `DocumentSet.lineSuggestions`,
rather than copied into both adapters: only at a line start, only when the context has been
seen, only when the best candidate clears `minConfidence`, and at most three.

**What it reaches, measured.** The repository numbers above do not describe a page: there
is no repository, only the tabs somebody has open, and the one with the cursor is held out.
So the free variable is how many tabs, which is what `npm run measure:line:docs` sweeps.
Library code of the same eleven express-family repositories, one tab holding the cursor and
the rest drawn from its directory:

| tabs open | offers a line | exact when it does | in the top 3 | never seen it | won by the buffer alone |
|---|---|---|---|---|---|
| 1 | 14.8% | 35.1% | 35.1% | 85.2% | 100% |
| 2 | 23.0% | 35.7% | 38.2% | 75.0% | 55.8% |
| 3 | 24.3% | 37.1% | 40.1% | 73.1% | 51.6% |
| 5 | 30.4% | 32.5% | 35.4% | 65.4% | 37.8% |
| 10 | 32.1% | 31.0% | 34.6% | 62.7% | 35.5% |
| 20 | 34.5% | 32.0% | 36.2% | 58.6% | 33.5% |

```sh
npm run measure:line:docs -- --exclude '/(test|tests|examples|benchmark|support)/' ./*/
```

Read the last column first, because it is the surprise. **With one document open this
already works**, and everything it offers comes from the text above the cursor — the index
is empty, since the only open document is the one being edited. That is the opposite of
what the token completer does at one document, where `DocumentSet` contributes nothing and
the cache carries the whole result; here the buffer *is* the corpus, and a whole line is a
thing a buffer can supply. Even at twenty tabs a third of the accepted lines still come from
the buffer alone.

Opening more tabs buys coverage rather than accuracy: 14.8% to 34.5% of positions answered,
while exactness stays near a third throughout. And which tabs matters at small counts —
neighbours in the same directory reach 24.3% coverage at three tabs where a random three
reach 19.7%, converging by twenty. Nothing here is tuned to the number of tabs; it is the
same ranking, told less.

**In CodeMirror this needs Ctrl-Space.** At a line start there is by definition no prefix,
and this source already declines to answer an unprompted popup with nothing typed — a line
list that ignored that would appear every time you pressed Enter or indented. Monaco needs
no equivalent, because it does not auto-trigger where no word is being typed.

It is opt-in because it costs a second copy of every indexed document's **text**: the line
table splits lines, and `DocumentSet` otherwise keeps only tokens. Nothing that completes
tokens alone should pay for that.

The table is rebuilt rather than patched, and only when read after a change. That sounds
worse than it is: a rebuild is 21 ms over ten open documents, but the case that would make
it hurt cannot arise. Typing calls `open` for the **active** document, and the active
document is held out of the index, so typing never dirties the table. What dirties it is a
tab switch or an edit to some other document, and those happen at human speed.

The text above your cursor is indexed alongside the open documents, which matters more in a
page than anywhere else: with one document open the rest of the set is empty and the buffer
is the only corpus there is. It is bounded to the last 40 lines, the same window every
published number was measured through.

`{ lines: false }` on either adapter turns the items off; `lineLimit` and `minConfidence`
take the cap and the floor.

### It keeps the corpus hygiene the file walker keeps

`collectFiles` skips a file over 400 KB, because minified bundles and generated dumps repeat themselves enormously and repetition is exactly what this measures: point 3 of *What it cannot do*, and the reason that ceiling exists at all. A page has no `stat` to consult, but it has the string, so `DocumentSet` applies the same ceiling to its length. A tab holding a vendored bundle would otherwise walk into the index and make every suggestion quietly worse, which is the failure that looks exactly like the tool simply not being very good.

A document over the ceiling stays **open** (the editor has it, and if it takes the cursor the cache still serves it) it is just never indexed, and never even lexed. Generated code is treated on the CLI's terms rather than the ceiling's: flagged and counted always, excluded only if you ask for `skipGenerated`, because a heuristic that silently dropped a third of somebody's tabs would be worse than the problem.

```js
const docs = new DocumentSet({
  maxLength: 400_000,   // the default, matching collectFiles
  skipGenerated: false, // the default, matching the CLI
});

docs.excluded;   // Map: id -> "size" | "generated"
docs.generated;  // Set: ids that look generated, excluded or not
```

### And it says what it is doing

`lexindex-lsp` writes the recital rate to the editor's log as each document opens, because a server that quietly served weak completions without ever saying so would be the one place in this project where a weakness was hidden. A page has no log to write to, so the number is handed to the caller instead of being dropped:

```js
const docs = new DocumentSet({
  onRecital: ({ id, rate, band }) => console.log(`${id}: ${(rate * 100).toFixed(1)}% — ${band}`),
  onExcluded: ({ id, reason, length }) => console.warn(`${id} not indexed (${reason}, ${length} chars)`),
});
```

`onRecital` fires when a document is first opened and when one takes the cursor, which are the two moments the number decides something, not on every edit, and not for a document too short to be scored on any position, since a rate of 0 from zero positions is not a rate. `onExcluded` fires when a document is present but not in the index. Both are optional, and when absent neither costs anything: the recital pass is not run at all.

`lexindex/browser` is this package minus `buildIndex`, `updateIndexFile` and `collectFiles`, which are the only things in it that import `node:fs`. Every other name is the identical object the main entry exports. It exists because a bundler following the main entry has no way to know the file walker is unreachable from a page, and pulls `fs` in anyway: either a wasted shim or a hard resolution error, depending on the bundler. The suite walks the whole import graph from that entry and fails if any external specifier appears, with a positive control over the main entry that must find `node:fs` for the walk to be believed.

### The document holding the cursor is not in the index

`activate(id)` takes that document out and puts the previous one back. It is the one decision here worth arguing with, so: the buffer is already served by the cache half of the blend, which reads the text above the cursor and nothing below it. Indexing the active document too would hand the completer the rest of the file, including the continuation it is being asked to predict, and every accuracy in this README was measured with the edited document held out. An index that quietly saw the answer would report a number nobody could reproduce from the harness.

An embedding with exactly one document therefore has an empty index and is served entirely by the cache, which is not a degenerate case but the measured one, and the one that still beats `completeAnyWord` by 35.2% to 27.7% (z=9.01).

The line table follows the same rule, and has to: it is a table of *what line came next*, so an active document inside it would be handing back the very line it was asked to predict. With one document open there is no line table worth the name either, and whole-line suggestions come from the text above the cursor alone.

### Monaco

The same `DocumentSet`, a different provider shape:

```js
import { DocumentSet } from "lexindex/browser";
import { completionProvider } from "lexindex/monaco";

const docs = new DocumentSet();
monaco.languages.registerCompletionItemProvider(
  "javascript",
  completionProvider(docs, { monaco })
);
```

It asks for `monaco` for exactly one reason. A Monaco completion item carries a `kind`, and that value is a member of Monaco's own `CompletionItemKind` enum: a TypeScript enum belonging to that package, not a number fixed by a wire protocol the way `lexindex-lsp`'s `kind: 1` is fixed by LSP. A literal here would commit this repository to a number it cannot check and nothing would notice when it drifted, so the constant is read off the namespace you have already imported. Pass `kind` yourself instead if you would rather, or pass neither and no item claims a kind at all.

It registers no `triggerCharacters`, which is also a decision: putting `.` in the list would place this in front of member completions, and the first entry in *What it cannot do* is that it has no idea what is in scope and loses outright at a `foo.` position. Where a real language service is registered as well, Monaco merges both providers' suggestions, which is the intended arrangement: the same one the language server section describes.

### Neither adapter adds a dependency

`completionSource` imports nothing from CodeMirror and `completionProvider` imports nothing from Monaco. A completion source is a function from a context to a result and a provider is an object with one method; between them they read `pos`, `explicit` and `state.doc.sliceString` on one side, and `model.getValueInRange`, `position.lineNumber` and `position.column` on the other. All plain data. Importing either editor to borrow a type would put a dependency in a package whose first paragraph invites you to check that it has none.

So the suite asserts the surface instead, driving both adapters with an editor object that **throws** on any property they are not supposed to touch. A future edit reaching for `context.matchBefore` or `model.getWordUntilPosition` fails there rather than in somebody's build. The Monaco model in that suite honours the range it is handed, 1-based columns and all, because a provider that built the text-above-the-cursor range wrongly would rank against the wrong text and a model that ignored the range would hide it.

Both make the same three decisions, and they are the language server's. **The ranking is expressed in the field the editor sorts on** (`boost` for CodeMirror, `sortText` for Monaco) because an editor re-sorts what it is handed and an ordering left implicit is an ordering thrown away, which is the only thing either adapter contributes. **Nothing claims an icon**: no `type`, and no `kind` unless you supply one, because this package is not type-aware and a confident wrong icon beside every suggestion is worse than none. **Neither lets the editor filter a cached list** (CodeMirror by omitting `validFor`, Monaco by setting `incomplete`) because the ranking is conditioned on the token before the cursor, so another keystroke can reorder the list and bring in candidates that were never in it. Asking again is affordable because each adapter holds a `BufferSession`, which re-lexes what was typed rather than the document.

## Exit codes

| | |
|---|---|
| `0` | ran, produced output |
| `1` | ran, nothing to suggest |
| `2` | could not run, or could not measure: a usage error, an unreadable file, a root that is not a readable directory, an index of zero files, too few files to hold any out, zero scored positions, or a scorer never observed producing both a hit and a miss |

The third exists because a clean result from an instrument that could not fail is worth nothing; `measure` and `opendocs` both refuse rather than printing a number they cannot support.

## License

MIT
