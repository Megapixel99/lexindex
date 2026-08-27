/**
 * The language server, driven the way an editor drives it: framed JSON-RPC over stdio.
 *
 * These need no sleeps. The server handles messages in the order they arrive on one
 * thread, so a reply to a request sent after `initialized` proves the index finished
 * building — waiting on a timer instead would be both slower and flakier.
 *
 * The failure that matters most here is not a wrong completion, it is a request that is
 * never answered: an editor with an outstanding request sits there with a spinner. So
 * every request in this file is awaited, including the ones the server is meant to
 * refuse.
 */
import { test, describe, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const LSP = path.join(here, "..", "bin", "lexindex-lsp.js");

/**
 * Every client started by a test, so a FAILING test cannot leave a server running.
 * An assertion throws before any cleanup written after it, and a leaked child process
 * keeps the test runner alive — which turns one failed assertion into a hung suite.
 */
const live = [];
afterEach(() => {
  for (const c of live) c.kill();
  live.length = 0;
});

/** How long to wait for a reply before calling it a hang. */
const REPLY_TIMEOUT_MS = 10000;

/** A minimal LSP client: enough to be an editor, and nothing more. */
function client(args = []) {
  const proc = spawn(process.execPath, [LSP, ...args], { stdio: ["pipe", "pipe", "pipe"] });
  const waiters = new Map();
  const stderr = [];
  let buf = Buffer.alloc(0);
  let nextId = 1;

  proc.stderr.on("data", (d) => stderr.push(String(d)));
  proc.stdout.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const he = buf.indexOf("\r\n\r\n");
      if (he === -1) return;
      const m = /content-length:\s*(\d+)/i.exec(buf.subarray(0, he).toString("ascii"));
      if (!m) return;
      const len = Number(m[1]);
      if (buf.length < he + 4 + len) return;
      const msg = JSON.parse(buf.subarray(he + 4, he + 4 + len).toString("utf8"));
      buf = buf.subarray(he + 4 + len);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });

  const write = (msg) => {
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }), "utf8");
    proc.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    proc.stdin.write(body);
  };

  const api = {
    proc,
    stderr,
    notify: (method, params) => write({ method, params }),
    /**
     * Send a request and wait for its reply — but never forever. A request an editor
     * never gets an answer to shows up as a spinner that never stops, so here it has to
     * show up as a failing test rather than a suite that hangs.
     */
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          resolve({ __timeout: true, method });
        }, REPLY_TIMEOUT_MS);
        waiters.set(id, (msg) => {
          clearTimeout(timer);
          resolve(msg);
        });
        write({ id, method, params });
      });
    },
    raw: (bytes) => proc.stdin.write(bytes),
    exited: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve(proc.exitCode);
        const timer = setTimeout(() => resolve("timeout"), REPLY_TIMEOUT_MS);
        proc.on("exit", (code) => {
          clearTimeout(timer);
          resolve(code);
        });
      }),
    kill: () => {
      try {
        proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
  live.push(api);
  return api;
}

/** Assert a reply arrived at all, then hand it back. */
function answered(r, what) {
  assert.ok(!r.__timeout, `${what}: no reply within ${REPLY_TIMEOUT_MS} ms — an editor would spin forever`);
  return r;
}

let dir;
let uri;
const SOURCE = 'import { renderWidget } from "./widget.js";\nconst widgetCount = 2;\nrenderWidget(widgetCount);\n';

before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-lsp-"));
  fs.writeFileSync(path.join(dir, "widget.js"), "export function renderWidget(w) { return w.name; }\nrenderWidget(null);\n");
  fs.writeFileSync(path.join(dir, "other.js"), "export const widgetCount = 1;\nexport function loadConfig() { return {}; }\n");
  uri = pathToFileURL(path.join(dir, "open.js")).href;
});
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** initialize + initialized + didOpen, which is every editor's opening move. */
async function started(args = [], initializationOptions = undefined, text = SOURCE) {
  const c = client(args);
  const init = await c.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(dir).href,
    capabilities: {},
    initializationOptions,
  });
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "javascript", version: 1, text },
  });
  return { c, init };
}

