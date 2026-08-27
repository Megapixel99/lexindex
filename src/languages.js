/**
 * Which files to index, by language.
 *
 * The lexer is one regular expression over identifiers, numbers and single punctuation
 * characters, so it has never known or cared what language it is reading. The DEFAULTS
 * did: they matched the JavaScript family and nothing else, so a Python repository got
 * `indexed 0 files` and an error message telling it to check for `.js` files. The
 * mechanism was language-agnostic and the packaging was not.
 *
 * These presets are additive and the default is unchanged. `--lang` opts in; every
 * number this README reports was measured on JavaScript and TypeScript corpora and none
 * of them move because a preset exists.
 *
 * WHETHER IT WORKS ON YOUR LANGUAGE IS A QUESTION, NOT A CLAIM. The naturalness result
 * these presets lean on was established for Java and later replicated across several
 * languages, but nothing here has measured your repository, and the recital rate varies
 * more between repositories than it does between languages. The harness takes `--lang`
 * for exactly that reason: run it before believing any of this.
 *
 *   node tools/measure.mjs --lang python ./src
 *
 * `skip` holds directories that are build output or dependency trees for that language,
 * on the same reasoning `node_modules` is skipped for JavaScript: they repeat themselves
 * enormously, repetition is what this tool measures, and a corpus full of generated code
 * reports a recital rate that has nothing to do with the code anybody writes. They apply
 * only when that language is selected, because `target` and `bin` and `build` are all
 * real source directories in somebody's repository.
 */

/** Applied whatever the language: not your code, or not code at all. */
export const COMMON_SKIP_DIRS = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "vendor",
  ".cache",
  // `.claude` holds agent worktrees — whole extra copies of the repository, which is the
  // most contaminating thing a completion index can eat.
  ".claude",
  ".venv",
  "venv",
  "site-packages",
  ".tox",
  "__pycache__",
];

/**
 * Suffixes are the source of truth and the pattern is derived from them, because two
 * consumers want two different shapes: `collectFiles` wants a regular expression, and a
 * file watcher wants a glob. Writing both by hand is how they drift.
 */
const DEFINITIONS = {
  javascript: { suffixes: ["js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts"], skip: [] },
  python: { suffixes: ["py", "pyi", "pyw"], skip: [".eggs", "__pypackages__"] },
  go: { suffixes: ["go"], skip: [] },
  rust: { suffixes: ["rs"], skip: ["target"] },
  java: { suffixes: ["java"], skip: ["target", ".gradle", "out"] },
  kotlin: { suffixes: ["kt", "kts"], skip: ["target", ".gradle", "out"] },
  ruby: { suffixes: ["rb", "rake"], skip: [".bundle"] },
  c: { suffixes: ["c", "h"], skip: [] },
  cpp: { suffixes: ["cc", "cpp", "cxx", "c++", "hh", "hpp", "hxx", "h"], skip: [] },
  csharp: { suffixes: ["cs"], skip: ["bin", "obj", "Library", "Temp"] },
  php: { suffixes: ["php"], skip: [] },
  swift: { suffixes: ["swift"], skip: [".build", "DerivedData"] },
  shell: { suffixes: ["sh", "bash", "zsh"], skip: [] },
  sql: { suffixes: ["sql"], skip: [] },
};

/** A suffix list to the anchored pattern `collectFiles` matches filenames against. */
export function patternFor(suffixes) {
  const escaped = suffixes.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\.(?:${escaped.join("|")})$`);
}

export const LANGUAGES = {};
for (const [name, def] of Object.entries(DEFINITIONS)) {
  LANGUAGES[name] = { extensions: patternFor(def.suffixes), suffixes: def.suffixes, skip: def.skip };
}

/** Spellings a person is likely to type, mapped to the canonical name. */
const ALIASES = {
  js: "javascript",
  ts: "javascript",
  typescript: "javascript",
  node: "javascript",
  py: "python",
  rs: "rust",
  golang: "go",
  rb: "ruby",
  "c++": "cpp",
  cxx: "cpp",
  cs: "csharp",
  "c#": "csharp",
  dotnet: "csharp",
  kt: "kotlin",
  sh: "shell",
  bash: "shell",
};

export const LANGUAGE_NAMES = Object.keys(LANGUAGES);

/**
 * Turn `"python"`, `"py,go"` or `"all"` into build options.
 *
 * Several languages are one corpus, matching how `buildIndex` treats several directories:
 * a repository with a Python service and a Go worker is one repository, and splitting it
 * would report two underpowered answers instead of one.
 *
 * @param {string|string[]} spec
 * @returns {{extensions: RegExp, skipDirs: Set<string>, languages: string[]}}
 * @throws {Error} naming the unknown language and what is on offer
 */
export function resolveLanguages(spec) {
  const raw = Array.isArray(spec) ? spec : String(spec).split(",");
  const wanted = [];
  for (const piece of raw) {
    const name = piece.trim().toLowerCase();
    if (!name) continue;
    if (name === "all") {
      wanted.push(...LANGUAGE_NAMES);
      continue;
    }
    const canonical = ALIASES[name] || name;
    if (!LANGUAGES[canonical]) {
      throw new Error(
        `unknown language "${piece.trim()}". Known: ${LANGUAGE_NAMES.join(", ")}` +
          ` (or "all", or use --ext with your own pattern)`
      );
    }
    if (!wanted.includes(canonical)) wanted.push(canonical);
  }
  if (!wanted.length) throw new Error("--lang needs at least one language");

  const suffixes = [];
  const skipDirs = new Set(COMMON_SKIP_DIRS);
  for (const name of wanted) {
    const { suffixes: own, skip } = LANGUAGES[name];
    for (const x of own) if (!suffixes.includes(x)) suffixes.push(x);
    for (const d of skip) skipDirs.add(d);
  }
  return { extensions: patternFor(suffixes), suffixes, skipDirs, languages: wanted };
}
