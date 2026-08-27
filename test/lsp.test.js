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

  const serverRequests = [];
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
      if (msg.method !== undefined && msg.id !== undefined) {
        // A request FROM the server. Record it and answer, because a server waiting on a
        // reply it never gets is the same hang in the other direction.
        serverRequests.push(msg);
        write({ id: msg.id, result: null });
        continue;
      }
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
    serverRequests,
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
const WATCHING_CLIENT = { workspace: { didChangeWatchedFiles: { dynamicRegistration: true } } };

async function started(args = [], initializationOptions = undefined, text = SOURCE, capabilities = {}) {
  const c = client(args);
  const init = await c.request("initialize", {
    processId: process.pid,
    rootUri: pathToFileURL(dir).href,
    capabilities,
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

  // A save is not the only way a tree changes: a branch switch, a rebase or a codegen
  // step rewrite files the editor never had open.
  describe("watching the tree, not just the open buffer", () => {
    test("it registers a watcher when the client says it can watch", async () => {
      const { c } = await started([], undefined, SOURCE, WATCHING_CLIENT);
      await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 6 } });

      const reg = c.serverRequests.find((r) => r.method === "client/registerCapability");
      assert.ok(reg, "no watcher was registered");
      const watcher = reg.params.registrations[0];
      assert.equal(watcher.method, "workspace/didChangeWatchedFiles");
      const glob = watcher.registerOptions.watchers[0].globPattern;
      assert.match(glob, /\bjs\b/, `the glob must cover the indexed suffixes: ${glob}`);
      assert.match(glob, /\bts\b/);
    });

    test("it asks for nothing from a client that cannot watch, and says so", async () => {
      const { c } = await started();
      await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 6 } });
      assert.ok(
        !c.serverRequests.some((r) => r.method === "client/registerCapability"),
        "registering with a client that declared no support would hang or error"
      );
      assert.match(c.stderr.join(""), /follow saves only/);
    });

    test("a file changed outside the editor reaches the index", async () => {
      const { c } = await started([], undefined, SOURCE, WATCHING_CLIENT);
      const outside = path.join(dir, "outside.js");
      try {
        fs.writeFileSync(outside, "export const writtenByGitCheckout = 1;\nwrittenByGitCheckout;\n");
        c.notify("workspace/didChangeWatchedFiles", {
          changes: [{ uri: pathToFileURL(outside).href, type: 1 }],
        });
        const r = await c.request("textDocument/completion", {
          textDocument: { uri },
          position: { line: 1, character: 6 },
        });
        assert.ok(
          r.result.items.some((i) => i.label === "writtenByGitCheckout"),
          `got ${JSON.stringify(r.result.items.map((i) => i.label))}`
        );
      } finally {
        fs.rmSync(outside, { force: true });
      }
    });

    test("a deleted file stops being suggested", async () => {
      const { c } = await started([], undefined, SOURCE, WATCHING_CLIENT);
      const doomed = path.join(dir, "doomed.js");
      fs.writeFileSync(doomed, "export const soonToVanish = 1;\nsoonToVanish;\n");
      c.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(doomed).href, type: 1 }] });
      const before = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 6 } });
      assert.ok(before.result.items.some((i) => i.label === "soonToVanish"));

      fs.rmSync(doomed, { force: true });
      c.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(doomed).href, type: 3 }] });
      const after = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 6 } });
      assert.ok(
        !after.result.items.some((i) => i.label === "soonToVanish"),
        "a deleted file must leave the index, or it goes on describing a tree that is gone"
      );
    });

    // The event says what the editor thinks happened; the disk says what did. When they
    // disagree the disk wins, because the disk is what the index claims to describe.
    test("a delete event for a file that still exists does not evict it", async () => {
      const { c } = await started([], undefined, SOURCE, WATCHING_CLIENT);
      const survivor = path.join(dir, "survivor.js");
      try {
        fs.writeFileSync(survivor, "export const stillOnDisk = 1;\nstillOnDisk;\n");
        c.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(survivor).href, type: 1 }] });
        // A stale Deleted event for a file that is very much still there.
        c.notify("workspace/didChangeWatchedFiles", { changes: [{ uri: pathToFileURL(survivor).href, type: 3 }] });

        const r = await c.request("textDocument/completion", {
          textDocument: { uri },
          position: { line: 1, character: 6 },
        });
        assert.ok(
          r.result.items.some((i) => i.label === "stillOnDisk"),
          "the file is on disk, so it belongs in the index whatever the event claimed"
        );
      } finally {
        fs.rmSync(survivor, { force: true });
      }
    });

    test("changes it would never have indexed are ignored", async () => {
      const { c } = await started([], undefined, SOURCE, WATCHING_CLIENT);
      const nested = path.join(dir, "node_modules", "dep");
      fs.mkdirSync(nested, { recursive: true });
      const depFile = path.join(nested, "index.js");
      try {
        fs.writeFileSync(depFile, "export const somebodyElsesIdiom = 1;\nsomebodyElsesIdiom;\n");
        c.notify("workspace/didChangeWatchedFiles", {
          changes: [
            { uri: pathToFileURL(depFile).href, type: 1 },
            { uri: pathToFileURL(path.join(dir, "notes.md")).href, type: 1 },
          ],
        });
        const r = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 6 } });
        assert.ok(
          !r.result.items.some((i) => i.label === "somebodyElsesIdiom"),
          "node_modules is excluded on purpose; a watcher must not smuggle it back in"
        );
      } finally {
        fs.rmSync(path.join(dir, "node_modules"), { recursive: true, force: true });
      }
    });

    test("a large batch is rebuilt rather than folded in one file at a time", async () => {
      const { c } = await started([], undefined, SOURCE, WATCHING_CLIENT);
      const made = [];
      try {
        // Enough files that per-file updates would cost more than the build did.
        for (let i = 0; i < 400; i++) {
          const f = path.join(dir, `bulk${i}.js`);
          fs.writeFileSync(f, `export const bulkSymbol${i} = ${i};\n`);
          made.push(f);
        }
        c.notify("workspace/didChangeWatchedFiles", {
          changes: made.map((f) => ({ uri: pathToFileURL(f).href, type: 1 })),
        });
        const r = await c.request("textDocument/completion", { textDocument: { uri }, position: { line: 1, character: 6 } });
        assert.ok(r.result, "the server must still answer after a bulk change");
        assert.match(c.stderr.join(""), /the cheaper route/, "a large batch should have taken the rebuild path");
      } finally {
        for (const f of made) fs.rmSync(f, { force: true });
      }
    });

    test("a watched change before the index exists is not a crash", async () => {
      const c = client([]);
      c.notify("workspace/didChangeWatchedFiles", {
        changes: [{ uri: pathToFileURL(path.join(dir, "widget.js")).href, type: 2 }],
      });
      const init = await c.request("initialize", { rootUri: pathToFileURL(dir).href, capabilities: WATCHING_CLIENT });
      answered(init, "initialize after an early notification");
    });
  });
});