describe("the language server", () => {
  test("it announces the capabilities an editor needs to drive it", async () => {
    const { c, init } = await started();
    answered(init, "initialize");
    const caps = init.result.capabilities;
    assert.ok(caps.completionProvider, "no completionProvider means no completions");
    assert.equal(caps.textDocumentSync.change, 1, "full sync is what didChange assumes");
    assert.ok(caps.textDocumentSync.openClose);
    assert.equal(init.result.serverInfo.name, "lexindex");
  });

  test("it completes from the repository index", async () => {
    const { c } = await started();
    // line 2 is `renderWidget(widgetCount);` — stop after `render`
    const r = await c.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 6 },
    });
    const labels = r.result.items.map((i) => i.label);
    assert.ok(labels.includes("renderWidget"), `got ${JSON.stringify(labels)}`);
  });

  test("sortText preserves our order, which is the only thing this server contributes", async () => {
    const { c } = await started();
    const r = await c.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: 6 },
    });
    const sorts = r.result.items.map((i) => i.sortText);
    assert.deepEqual(sorts, [...sorts].sort(), "sortText must be ascending in our order");
    assert.deepEqual(sorts, sorts.map((_, n) => String(n).padStart(4, "0")));
  });

  test("it offers identifiers, not punctuation", async () => {
    const { c } = await started();
    // A position right after `(`, where the raw ranking is largely punctuation.
    const r = await c.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 13 },
    });
    assert.ok(r.result.items.length > 0, "expected some candidates here");
    for (const item of r.result.items) {
      assert.match(item.label, /^[A-Za-z_]\w*$/, `a completion popup should not offer ${JSON.stringify(item.label)}`);
    }
  });

  test("typing is reflected without reopening the document", async () => {
    const { c } = await started();
    const typed = SOURCE + "const renderW";
    c.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: typed }],
    });
    const r = await c.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 3, character: 13 },
    });
    const labels = r.result.items.map((i) => i.label);
    assert.ok(labels.includes("renderWidget"), `got ${JSON.stringify(labels)}`);
    assert.ok(labels.every((l) => l.startsWith("renderW")), "the partial word must filter the list");
  });

  test("saving a file updates the index rather than leaving it stale", async () => {
    const { c } = await started();
    const fresh = path.join(dir, "fresh.js");
    const freshUri = pathToFileURL(fresh).href;
    try {
      const before = await c.request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 1, character: 6 },
      });
      assert.ok(!before.result.items.some((i) => i.label === "brandNewSymbol"));

      fs.writeFileSync(fresh, "export const brandNewSymbol = 1;\nbrandNewSymbol;\n");
      c.notify("textDocument/didOpen", {
        textDocument: { uri: freshUri, languageId: "javascript", version: 1, text: fs.readFileSync(fresh, "utf8") },
      });
      c.notify("textDocument/didSave", { textDocument: { uri: freshUri } });

      const after = await c.request("textDocument/completion", {
        textDocument: { uri },
        position: { line: 1, character: 6 },
      });
      assert.ok(
        after.result.items.some((i) => i.label === "brandNewSymbol"),
        `a saved file must reach the index; got ${JSON.stringify(after.result.items.map((i) => i.label))}`
      );
    } finally {
      fs.rmSync(fresh, { force: true });
    }
  });

  // An unanswered request leaves an editor spinning, so these assert a reply, not a value.
  test("a position past the end of a line or file is clamped, not fatal", async () => {
    const { c } = await started();
    for (const position of [
      { line: 1, character: 9999 },
      { line: 9999, character: 0 },
      { line: -1, character: -1 },
    ]) {
      const r = await c.request("textDocument/completion", { textDocument: { uri }, position });
      answered(r, `completion at ${JSON.stringify(position)}`);
      assert.ok(r.result, `no reply for ${JSON.stringify(position)}`);
      assert.ok(Array.isArray(r.result.items));
    }
  });

  test("a method it does not implement is refused, not ignored", async () => {
    const { c } = await started();
    const r = await c.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 0 },
    });
    answered(r, "textDocument/hover");
    assert.ok(r.error, "an unanswered request hangs the editor");
    assert.equal(r.error.code, -32601);
  });

  test("completion in a document it never saw is empty, not a crash", async () => {
    const { c } = await started();
    const r = await c.request("textDocument/completion", {
      textDocument: { uri: pathToFileURL(path.join(dir, "never-opened.js")).href },
      position: { line: 0, character: 0 },
    });
    assert.deepEqual(r.result.items, []);
  });

  test("a closed document stops being served", async () => {
    const { c } = await started();
    c.notify("textDocument/didClose", { textDocument: { uri } });
    const r = await c.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: 6 },
    });
    assert.deepEqual(r.result.items, []);
  });

  test("garbage on the wire does not take the session down", async () => {
    const { c } = await started();
    c.raw("Content-Length: 9\r\n\r\n{not json}");
    c.raw("no header at all\r\n\r\n");
    const r = await c.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 2, character: 6 },
    });
    answered(r, "completion after garbage");
    assert.ok(r.result, "the server stopped answering after malformed input");
    assert.ok(r.result.items.map((i) => i.label).includes("renderWidget"));
  });

  test("initializationOptions carry k and the language", async () => {
    const { c } = await started([], { k: 2 });
    const r = await c.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 1, character: 6 },
    });
    assert.ok(r.result.items.length <= 2, `k was ignored: ${r.result.items.length} items`);
  });

  test("shutdown then exit is a clean exit; exit without shutdown is not", async () => {
    const a = await started();
    const sd = await a.c.request("shutdown", null);
    assert.equal(sd.result, null);
    a.c.notify("exit", null);
    assert.equal(await a.c.exited(), 0);

    const b = await started();
    b.c.notify("exit", null);
    assert.equal(await b.c.exited(), 1, "the protocol says exit without shutdown is an error");
  });

  test("it reports the recital rate for a document it opens", async () => {
    const { c } = await started();
    await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 6 } });
    const log = c.stderr.join("");
    assert.match(log, /recital \d+\.\d%/, "the honest predictor must not be the one thing hidden here");
  });

  test("an empty workspace says so instead of failing silently", async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "lexindex-lsp-empty-"));
    try {
      const c = client([]);
      await c.request("initialize", { rootUri: pathToFileURL(empty).href, capabilities: {} });
      c.notify("initialized", {});
      const r = await c.request("textDocument/completion", {
        textDocument: { uri: pathToFileURL(path.join(empty, "a.js")).href },
        position: { line: 0, character: 0 },
      });
      assert.deepEqual(r.result.items, []);
      assert.match(c.stderr.join(""), /no \.js\/\.ts files found|--lang/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
