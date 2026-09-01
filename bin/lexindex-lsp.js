#!/usr/bin/env node
/**
 * lexindex as a language server, so it can actually be used in an editor.
 *
 *     lexindex-lsp [<dir>...] [--lang <names>] [--beta <n>] [-k <n>]
 *
 * The README has always said where this belongs — "where no language server runs
 * (CodeMirror and Monaco embeddings, plain-JavaScript projects, cmp-buffer-style
 * setups)" — and then shipped one CLI, leaving every user to re-derive the wiring. This
 * is that wiring, once, over the protocol every editor already speaks.
 *
 * WHAT IT IS FOR, said plainly, because the README is blunt about this and this file
 * should not be less so: it is not type-aware, it does not know what is in scope, and at
 * a `foo.` position a real language server beats it outright. Run it where none runs, or
 * run it alongside one — most editors merge completions from several servers, and this
 * one contributes the frequency signal the others have no notion of.
 *
 * Zero dependencies here too: JSON-RPC over stdio is a Content-Length header and a JSON
 * body, and Node reads both without help.
 *
 * The whole of the incremental machinery earns its keep here. Every open document gets a
 * BufferSession, so a keystroke costs the keystroke rather than the file; every save runs
 * updateIndexFile, so the repository index tracks the tree instead of going stale the
 * moment anybody writes to disk.
 *
 * At the start of a line it also offers WHOLE LINES, retrieved from the index rather than
 * generated, each carrying the file and line it came from. That is the one place a server
 * with no idea what is in scope has something a type-aware one does not: it has read the
 * repository, and it can say "this is what followed here the last nine times". Only at a
 * line start, because that is the only position where "the next line" is the thing being
 * asked for -- see `atLineStart`. Turn it off with `--no-line`.
 */

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildIndex, updateIndexFile } from "../src/build.js";
import { Completer } from "../src/completer.js";
import { lex } from "../src/lex.js";
import { topWords } from "../src/identifiers.js";
import { recitalBand } from "../src/count-model.js";
import { resolveLanguages } from "../src/languages.js";
import { localIndexFor, atLineStart, DEFAULT_MIN_CONFIDENCE } from "../src/line-index.js";

// Read rather than repeated: a version written down twice is a version that disagrees
// with itself at the next release, and this one already would have.
const VERSION = createRequire(import.meta.url)("../package.json").version;

// ---- argv ------------------------------------------------------------------
const argv = process.argv.slice(2);
const cliDirs = [];
let langSpec = null;
let beta = 0.5;
let k = 8;
let lineMode = true;
let minConfidence = DEFAULT_MIN_CONFIDENCE;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--lang") langSpec = argv[++i];
  else if (a === "--beta") beta = Number(argv[++i]);
  else if (a === "-k") k = Number(argv[++i]);
  else if (a === "--no-line") lineMode = false;
  else if (a === "--min-confidence") minConfidence = Number(argv[++i]);
  else if (a === "-h" || a === "--help") {
    process.stdout.write(
      "usage: lexindex-lsp [<dir>...] [--lang <names>] [--beta <n>] [-k <n>]\n" +
        "                   [--no-line] [--min-confidence <n>]\n" +
        "A language server speaking completion only. Point your editor at it.\n" +
        "With no <dir>, it indexes the workspace root the editor reports.\n" +
        "At a line start it also offers whole lines from the index, with provenance;\n" +
        "--no-line turns that off and stops the line table being built at all.\n"
    );
    process.exit(0);
  } else cliDirs.push(a);
}
if (!Number.isFinite(beta) || beta < 0 || beta > 1) beta = 0.5;
if (!Number.isFinite(k) || k < 1) k = 8;
if (!Number.isFinite(minConfidence) || minConfidence < 0) minConfidence = DEFAULT_MIN_CONFIDENCE;

