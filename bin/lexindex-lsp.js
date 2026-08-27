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
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, updateIndexFile } from "../src/build.js";
import { Completer } from "../src/completer.js";
import { isWord, lex } from "../src/lex.js";
import { recitalBand } from "../src/count-model.js";
import { resolveLanguages } from "../src/languages.js";

// ---- argv ------------------------------------------------------------------
const argv = process.argv.slice(2);
const cliDirs = [];
let langSpec = null;
let beta = 0.5;
let k = 8;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--lang") langSpec = argv[++i];
  else if (a === "--beta") beta = Number(argv[++i]);
  else if (a === "-k") k = Number(argv[++i]);
  else if (a === "-h" || a === "--help") {
    process.stdout.write(
      "usage: lexindex-lsp [<dir>...] [--lang <names>] [--beta <n>] [-k <n>]\n" +
        "A language server speaking completion only. Point your editor at it.\n" +
        "With no <dir>, it indexes the workspace root the editor reports.\n"
    );
    process.exit(0);
  } else cliDirs.push(a);
}
if (!Number.isFinite(beta) || beta < 0 || beta > 1) beta = 0.5;
if (!Number.isFinite(k) || k < 1) k = 8;

// ---- state -----------------------------------------------------------------
/** uri -> { text, session } */
const docs = new Map();
let built = null;
let completer = null;
let roots = [];
let shuttingDown = false;

/** Everything the server says about itself goes to stderr; stdout is the protocol. */
const log = (msg) => process.stderr.write(`[lexindex-lsp] ${msg}\n`);

// ---- JSON-RPC over stdio ---------------------------------------------------
function send(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
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
  if (langSpec) {
    try {
      const resolved = resolveLanguages(langSpec);
      options.extensions = resolved.extensions;
      options.skipDirs = resolved.skipDirs;
    } catch (e) {
      log(e.message);
    }
  }
  // retainFileTokens is what lets a save update one file instead of rebuilding the tree.
  options.retainFileTokens = true;

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

      reply(id, {
        capabilities: {
          // Full sync: this server needs the whole buffer anyway, and incremental sync
          // would be bookkeeping for a saving the BufferSession already makes.
          textDocumentSync: { openClose: true, change: 1, save: { includeText: false } },
          completionProvider: { resolveProvider: false },
        },
        serverInfo: { name: "lexindex", version: "0.1.1" },
      });
      return;
    }

    case "initialized":
      // Build after the handshake rather than during it, so a large tree delays
      // completions rather than the editor's startup.
      buildTheIndex();
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

      // Ask for more than we need and keep the identifier-shaped ones. The measurements
      // score punctuation because a fair benchmark must, but a completion popup offering
      // `;` is noise, and aggregate top-1 is mostly punctuation for every engine.
      const scored = doc.session.completeScored(before, { k: k * 4 });
      const items = [];
      for (const entry of scored) {
        if (!isWord(entry.token)) continue;
        items.push({
          label: entry.token,
          kind: 1, // Text: this server genuinely does not know what the token is
          // sortText preserves our order; without it the editor re-sorts alphabetically
          // and throws away the only thing this server contributes.
          sortText: String(items.length).padStart(4, "0"),
          filterText: entry.token,
          detail: "lexindex",
        });
        if (items.length >= k) break;
      }
      reply(id, { isIncomplete: true, items });
      return;
    }

    default:
      // Notifications are ignored; requests must be answered or the editor waits forever.
      if (id !== undefined) replyError(id, -32601, `unhandled method: ${method}`);
  }
}

// A malformed message from an editor must not take the server down mid-session; it is
// logged and the next message is handled.
process.on("uncaughtException", (e) => {
  log(`uncaught: ${e.stack || e.message}`);
});
