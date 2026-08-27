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

export const LANGUAGES = {
  javascript: { extensions: /\.(js|mjs|cjs|jsx|ts|tsx|mts|cts)$/, skip: [] },
  python: { extensions: /\.(py|pyi|pyw)$/, skip: [".eggs", "__pypackages__"] },
  go: { extensions: /\.go$/, skip: [] },
  rust: { extensions: /\.rs$/, skip: ["target"] },
  java: { extensions: /\.java$/, skip: ["target", ".gradle", "out"] },
  kotlin: { extensions: /\.(kt|kts)$/, skip: ["target", ".gradle", "out"] },
  ruby: { extensions: /\.(rb|rake)$/, skip: [".bundle"] },
  c: { extensions: /\.(c|h)$/, skip: [] },
  cpp: { extensions: /\.(cc|cpp|cxx|c\+\+|hh|hpp|hxx|h)$/, skip: [] },
  csharp: { extensions: /\.cs$/, skip: ["bin", "obj", "Library", "Temp"] },
  php: { extensions: /\.php$/, skip: [] },
  swift: { extensions: /\.swift$/, skip: [".build", "DerivedData"] },
  shell: { extensions: /\.(sh|bash|zsh)$/, skip: [] },
  sql: { extensions: /\.sql$/, skip: [] },
};

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

  const parts = [];
  const skipDirs = new Set(COMMON_SKIP_DIRS);
  for (const name of wanted) {
    const { extensions, skip } = LANGUAGES[name];
    // Strip the anchors off each preset so they can be joined into one alternation.
    parts.push(extensions.source.replace(/^\\\./, "").replace(/\$$/, ""));
    for (const d of skip) skipDirs.add(d);
  }
  return {
    extensions: new RegExp(`\\.(?:${parts.join("|")})$`),
    skipDirs,
    languages: wanted,
  };
}