/**
 * How many whole lines to offer at once.
 *
 * The right line is the top one about 30% of the time it is offered and inside the top
 * three about 35%, so a short list is worth more than a single answer -- but the tail past
 * three is where the wrong ones live, and this list sits above the token suggestions.
 * Three.
 */
const LINE_ITEMS = 3;

// ---- state -----------------------------------------------------------------
/** uri -> { text, session } */
const docs = new Map();
let built = null;
let completer = null;
let roots = [];
let shuttingDown = false;
let clientCaps = {};
let indexable = null; // {extensions, skipDirs, suffixes} once the language is settled
let nextServerId = 1;

/** Everything the server says about itself goes to stderr; stdout is the protocol. */
const log = (msg) => process.stderr.write(`[lexindex-lsp] ${msg}\n`);

// ---- JSON-RPC over stdio ---------------------------------------------------
function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
/** The one request this server makes of the client: please watch these files. */
const requestOfClient = (method, params) => send({ jsonrpc: "2.0", id: nextServerId++, method, params });
const replyError = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  // A single read can carry part of a message, several messages, or both, so the loop
  // consumes only what is fully arrived and leaves the remainder for the next chunk.
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const m = /content-length:\s*(\d+)/i.exec(header);
    if (!m) {
      // Unparseable header: drop it rather than spinning on the same bytes forever.
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(m[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.subarray(start, start + length).toString("utf8");
    buffer = buffer.subarray(start + length);
    let message;
    try {
      message = JSON.parse(body);
    } catch (e) {
      log(`unparseable message body: ${e.message}`);
      continue;
    }
    try {
      handle(message);
    } catch (e) {
      log(`handler threw on ${message && message.method}: ${e.stack || e.message}`);
      if (message && message.id !== undefined) replyError(message.id, -32603, String(e.message || e));
    }
  }
});
process.stdin.on("end", () => process.exit(shuttingDown ? 0 : 1));

// ---- helpers ---------------------------------------------------------------
function uriToPath(uri) {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/**
 * An LSP position to a character offset.
 *
 * `character` counts UTF-16 code units, which is exactly how JavaScript indexes a string,
 * so no conversion is needed — but a position past the end of its line is legal to send
 * and has to be clamped rather than producing an offset into the next line.
 */
function offsetAt(text, position) {
  const lines = text.split("\n");
  const line = Math.min(Math.max(position.line, 0), lines.length - 1);
  let offset = 0;
  for (let i = 0; i < line; i++) offset += lines[i].length + 1;
  return offset + Math.min(Math.max(position.character, 0), lines[line].length);
}

function buildTheIndex() {
  const options = {};
  try {
    indexable = resolveLanguages(langSpec || "javascript");
    options.extensions = indexable.extensions;
    options.skipDirs = indexable.skipDirs;
  } catch (e) {
    log(e.message);
    indexable = resolveLanguages("javascript");
    options.extensions = indexable.extensions;
    options.skipDirs = indexable.skipDirs;
  }
  // retainFileTokens is what lets a save update one file instead of rebuilding the tree.
  options.retainFileTokens = true;
  // The line table is a second pass and a real cost, so `--no-line` must stop it being
  // built rather than merely stop it being consulted.
  options.lineIndex = lineMode;

  const dirs = cliDirs.length ? cliDirs : roots;
  if (!dirs.length) {
    log("no workspace root and no directory argument — nothing to index");
    return;
  }
  const started = Date.now();
  built = buildIndex(dirs, options);
  completer = new Completer(built.index, { cacheBeta: beta });
  for (const doc of docs.values()) doc.session = completer.session();

  log(
    `indexed ${built.files} files, ${built.tokens.toLocaleString()} tokens ` +
      `in ${Date.now() - started} ms from ${dirs.join(", ")}`
  );
  if (built.files === 0) {
    log(
      langSpec
        ? `no ${langSpec} files found — check --lang and the path`
        : "no .js/.ts files found — for another language pass --lang"
    );
  }
}

/**
 * Say what the recital rate is for a document as it is opened.
 *
 * The CLI prints this with every suggestion and the harness leads with it, because it is
 * the honest predictor of whether any of these suggestions are worth having. A server
 * that quietly served weak completions without ever saying so would be the one place in
 * this project where the number is hidden. It goes to stderr, which is where editors
 * collect server logs, and it is computed once per open rather than per keystroke.
 */
function reportRecital(uri, text) {
  if (!built || built.files === 0) return;
  const tokens = lex(text);
  if (tokens.length < 8) return;
  const rate = built.index.recitalRate(tokens);
  log(`${path.basename(uriToPath(uri) || uri)}: recital ${(rate * 100).toFixed(1)}% — ${recitalBand(rate)}`);
}

// ---- handlers --------------------------------------------------------------
function handle(msg) {
  const { id, method, params } = msg;
  if (method === undefined) return; // a response to something we sent; we send no requests

  switch (method) {
    case "initialize": {
      clientCaps = (params && params.capabilities) || {};
      roots = [];
      if (params && Array.isArray(params.workspaceFolders)) {
        for (const f of params.workspaceFolders) {
          const p = uriToPath(f.uri);
          if (p) roots.push(p);
        }
      }
      if (!roots.length && params && params.rootUri) {
        const p = uriToPath(params.rootUri);
        if (p) roots.push(p);
      }
      if (!roots.length && params && params.rootPath) roots.push(params.rootPath);

      const opts = (params && params.initializationOptions) || {};
      if (opts.lang) langSpec = String(opts.lang);
      if (opts.beta !== undefined && Number.isFinite(Number(opts.beta))) {
        const b = Number(opts.beta);
        if (b >= 0 && b <= 1) beta = b;
      }
      if (opts.k !== undefined && Number.isFinite(Number(opts.k)) && Number(opts.k) >= 1) {
        k = Math.floor(Number(opts.k));
      }
      if (Array.isArray(opts.dirs)) for (const d of opts.dirs) cliDirs.push(String(d));
      if (opts.line === false) lineMode = false;
      if (opts.minConfidence !== undefined && Number.isFinite(Number(opts.minConfidence))) {
        const c = Number(opts.minConfidence);
        if (c >= 0) minConfidence = c;
      }

      reply(id, {
        capabilities: {
          // Full sync: this server needs the whole buffer anyway, and incremental sync
          // would be bookkeeping for a saving the BufferSession already makes.
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
          completionProvider: { resolveProvider: false },
        },
        serverInfo: { name: "lexindex", version: VERSION },
      });
      return;
    }

    case "initialized":
      // Build after the handshake rather than during it, so a large tree delays
      // completions rather than the editor's startup.
      buildTheIndex();
      watchTheTree();
      return;

    case "shutdown":
      shuttingDown = true;
      reply(id, null);
      return;

    case "exit":
      process.exit(shuttingDown ? 0 : 1);
      return;

    case "textDocument/didOpen": {
      const { uri, text } = params.textDocument;
      docs.set(uri, { text, session: completer ? completer.session() : null });
      reportRecital(uri, text);
      return;
    }

    case "textDocument/didChange": {
      const doc = docs.get(params.textDocument.uri);
      if (!doc) return;
      // Full sync, so the last change carries the whole document.
      const last = params.contentChanges[params.contentChanges.length - 1];
      if (last && typeof last.text === "string") doc.text = last.text;
      return;
    }

    case "textDocument/didSave": {
      // The tree changed, so the index should too — one file, not the repository.
      const file = uriToPath(params.textDocument.uri);
      const doc = docs.get(params.textDocument.uri);
      if (!file || !built || !built.tokensByFile) return;
      try {
        const result = updateIndexFile(built, file, doc ? doc.text : undefined);
        if (result.action !== "unchanged") {
          log(`${result.action} ${path.basename(file)} in ${result.ms} ms`);
        }
      } catch (e) {
        log(`could not update ${file}: ${e.message}`);
      }
      return;
    }

    case "workspace/didChangeWatchedFiles": {
      // A save is not the only way a tree changes. A branch switch, a rebase, a codegen
      // step or a second editor all rewrite files this server never saw opened, and
      // without this the index quietly describes the tree as it was at startup.
      applyWatchedChanges((params && params.changes) || []);
      return;
    }

    case "textDocument/didClose":
      docs.delete(params.textDocument.uri);
      return;

    case "textDocument/completion": {
      if (!completer) {
        reply(id, { isIncomplete: false, items: [] });
        return;
      }
      const doc = docs.get(params.textDocument.uri);
      if (!doc) {
        reply(id, { isIncomplete: false, items: [] });
        return;
      }
      if (!doc.session) doc.session = completer.session();

      const offset = offsetAt(doc.text, params.position);
      const before = doc.text.slice(0, offset);

      const items = [];

      // Whole lines first, and only at a line start. `sortText` is grouped "0" for lines
      // and "1" for tokens so the group order survives the editor's own sort: at a line
      // start a retrieved line is the specific thing this server knows that a type-aware
      // one does not, and mid-identifier it is not offered at all.
      for (const line of lineSuggestions(before)) items.push(line);

      // Identifier-shaped suggestions only -- see identifiers.js for why, and for the
      // overshoot this used to spell out here. Keeping the rule in one place is the
      // point of that module: it was extracted FROM this handler, and a second copy
      // here is how the two quietly stop agreeing.
      let nth = 0;
      for (const entry of topWords(doc.session, before, k)) {
        items.push({
          label: entry.token,
          kind: 1, // Text: this server genuinely does not know what the token is
          // sortText preserves our order; without it the editor re-sorts alphabetically
          // and throws away the only thing this server contributes.
          sortText: `1${String(nth++).padStart(4, "0")}`,
          filterText: entry.token,
          detail: "lexindex",
        });
      }
      reply(id, { isIncomplete: true, items });
      return;
    }

    default:
      // Notifications are ignored; requests must be answered or the editor waits forever.
      if (id !== undefined) replyError(id, -32601, `unhandled method: ${method}`);
  }
}

/**
 * Whole-line completion items for a cursor, or none.
 *
 * Three conditions, each of which is a way of declining to guess:
 *
 * - only at the start of a line, because the table answers "what line followed this
 *   context" and mid-identifier that is not the question being asked;
 * - only when the index actually holds this context, which on a held-out public corpus was
 *   about a third of line positions, and it never invents the other two thirds;
 * - only when the best candidate holds `minConfidence` of the score. A list the editor
 *   pops up unbidden is worse than no list, and this gate is the one the published
 *   numbers were measured through -- the right line is the top item about 30% of the time
 *   it clears this bar, and inside the top three about 35%.
 *
 * The buffer above the cursor is indexed alongside the repository. It is the one corpus
 * the server never has on disk, and on the measured splits it was worth 4.3 and 4.0
 * points of accuracy -- code repeats locally far more than it repeats globally.
 */
function lineSuggestions(before) {
  if (!lineMode || !built || !built.lines || !atLineStart(before)) return [];
  const ranked = built.lines.candidates(before, { local: localIndexFor(before) });
  if (ranked.length === 0 || ranked[0].confidence < minConfidence) return [];
  return ranked.slice(0, LINE_ITEMS).map((c, i) => ({
    label: c.text,
    kind: 1, // Text, for the same reason the tokens are: this is retrieval, not analysis
    insertText: c.text,
    sortText: `0${String(i).padStart(4, "0")}`,
    filterText: c.text,
    detail: `lexindex line \u00b7 ${(c.confidence * 100).toFixed(0)}%`,
    // Provenance is what makes a suggestion checkable rather than merely convincing, and
    // an editor shows this panel beside the list, so it costs the reader nothing.
    documentation: `${relativeToRoot(c.file)}:${c.line} \u2014 seen ${c.count} time(s)`,
  }));
}

/** Provenance a human can place, rather than an absolute path down the whole machine. */
function relativeToRoot(file) {
  if (file === "<buffer>") return "this buffer, above the cursor";
  for (const root of cliDirs.length ? cliDirs : roots) {
    const rel = path.relative(root, file);
    if (rel && !rel.startsWith("..")) return rel;
  }
  return file;
}

/**
 * Ask the client to watch the files this index is built from.
 *
 * The client does the watching because it already is: editors watch the workspace for
 * their own reasons, and a second recursive watcher from every language server is how a
 * machine runs out of file handles. This needs `dynamicRegistration`, and a client
 * without it simply keeps the save-time updates.
 */
function watchTheTree() {
  const supported =
    clientCaps.workspace &&
    clientCaps.workspace.didChangeWatchedFiles &&
    clientCaps.workspace.didChangeWatchedFiles.dynamicRegistration;
  if (!supported || !indexable) {
    if (!supported) log("client does not watch files; the index will follow saves only");
    return;
  }
  requestOfClient("client/registerCapability", {
    registrations: [
      {
        id: "lexindex-watch",
        method: "workspace/didChangeWatchedFiles",
        registerOptions: {
          watchers: [{ globPattern: `**/*.{${indexable.suffixes.join(",")}}` }],
        },
      },
    ],
  });
}

/** Is this path one the index would have collected in the first place? */
function isIndexable(file) {
  if (!indexable || !indexable.extensions.test(file)) return false;
  // The glob filters by suffix but knows nothing about node_modules, and an editor will
  // happily report every dependency file a package install just wrote.
  for (const part of file.split(path.sep)) {
    if (indexable.skipDirs.has(part)) return false;
  }
  return true;
}

/**
 * Apply a batch of file-system changes, by whichever route is actually cheaper.
 *
 * One changed file costs about 4 ms to fold in; rebuilding costs whatever this corpus
 * measured at startup, which is recorded rather than guessed. A branch switch touching
 * hundreds of files is faster to rebuild than to fold in one at a time, and doing it the
 * slow way would stall completions for seconds.
 */
const MS_PER_FILE_UPDATE = 4;
function applyWatchedChanges(changes) {
  if (!built || !built.tokensByFile) return;
  const relevant = [];
  for (const change of changes) {
    const file = uriToPath(change.uri);
    if (file && isIndexable(file)) relevant.push(file);
  }
  if (!relevant.length) return;

  if (relevant.length * MS_PER_FILE_UPDATE > built.ms) {
    const started = Date.now();
    buildTheIndex();
    log(`${relevant.length} files changed — rebuilt in ${Date.now() - started} ms, which was the cheaper route`);
    return;
  }

  const started = Date.now();
  const counts = { added: 0, updated: 0, removed: 0, unchanged: 0 };
  for (const file of relevant) {
    try {
      // The change's `type` is deliberately not read. Every file is reconciled against
      // the disk instead, because the disk is what the index is supposed to describe and
      // the event is only a hint that it moved. A file that is gone fails to read and
      // `updateIndexFile` already treats that as a deletion; a Deleted event for a file
      // that is still there — a delete and recreate arriving late, which editors do
      // batch — leaves it indexed, which is the right answer and the one trusting the
      // event would get wrong.
      const result = updateIndexFile(built, file);
      counts[result.action]++;
    } catch (e) {
      log(`could not update ${file}: ${e.message}`);
    }
  }
  log(
    `watched changes: ${counts.added} added, ${counts.updated} updated, ` +
      `${counts.removed} removed in ${Date.now() - started} ms`
  );
}

// A malformed message from an editor must not take the server down mid-session; it is
// logged and the next message is handled.
process.on("uncaughtException", (e) => {
  log(`uncaught: ${e.stack || e.message}`);
});
